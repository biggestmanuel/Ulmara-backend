import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// B5/C5: GET /api/wallet/token-balances?chain=<CHAIN>&address=<addr>
//
// The client called this path and got a 404, which it interprets as "this
// backend cannot do it" and permanently falls back to one eth_call per token
// from the device — so a feature built server-side was silently running on the
// phone. This route previously did not exist.
//
// The response shape is the client's `TokenBalance`, reconstructed from the
// frontend repo at the pinned hash c4c163a624d6b559db5ec1e3a40a4ac11e61d072
// (lib/api/tokens.ts):
//
//   { symbol, name, chain, network, decimals, contractAddress, balance }
//
// with `chain` as the client's lower-case ChainId and `network` as the
// UPPERCASE wire identifier — the client types them separately, and
// `contractAddress` is the field name it reads (NOT `address`).
// ---------------------------------------------------------------------------

interface TokenRow {
  symbol: string;
  name: string;
  decimals: number;
  address: string;
}

const state = vi.hoisted(() => ({
  adapter: null as null | {
    listTokens?: () => TokenRow[];
    getTokenBalance?: (address: string, asset: string) => Promise<string>;
  },
  adapterError: null as Error | null,
  invalidAddress: false,
}));

vi.mock("../../chains/index.js", async (importOriginal) => {
  const actual = await importOriginal<ChainModule>();
  return {
    ...actual,
    getChainAdapter: vi.fn(async () => {
      if (state.adapterError) throw state.adapterError;
      if (!state.adapter) throw new Error("no adapter configured");
      return {
        isValidAddress: () => !state.invalidAddress,
        ...state.adapter,
      };
    }),
  };
});

vi.mock("../../config/database.js", () => ({
  prisma: {},
  connectDatabase: vi.fn(),
  disconnectDatabase: vi.fn(),
}));

vi.mock("../../config/logger.js", () => {
  const logger: Record<string, unknown> = {
    fatal: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(),
    debug: vi.fn(), trace: vi.fn(), child: vi.fn(() => logger),
  };
  return { logger };
});

vi.mock("../../middleware/auth.middleware.js", () => ({
  requireAuth: async (request: { userId?: string }) => {
    request.userId = "user-1";
  },
}));

import type * as ChainModuleNs from "../../chains/index.js";

/** The mocked module's own type, so `...actual` keeps every other export. */
type ChainModule = typeof ChainModuleNs;

import { buildApp } from "../../server/app.js";
import { walletService } from "./wallet.service.js";

const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ADDRESS = "0x1111111111111111111111111111111111111111";

const get = async (query: string) => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: `/api/wallet/token-balances?${query}` });
  await app.close();
  return res;
};

beforeEach(() => {
  state.adapterError = null;
  state.invalidAddress = false;
  state.adapter = {
    listTokens: () => [
      { symbol: "USDC", name: "USD Coin", decimals: 6, address: USDC },
      { symbol: "DAI", name: "Dai Stablecoin", decimals: 18, address: DAI },
    ],
    getTokenBalance: async () => "123.456789",
  };
});

describe("B5: the route exists and is no longer a 404", () => {
  it("answers 200 for chain + address", async () => {
    const res = await get(`chain=ETH&address=${ADDRESS}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it("returns one row per configured token", async () => {
    const res = await get(`chain=ETH&address=${ADDRESS}`);
    expect(res.json().data).toHaveLength(2);
  });

  it("requires chain", async () => {
    expect((await get(`address=${ADDRESS}`)).statusCode).toBe(400);
  });

  it("requires address", async () => {
    expect((await get("chain=ETH")).statusCode).toBe(400);
  });

  it("rejects an unknown chain", async () => {
    expect((await get(`chain=NOPE&address=${ADDRESS}`)).statusCode).toBe(400);
  });

  it("rejects an unknown query field — schemas stay strict", async () => {
    expect((await get(`chain=ETH&address=${ADDRESS}&walletId=other`)).statusCode).toBe(400);
  });

  it("accepts a lowercase chain? no — chains are UPPERCASE on the wire", async () => {
    // AGENTS.md: chain identifiers are UPPERCASE everywhere. Accepting the
    // lowercase form here would create a second spelling for one chain.
    expect((await get(`chain=eth&address=${ADDRESS}`)).statusCode).toBe(400);
  });
});

describe("B5: the response matches the client's TokenBalance exactly", () => {
  it("carries every field the client reads, with the client's field names", async () => {
    const res = await get(`chain=ETH&address=${ADDRESS}`);
    const row = res.json().data[0];
    expect(Object.keys(row).sort()).toEqual(
      ["balance", "chain", "contractAddress", "decimals", "name", "network", "symbol"].sort(),
    );
  });

  it("uses contractAddress, not address", async () => {
    const res = await get(`chain=ETH&address=${ADDRESS}`);
    const row = res.json().data[0];
    expect(row.contractAddress).toBe(USDC);
    expect(row).not.toHaveProperty("address");
  });

  it("sets chain to the lower-case ChainId and network to the UPPERCASE wire id", async () => {
    const res = await get(`chain=ETH&address=${ADDRESS}`);
    const row = res.json().data[0];
    expect(row.chain).toBe("eth");
    expect(row.network).toBe("ETH");
  });

  it("keeps network consistent with the chain that was asked for", async () => {
    const res = await get(`chain=BASE&address=${ADDRESS}`);
    expect(res.json().data[0].network).toBe("BASE");
    expect(res.json().data[0].chain).toBe("base");
  });

  it("returns balance as a string, never a number", async () => {
    const res = await get(`chain=ETH&address=${ADDRESS}`);
    expect(typeof res.json().data[0].balance).toBe("string");
  });

  it("does not do float arithmetic on the balance", async () => {
    state.adapter!.getTokenBalance = async () => "0.000001";
    const res = await get(`chain=ETH&address=${ADDRESS}`);
    // Passed through verbatim: no rounding, no Number(), no reformatting.
    expect(res.json().data[0].balance).toBe("0.000001");
  });
});

describe("B5: failures never surface as an unexplained raw 500", () => {
  it("returns an empty list when the chain adapter cannot be reached", async () => {
    state.adapterError = new Error("ECONNREFUSED 127.0.0.1:8545");
    const res = await get(`chain=ETH&address=${ADDRESS}`);
    expect(res.statusCode).toBe(200);
    // The client's own contract for an unreadable chain is "no rows".
    expect(res.json().data).toEqual([]);
  });

  it("returns an empty list when the chain has no configured tokens", async () => {
    state.adapter = { listTokens: () => [] };
    const res = await get(`chain=ETH&address=${ADDRESS}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it("isolates one failing token instead of failing the request", async () => {
    state.adapter!.getTokenBalance = async (_address, asset) => {
      if (asset === "DAI") throw new Error("rate limited by the RPC");
      return "5.0";
    };
    const res = await get(`chain=ETH&address=${ADDRESS}`);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data;
    expect(rows).toHaveLength(2);
    const dai = rows.find((r: { symbol: string }) => r.symbol === "DAI");
    const usdc = rows.find((r: { symbol: string }) => r.symbol === "USDC");
    expect(usdc.balance).toBe("5.0");
    // Unreadable is reported as 0, which the client already renders as a
    // balance — never as a hole that breaks the whole card.
    expect(dai.balance).toBe("0");
  });

  it("returns a clean 400 for a malformed address, not a 500", async () => {
    state.invalidAddress = true;
    const res = await get(`chain=ETH&address=${ADDRESS}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/address/i);
  });

  it("rejects a 200 response that leaked an internal error message", async () => {
    state.adapterError = new Error("postgres://user:hunter2@db/neon failed");
    const res = await get(`chain=ETH&address=${ADDRESS}`);
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain("ECONNREFUSED");
  });
});

describe("B5: the service is usable directly", () => {
  it("is exported on walletService", async () => {
    expect(typeof walletService.getTokenBalancesForChain).toBe("function");
  });
});