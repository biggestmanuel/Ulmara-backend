import { beforeEach, describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import { createEvmAdapter } from "./evm.adapter.js";

const { envState } = vi.hoisted(() => ({
  envState: {
    env: {
      ETHEREUM_CHAIN_ID: 11155111,
      BSC_CHAIN_ID: undefined as number | undefined,
      BASE_CHAIN_ID: undefined as number | undefined,
      POLYGON_CHAIN_ID: undefined as number | undefined,
      ERC20_TOKEN_CONFIG: undefined as string | undefined,
      // The token registry logs through the app logger, which reads this at
      // module load; a partial mock without it makes pino reject `undefined`.
      LOG_LEVEL: "silent",
    },
  },
}));

vi.mock("../config/env.js", () => ({ env: envState.env }));

import { resetTokenOverrides } from "./tokens/registry.js";

/**
 * No RPC is used here: every test either uses an empty rpcUrl (so the adapter
 * never opens a socket) or injects a fake provider. What is under test is the
 * adapter's own logic — asset routing, network binding, calldata, decimals —
 * not the node.
 */
const SENDER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const ETH_USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const ERC20 = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);

/** ethers returns a `Result`; these helpers narrow it to the two fields used. */
const decodeTransfer = (data: string) =>
  ERC20.decodeFunctionData("transfer", data) as unknown as { to: string; amount: bigint };
const transferAmount = (data: string) => (ERC20.decodeFunctionData("transfer", data) as unknown as { amount: bigint }).amount;

beforeEach(() => {
  envState.env.ETHEREUM_CHAIN_ID = 11155111;
  envState.env.BSC_CHAIN_ID = undefined;
  envState.env.BASE_CHAIN_ID = undefined;
  envState.env.POLYGON_CHAIN_ID = undefined;
  envState.env.ERC20_TOKEN_CONFIG = undefined;
  resetTokenOverrides();
});

describe("adapter construction", () => {
  it("refuses an unknown EVM chain", () => {
    expect(() => createEvmAdapter("SOL", "")).toThrow("Unsupported EVM chain");
  });

  it("validates EVM address format", () => {
    const adapter = createEvmAdapter("ETH", "");
    expect(adapter.isValidAddress(RECIPIENT)).toBe(true);
    expect(adapter.isValidAddress("0x123")).toBe(false);
    expect(adapter.isValidAddress("not-an-address")).toBe(false);
    expect(adapter.isValidAddress(RECIPIENT + "00")).toBe(false);
  });
});

describe("token metadata exposure", () => {
  it("lists only the tokens for the configured network", () => {
    const sepolia = createEvmAdapter("ETH", "", 11155111);
    expect(sepolia.listTokens!().map((t) => t.symbol)).toEqual(["USDC"]);

    const mainnet = createEvmAdapter("ETH", "", 1);
    expect(mainnet.listTokens!().map((t) => t.symbol).sort()).toEqual(["USDC", "USDT"]);
  });

  it("resolves a token by symbol and refuses an unconfigured one", () => {
    const adapter = createEvmAdapter("ETH", "", 11155111);
    expect(adapter.resolveToken!("usdc")?.address).toBe(SEPOLIA_USDC);
    expect(adapter.resolveToken!("DAI")).toBeNull();
  });

  it("returns an empty token list for a network with none configured", () => {
    // BSC Testnet: no canonical stablecoin.
    expect(createEvmAdapter("BSC", "", 97).listTokens!()).toEqual([]);
  });
});

describe("wrong-network / wrong-token rejection", () => {
  it("a mainnet USDC address is never accepted when running Sepolia", async () => {
    const adapter = createEvmAdapter("ETH", "", 11155111);
    // The adapter is bound to Sepolia, so it resolves only the Sepolia token.
    expect(adapter.resolveToken!("USDC")!.address).toBe(SEPOLIA_USDC);
    expect(adapter.resolveToken!("USDC")!.address).not.toBe(ETH_USDC_MAINNET);
    // And a token transfer built by it targets the Sepolia contract.
    const plan = await adapter.buildTokenTransfer!({
      fromAddress: SENDER, toAddress: RECIPIENT, asset: "USDC", amount: "1",
    });
    expect(plan.token.address).toBe(SEPOLIA_USDC);
    expect(plan.chainId).toBe(11155111);
  });

  it("rejects a token the network has not configured, with a 400", async () => {
    const adapter = createEvmAdapter("ETH", "", 11155111);
    // USDT is not issued on Sepolia.
    await expect(
      adapter.buildTokenTransfer!({ fromAddress: SENDER, toAddress: RECIPIENT, asset: "USDT", amount: "1" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a non-EVM chain/asset pair with a 400", async () => {
    const adapter = createEvmAdapter("ETH", "", 11155111);
    // "SOL" names neither an ETH native asset nor a configured token.
    await expect(
      adapter.buildTokenTransfer!({ fromAddress: SENDER, toAddress: RECIPIENT, asset: "SOL", amount: "1" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("token transfer construction", () => {
  it("builds a transfer(to, amount) call to the CONTRACT with zero value", async () => {
    const adapter = createEvmAdapter("ETH", "", 11155111);
    const plan = await adapter.buildTokenTransfer!({
      fromAddress: SENDER, toAddress: RECIPIENT, asset: "USDC", amount: "12.5",
    });

    expect(plan.kind).toBe("erc20");
    // `to` is the contract, NOT the recipient — the classic mistake.
    expect(plan.to).toBe(SEPOLIA_USDC);
    expect(plan.to).not.toBe(RECIPIENT);
    expect(plan.recipient).toBe(RECIPIENT);
    expect(plan.value).toBe("0");

    // Decodes back to exactly the intended call, at 6 decimals.
    const decoded = decodeTransfer(plan.data);
    expect(ethers.getAddress(decoded.to)).toBe(RECIPIENT);
    expect(ethers.formatUnits(decoded.amount, 6)).toBe("12.5");
  });

  it("scales the amount by the token's own decimals, not the native 18", async () => {
    const six = createEvmAdapter("ETH", "", 11155111);
    const sixPlan = await six.buildTokenTransfer!({
      fromAddress: SENDER, toAddress: RECIPIENT, asset: "USDC", amount: "1",
    });
    // 1 USDC at 6 decimals = 1_000_000, NOT 10^18.
    expect(transferAmount(sixPlan.data)).toBe(1_000_000n);

    // BSC's USDT is an 18-decimal contract: the same "1" is 10^18 there.
    const eighteen = createEvmAdapter("BSC", "", 56);
    const bscPlan = await eighteen.buildTokenTransfer!({
      fromAddress: SENDER, toAddress: RECIPIENT, asset: "USDT", amount: "1",
    });
    expect(transferAmount(bscPlan.data)).toBe(10n ** 18n);
  });

  it("encodes fractional amounts exactly (no float drift)", async () => {
    const adapter = createEvmAdapter("ETH", "", 11155111);
    const plan = await adapter.buildTokenTransfer!({
      fromAddress: SENDER, toAddress: RECIPIENT, asset: "USDC", amount: "0.000001",
    });
    // 1 micro-USDC = 1 unit at 6 decimals.
    expect(transferAmount(plan.data)).toBe(1n);
  });

  it("carries the network chain id on the plan", async () => {
    const plan = await createEvmAdapter("ETH", "", 11155111).buildTokenTransfer!({
      fromAddress: SENDER, toAddress: RECIPIENT, asset: "USDC", amount: "5",
    });
    expect(plan.chainId).toBe(11155111);
    expect(plan.chain).toBe("ETH");
    expect(plan.token.decimals).toBe(6);
  });

  it("buildTransaction routes a token asset to the token path", async () => {
    const adapter = createEvmAdapter("ETH", "", 11155111);
    const built = (await adapter.buildTransaction({
      fromAddress: SENDER, toAddress: RECIPIENT, asset: "USDC", amount: "3",
    })) as { kind: string; to: string };
    expect(built.kind).toBe("erc20");
    expect(built.to).toBe(SEPOLIA_USDC);
  });
});

describe("native transfers are preserved", () => {
  it("still rejects a foreign native asset", async () => {
    const adapter = createEvmAdapter("ETH", "", 11155111);
    // "BNB" is not native on ETH and is not a configured token.
    expect(adapter.resolveToken!("BNB")).toBeNull();
    await expect(
      adapter.buildTokenTransfer!({ fromAddress: SENDER, toAddress: RECIPIENT, asset: "BNB", amount: "1" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("Base settles fees in ETH, so ETH is the native asset there", () => {
    const base = createEvmAdapter("BASE", "", 8453);
    expect(base.resolveToken!("ETH")).toBeNull(); // native, not an ERC-20
    expect(base.resolveToken!("USDC")?.symbol).toBe("USDC");
  });
});

describe("provider unavailability", () => {
  it("fails with a typed error when no RPC is configured", async () => {
    const adapter = createEvmAdapter("ETH", "", 11155111);
    await expect(adapter.getBalance(SENDER)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(adapter.getNativeBalance!(SENDER)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(adapter.getTokenBalance!(SENDER, "USDC")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(adapter.estimateFee({ fromAddress: SENDER, toAddress: RECIPIENT, asset: "USDC", amount: "1" }))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});
