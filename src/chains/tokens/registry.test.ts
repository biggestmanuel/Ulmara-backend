import { beforeEach, describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";

// env drives which network each chain is "currently" pointed at, so the
// registry is exercised across mainnet and testnet configurations.
const { envState } = vi.hoisted(() => ({
  envState: {
    env: {
      ETHEREUM_CHAIN_ID: 11155111,
      BSC_CHAIN_ID: undefined as number | undefined,
      BASE_CHAIN_ID: undefined as number | undefined,
      POLYGON_CHAIN_ID: undefined as number | undefined,
      ERC20_TOKEN_CONFIG: undefined as string | undefined,
      // The registry logs through the app logger, which reads this at module
      // load; a partial mock without it makes pino reject `undefined`.
      LOG_LEVEL: "silent",
    },
  },
}));

vi.mock("../../config/env.js", () => ({ env: envState.env }));
vi.mock("../../config/logger.js", () => ({ logger: { warn: vi.fn() } }));

import { logger } from "../../config/logger.js";
import { getEvmChainId } from "../chain.network.js";
import {
  isTokenAsset,
  listTokens,
  requireToken,
  resolveToken,
  resetTokenOverrides,
} from "./registry.js";

const ADDR = /^0x[a-fA-F0-9]{40}$/;

/** env var that selects each chain's network (ETH's is ETHEREUM_CHAIN_ID). */
const CHAIN_ID_KEY = {
  ETH: "ETHEREUM_CHAIN_ID",
  BSC: "BSC_CHAIN_ID",
  BASE: "BASE_CHAIN_ID",
  POLYGON: "POLYGON_CHAIN_ID",
} as const;

/** The subset of the mocked `env` that this helper writes to. */
type MockEnv = Record<(typeof CHAIN_ID_KEY)[keyof typeof CHAIN_ID_KEY], number | undefined>;

function setChainId(chain: string, chainId: number | undefined): void {
  // `CHAIN_ID_KEY` is the only place a chain name becomes an env var name, so
  // the key it yields is provably one of the four the mock declares. The cast
  // keeps the single unavoidable widening in one documented spot instead of at
  // every call site.
  (envState.env as MockEnv)[CHAIN_ID_KEY[chain as keyof typeof CHAIN_ID_KEY]] = chainId;
}

beforeEach(() => {
  envState.env.ETHEREUM_CHAIN_ID = 11155111;
  envState.env.BSC_CHAIN_ID = undefined;
  envState.env.BASE_CHAIN_ID = undefined;
  envState.env.POLYGON_CHAIN_ID = undefined;
  envState.env.ERC20_TOKEN_CONFIG = undefined;
  resetTokenOverrides();
});

describe("chain id resolution", () => {
  it("reads Ethereum from the environment (no hardcoding)", () => {
    envState.env.ETHEREUM_CHAIN_ID = 1;
    expect(getEvmChainId("ETH")).toBe(1);
    envState.env.ETHEREUM_CHAIN_ID = 11155111;
    expect(getEvmChainId("ETH")).toBe(11155111);
  });

  it("reads BSC/Base/Polygon overrides from the environment", () => {
    envState.env.BSC_CHAIN_ID = 97;
    envState.env.BASE_CHAIN_ID = 84532;
    envState.env.POLYGON_CHAIN_ID = 80002;
    expect(getEvmChainId("BSC")).toBe(97);
    expect(getEvmChainId("BASE")).toBe(84532);
    expect(getEvmChainId("POLYGON")).toBe(80002);
  });

  it("falls back to mainnet ids when no override is set", () => {
    expect(getEvmChainId("BSC")).toBe(56);
    expect(getEvmChainId("BASE")).toBe(8453);
    expect(getEvmChainId("POLYGON")).toBe(137);
  });

  it("refuses a non-EVM chain", () => {
    expect(() => getEvmChainId("SOL")).toThrow("Not an EVM chain: SOL");
  });
});

describe("token registry — network binding", () => {
  it("Sepolia exposes Circle USDC only (Tether issues no Sepolia USDT)", () => {
    envState.env.ETHEREUM_CHAIN_ID = 11155111;
    const tokens = listTokens("ETH");
    expect(tokens.map((t) => t.symbol)).toEqual(["USDC"]);
    expect(tokens[0]).toMatchObject({
      symbol: "USDC",
      decimals: 6,
      chainId: 11155111,
      verified: true,
    });
    expect(tokens[0].address).toMatch(ADDR);
  });

  it("Ethereum mainnet exposes both USDC and USDT", () => {
    envState.env.ETHEREUM_CHAIN_ID = 1;
    const tokens = listTokens("ETH");
    expect(tokens.map((t) => t.symbol).sort()).toEqual(["USDC", "USDT"]);
    expect(tokens.every((t) => t.chainId === 1 && t.decimals === 6)).toBe(true);
  });

  it("never mixes networks: switching ETH to mainnet swaps the address set", () => {
    envState.env.ETHEREUM_CHAIN_ID = 11155111;
    const sepolia = resolveToken("ETH", "USDC")!.address;
    envState.env.ETHEREUM_CHAIN_ID = 1;
    const mainnet = resolveToken("ETH", "USDC")!.address;
    expect(sepolia).not.toBe(mainnet);
  });

  it("BSC mainnet USDT/USDC are 18 decimals, unlike the same tickers on Ethereum", () => {
    // The single most important property in this registry: decimals are
    // per-CONTRACT, not per-ticker.
    envState.env.BSC_CHAIN_ID = 56;
    expect(resolveToken("BSC", "USDT")!.decimals).toBe(18);
    expect(resolveToken("BSC", "USDC")!.decimals).toBe(18);
    envState.env.ETHEREUM_CHAIN_ID = 1;
    expect(resolveToken("ETH", "USDT")!.decimals).toBe(6);
  });

  it("Base and Polygon honour their testnet overrides", () => {
    envState.env.BASE_CHAIN_ID = 84532;
    expect(resolveToken("BASE", "USDC")!.address).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    envState.env.POLYGON_CHAIN_ID = 80002;
    expect(resolveToken("POLYGON", "USDC")!.address).toBe("0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582");
  });

  it("returns an empty list for a chain/network with no configured tokens", () => {
    envState.env.BSC_CHAIN_ID = 97; // BSC Testnet: no canonical USDT/USDC
    expect(listTokens("BSC")).toEqual([]);
  });

  it("returns an empty list for non-EVM chains", () => {
    expect(listTokens("SOL")).toEqual([]);
    expect(listTokens("BTC")).toEqual([]);
  });
});

describe("token resolution", () => {
  beforeEach(() => {
    envState.env.ETHEREUM_CHAIN_ID = 1;
  });

  it("resolves case-insensitively to an UPPERCASE symbol", () => {
    expect(resolveToken("ETH", "usdc")?.symbol).toBe("USDC");
    expect(resolveToken("ETH", "USDC")?.symbol).toBe("USDC");
    expect(resolveToken("ETH", "UsDc")?.symbol).toBe("USDC");
  });

  it("returns null for an unknown asset or an undefined one", () => {
    expect(resolveToken("ETH", "DAI")).toBeNull();
    expect(resolveToken("ETH", undefined)).toBeNull();
    expect(resolveToken("ETH", "")).toBeNull();
  });

  it("isTokenAsset distinguishes tokens from native assets", () => {
    expect(isTokenAsset("ETH", "USDC")).toBe(true);
    expect(isTokenAsset("ETH", "ETH")).toBe(false);
  });

  it("requireToken throws a 400 naming the supported assets", () => {
    try {
      requireToken("ETH", "DAI");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(400);
      expect((err as Error).message).toContain("DAI is not a supported token on ETH");
      // The message is actionable: it lists what IS available.
      expect((err as Error).message).toContain("USDC");
      expect((err as Error).message).toContain("USDT");
    }
  });
});

describe("ERC20_TOKEN_CONFIG overrides", () => {
  it("adds a token for a network the seed table does not cover", () => {
    // BSC Testnet has no canonical stablecoin in the built-in table.
    envState.env.BSC_CHAIN_ID = 97;
    expect(listTokens("BSC")).toEqual([]);

    envState.env.ERC20_TOKEN_CONFIG = JSON.stringify([
      { chain: "BSC", chainId: 97, symbol: "USDT", address: "0x1111111111111111111111111111111111111111", decimals: 18, name: "Test USDT" },
    ]);
    resetTokenOverrides();

    const token = resolveToken("BSC", "USDT");
    expect(token).toMatchObject({ symbol: "USDT", decimals: 18, chainId: 97, name: "Test USDT" });
    expect(token!.verified).toBe(false); // operator-supplied, not on-chain verified
  });

  it("overrides a seed entry for the same symbol and network", () => {
    envState.env.ETHEREUM_CHAIN_ID = 1;
    envState.env.ERC20_TOKEN_CONFIG = JSON.stringify([
      { chain: "ETH", chainId: 1, symbol: "USDC", address: "0x2222222222222222222222222222222222222222", decimals: 8 },
    ]);
    resetTokenOverrides();
    expect(resolveToken("ETH", "USDC")!.address).toBe("0x2222222222222222222222222222222222222222");
  });

  it("an override for a different chainId on the same chain does not apply", () => {
    envState.env.ETHEREUM_CHAIN_ID = 1;
    envState.env.ERC20_TOKEN_CONFIG = JSON.stringify([
      { chain: "ETH", chainId: 11155111, symbol: "USDC", address: "0x3333333333333333333333333333333333333333", decimals: 6 },
    ]);
    resetTokenOverrides();
    // Mainnet is still using the verified mainnet address.
    expect(resolveToken("ETH", "USDC")!.address).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  });

  it("ignores a malformed override without throwing (a bad entry must not take the API down)", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    envState.env.ERC20_TOKEN_CONFIG = "{not json";
    resetTokenOverrides();
    // The override is dropped, but the built-in verified seeds still apply:
    // Sepolia USDC is unaffected.
    expect(listTokens("ETH").map((t) => t.symbol)).toEqual(["USDC"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("drops individually invalid entries and keeps the valid ones", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    envState.env.ERC20_TOKEN_CONFIG = JSON.stringify([
      { chain: "ETH", symbol: "GOOD", address: "0x4444444444444444444444444444444444444444", decimals: 6 },
      { chain: "ETH", symbol: "BAD", address: "0xshort", decimals: 6 },
      { chain: "ETH", symbol: "ALSOBAD", address: "0x5555555555555555555555555555555555555555", decimals: "six" },
    ]);
    resetTokenOverrides();
    // GOOD is added; the two malformed ones are dropped; the seed remains.
    expect(listTokens("ETH").map((t) => t.symbol)).toEqual(["GOOD", "USDC"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("rejects a non-array JSON value", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    envState.env.ERC20_TOKEN_CONFIG = '{"USDC":"0x1"}';
    resetTokenOverrides();
    expect(listTokens("ETH").map((t) => t.symbol)).toEqual(["USDC"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("seed address/decimals provenance (values verified on-chain)", () => {
  it("pins the addresses this pass verified against live RPCs", () => {
    const expected: [string, number, string, string, number][] = [
      // chain, chainId, symbol, address, decimals
      ["ETH", 1, "USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6],
      ["ETH", 1, "USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6],
      ["ETH", 11155111, "USDC", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", 6],
      ["BSC", 56, "USDT", "0x55d398326f99059fF775485246999027B3197955", 18],
      ["BSC", 56, "USDC", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", 18],
      ["BASE", 8453, "USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6],
      ["BASE", 84532, "USDC", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", 6],
      ["POLYGON", 137, "USDC", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", 6],
      ["POLYGON", 80002, "USDC", "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582", 6],
    ];
    for (const [chain, chainId, symbol, address, decimals] of expected) {
      setChainId(chain, chainId);
      resetTokenOverrides();
      const token = resolveToken(chain as never, symbol);
      expect(token, `${chain}:${chainId}:${symbol}`).not.toBeNull();
      expect(token!.address).toBe(address);
      expect(token!.decimals).toBe(decimals);
      expect(token!.verified).toBe(true);
    }
  });

  it("every seeded address is a syntactically valid, checksummed EVM address", () => {
    for (const chain of ["ETH", "BSC", "BASE", "POLYGON"] as const) {
      for (const id of [1, 56, 8453, 137, 11155111, 84532, 80002]) {
        setChainId(chain, id);
        resetTokenOverrides();
        for (const token of listTokens(chain)) {
          expect(token.address, `${chain}:${id}:${token.symbol}`).toMatch(ADDR);
          expect(ethers.getAddress(token.address)).toBe(token.address); // checksummed
        }
      }
    }
  });

  it("no symbol appears twice for the same chain+network", () => {
    for (const chain of ["ETH", "BSC", "BASE", "POLYGON"] as const) {
      for (const id of [1, 56, 8453, 137, 11155111, 84532, 80002]) {
        setChainId(chain, id);
        resetTokenOverrides();
        const symbols = listTokens(chain).map((t) => t.symbol);
        expect(new Set(symbols).size).toBe(symbols.length);
      }
    }
  });
});
