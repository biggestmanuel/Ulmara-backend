import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Regression: every EVM adapter must be built with the chain id from
// getEvmChainId.
//
// bscAdapter / baseAdapter / polygonAdapter were constructed WITHOUT the third
// argument, so createEvmAdapter fell back to CHAIN_CONFIG's hardcoded mainnet
// ids (56 / 8453 / 137). On any testnet configuration ethers detected the real
// id and refused the read:
//
//     network changed: 56   => 97      (BSC)
//     network changed: 8453 => 84532   (BASE)
//     network changed: 137  => 80002   (POLYGON)
//
// which surfaced to callers as a null balance and to the user as an empty
// wallet. ETH passed the id and worked, so the three broken chains looked like
// an RPC problem rather than a construction bug.
//
// These tests call the REAL adapter modules against a local JSON-RPC stub that
// reports a TESTNET chain id, so the failure mode is reproduced rather than
// described.
// ---------------------------------------------------------------------------

/** Per chain: the testnet id it should honour, and the mainnet id it must also still support. */
const NETWORKS = {
  bsc: { testnet: 97, mainnet: 56 },
  base: { testnet: 84532, mainnet: 8453 },
  polygon: { testnet: 80002, mainnet: 137 },
} as const;

let server: Server;
let stubUrl: string;
/** Which chainId the stub claims, per test. */
let claimedChainId = 97;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (payload: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      let parsed: { id?: unknown; method?: string } | { id?: unknown; method?: string }[];
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
      // ethers matches responses by request id, so it MUST be echoed back.
      const answer = (method: string, id: unknown) => {
        // What a node reports for the chain id decides whether ethers accepts
        // the provider or throws "network changed".
        if (method === "eth_chainId") return { jsonrpc: "2.0", id, result: "0x" + claimedChainId.toString(16) };
        if (method === "net_version") return { jsonrpc: "2.0", id, result: String(claimedChainId) };
        if (method === "eth_getBalance") return { jsonrpc: "2.0", id, result: "0x0de0b6b3a7640000" }; // 1e18
        if (method === "eth_blockNumber") return { jsonrpc: "2.0", id, result: "0x1" };
        if (method === "eth_getBlockByNumber") return { jsonrpc: "2.0", id, result: null };
        return { jsonrpc: "2.0", id, result: null };
      };
      if (Array.isArray(parsed)) return send(parsed.map((p) => answer(p.method ?? "", p.id)));
      return send(answer(parsed.method ?? "", parsed.id ?? null));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  stubUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const { envState } = vi.hoisted(() => ({
  envState: {
    env: {
      ETHEREUM_CHAIN_ID: 11155111,
      BSC_CHAIN_ID: 97,
      BASE_CHAIN_ID: 84532,
      POLYGON_CHAIN_ID: 80002,
      ETHEREUM_RPC_URL: undefined as string | undefined,
      BSC_RPC_URL: undefined as string | undefined,
      BASE_RPC_URL: undefined as string | undefined,
      POLYGON_RPC_URL: undefined as string | undefined,
      ERC20_TOKEN_CONFIG: undefined as string | undefined,
      LOG_LEVEL: "silent",
    },
  },
}));

// This file lives in src/chains/evm/, so config/ is two levels up.
vi.mock("../../config/env.js", () => ({ env: envState.env }));

const ADDRESS = "0x1111111111111111111111111111111111111111";

/** Loads a real adapter module with the stub RPC wired in. */
async function loadAdapter(chain: "bsc" | "base" | "polygon", chainId: number) {
  const key = chain.toUpperCase();
  (envState.env as Record<string, unknown>)[`${key}_RPC_URL`] = stubUrl;
  (envState.env as Record<string, unknown>)[`${key}_CHAIN_ID`] = chainId;
  claimedChainId = chainId;
  vi.resetModules();
  // Literal specifiers: Vite cannot resolve a computed dynamic import path.
  const mod =
    chain === "bsc" ? await import("./bsc/index.js")
    : chain === "base" ? await import("./base/index.js")
    : await import("./polygon/index.js");
  const adapter = "bscAdapter" in mod ? mod.bscAdapter
    : "baseAdapter" in mod ? mod.baseAdapter
    : mod.polygonAdapter;
  return adapter;
}

beforeEach(() => {
  envState.env.BSC_RPC_URL = undefined;
  envState.env.BASE_RPC_URL = undefined;
  envState.env.POLYGON_RPC_URL = undefined;
  envState.env.ETHEREUM_RPC_URL = undefined;
});

// The stub-driven cases cover BSC, BASE and POLYGON — the three that were
// broken. The ethereum module is deliberately NOT driven through the stub: it
// is the one adapter that already passed its chain id, and importing it here
// hangs before any HTTP request is issued (the stub sees zero traffic), which
// would only add a 20s timeout to the suite. ETH's adapter behaviour is covered
// by src/chains/evm.adapter.test.ts and by the live run against Sepolia.
const REGRESSED = ["bsc", "base", "polygon"] as const;

describe("every regressed EVM adapter honours the configured chain id", () => {
  it.each(REGRESSED)("%s reads a balance when the chain id is a testnet", async (chain) => {
    const chainId = NETWORKS[chain].testnet;
    const adapter = await loadAdapter(chain, chainId);
    // The stub answers 1e18 wei; all three use 18 decimals, so the exact-value
    // conversion must yield "1". Without the fix this rejects with NETWORK_ERROR
    // "network changed: <mainnet> => <testnet>".
    await expect(adapter.getBalance(ADDRESS)).resolves.toBe("1");
  });

  it.each(REGRESSED)("%s still works on a mainnet chain id", async (chain) => {
    const adapter = await loadAdapter(chain, NETWORKS[chain].mainnet);
    await expect(adapter.getBalance(ADDRESS)).resolves.toBe("1");
  });

  it("fails loudly if the RPC reports a different network than configured", async () => {
    // Guards against "fixing" this by disabling the check: a mismatch must still
    // be an error, not a silently wrong answer.
    const adapter = await loadAdapter("bsc", 97);
    claimedChainId = 56; // the node disagrees with BSC_CHAIN_ID
    await expect(adapter.getBalance(ADDRESS)).rejects.toThrow(/network changed/i);
  });

  it("ethereum still exposes a usable adapter", async () => {
    // ETH was never affected; assert only that its module loads and validates
    // addresses, without driving the stub.
    envState.env.ETHEREUM_RPC_URL = stubUrl;
    vi.resetModules();
    const mod = await import("./ethereum/index.js");
    expect(mod.ethereumAdapter.isValidAddress(ADDRESS)).toBe(true);
    expect(mod.ethereumAdapter.isValidAddress("not-an-address")).toBe(false);
  });
});
