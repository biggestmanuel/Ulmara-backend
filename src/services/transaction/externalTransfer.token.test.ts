import { beforeEach, describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";

/**
 * verifySignedTransaction is the last line of defence before funds move: it
 * re-derives every money-moving field from the STORED intent and compares them
 * with the client's signed transaction. These tests cover the native and ERC-20
 * paths, including every way a tampered signature must be refused.
 */
const { envState } = vi.hoisted(() => ({
  envState: {
    env: {
      ETHEREUM_CHAIN_ID: 11155111,
      BSC_CHAIN_ID: undefined as number | undefined,
      BASE_CHAIN_ID: undefined as number | undefined,
      POLYGON_CHAIN_ID: undefined as number | undefined,
      ERC20_TOKEN_CONFIG: undefined as string | undefined,
    },
  },
}));

vi.mock("../../config/env.js", () => ({ env: envState.env }));
vi.mock("../../config/database.js", () => ({ prisma: {} }));
vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock("../../queues/redis.client.js", () => ({ getRedis: () => ({}) }));
vi.mock("../../config/sentry.js", () => ({ reportError: vi.fn() }));
vi.mock("../auth/pinLockout.service.js", () => ({ pinLockoutService: {} }));
vi.mock("./transaction.service.js", () => ({ transactionService: {} }));
vi.mock("../../queues/transaction.queue.js", () => ({ transactionQueue: { add: vi.fn() } }));
vi.mock("../../blockchain/triverify.js", () => ({ verifyAddressExists: vi.fn() }));
vi.mock("../../chains/index.js", () => ({ getChainAdapter: vi.fn() }));

import { externalTransferService } from "./externalTransfer.service.js";
import { resetTokenOverrides } from "../../chains/tokens/registry.js";

/**
 * `verifySignedTransaction` is a synchronous validator: it inspects an
 * already-signed transaction and makes no I/O, so it throws rather than
 * returning a rejected promise. This captures the thrown error so the
 * assertions read the same way as the rejection-based ones they replaced.
 */
function captureThrow(fn: () => unknown): Error & { statusCode?: number } {
  try {
    fn();
  } catch (err) {
    return err as Error & { statusCode?: number };
  }
  throw new Error("Expected the call to throw, but it returned normally");
}

const ERC20 = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";

/**
 * A WELL-KNOWN PUBLIC test account (the first Hardhat/Anvil dev account, whose
 * key is published in every Hardhat/Anvil doc and whose Sepolia balance is
 * normally zero). It exists only to produce structurally valid signed
 * transactions for decode-and-verify tests. It is NOT a project secret and
 * must never hold funds. A production signing key must never exist in this
 * repository — the backend only ever verifies signatures, it never holds one.
 */
const WALLET = new ethers.Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const intent = (over: Record<string, unknown> = {}) => ({
  chain: "ETH",
  asset: "ETH",
  amount: { toString: () => "1.5" },
  recipient: RECIPIENT,
  ...over,
});

/** Builds a real, signed EIP-1559 transaction. */
async function signNative(over: { to?: string; value?: string; chainId?: number; data?: string } = {}) {
  const tx = await WALLET.signTransaction({
    type: 2,
    chainId: over.chainId ?? 11155111,
    to: over.to ?? RECIPIENT,
    value: ethers.parseEther(over.value ?? "1.5"),
    gasLimit: 21000n,
    maxFeePerGas: ethers.parseUnits("5", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
    data: over.data ?? "0x",
  });
  return tx;
}

async function signTokenTransfer(over: { to?: string; amount?: string; chainId?: number; value?: bigint; data?: string } = {}) {
  const tx = await WALLET.signTransaction({
    type: 2,
    chainId: over.chainId ?? 11155111,
    to: over.to ?? SEPOLIA_USDC,
    value: over.value ?? 0n,
    gasLimit: 65000n,
    maxFeePerGas: ethers.parseUnits("5", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
    data:
      over.data ??
      ERC20.encodeFunctionData("transfer", [over.to ? RECIPIENT : RECIPIENT, ethers.parseUnits(over.amount ?? "25", 6)]),
  });
  return tx;
}

beforeEach(() => {
  envState.env.ETHEREUM_CHAIN_ID = 11155111;
  envState.env.ERC20_TOKEN_CONFIG = undefined;
  resetTokenOverrides();
});

describe("native transfer verification", () => {
  it("accepts a correctly signed native transfer", async () => {
    const signed = await signNative();
    const result = externalTransferService.verifySignedTransaction(intent(), signed);
    expect(result).toMatchObject({ kind: "native", chainId: "11155111" });
    expect(result.to.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(result.value).toBe(ethers.parseEther("1.5").toString());
  });

  it("rejects a different amount", async () => {
    const signed = await signNative({ value: "1.6" });
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(intent(), signed));
    expect(err).toMatchObject({ statusCode: 400, message: "The signed transaction does not match the prepared transfer" });
  });

  it("rejects a different recipient", async () => {
    const signed = await signNative({ to: OTHER });
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(intent(), signed));
    expect(err).toMatchObject({ statusCode: 400, message: "The signed transaction does not match the prepared transfer" });
  });

  it("rejects a signature for a different network", async () => {
    const signed = await signNative({ chainId: 1 });
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(intent(), signed));
    expect(err).toMatchObject({
      statusCode: 400,
      message: "The signed transaction targets a different network than the prepared transfer",
    })
  });

  it("rejects contract data on what should be a plain value transfer", async () => {
    const signed = await signNative({ data: "0xdeadbeef" });
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(intent(), signed));
    expect(err).toMatchObject({ statusCode: 400, message: "The signed transaction contains unexpected data" });
  });

  it("rejects an undecodable blob", async () => {
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(intent(), "not-a-signed-transaction"));
    expect(err).toMatchObject({ statusCode: 400, message: "The signed transaction could not be decoded" });
  });

  it("rejects verification on a non-EVM chain", async () => {
    const signed = await signNative();
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(intent({ chain: "SOL" }), signed));
    expect(err).toMatchObject({ statusCode: 400, message: expect.stringContaining("not implemented for SOL") });
  });
});

describe("ERC-20 transfer verification", () => {
  const tokenIntent = () => intent({ asset: "USDC", amount: { toString: () => "25" } });

  it("accepts a correctly signed transfer(to, amount) call to the token contract", async () => {
    const signed = await signTokenTransfer();
    const result = externalTransferService.verifySignedTransaction(tokenIntent(), signed);
    expect(result).toMatchObject({ kind: "erc20", to: SEPOLIA_USDC, value: "0", chainId: "11155111" });
  });

  it("rejects a call to any contract other than the configured token", async () => {
    const signed = await signTokenTransfer({ to: OTHER });
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(tokenIntent(), signed));
    expect(err).toMatchObject({
      statusCode: 400,
      message: "The signed transaction does not target the expected token contract",
    })
  });

  it("rejects native value attached to a token transfer", async () => {
    const signed = await signTokenTransfer({ value: 1n });
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(tokenIntent(), signed));
    expect(err).toMatchObject({ statusCode: 400, message: "A token transfer must not attach a native value" });
  });

  it("rejects a token transfer with no calldata", async () => {
    const signed = await signTokenTransfer({ data: "0x" });
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(tokenIntent(), signed));
    expect(err).toMatchObject({ statusCode: 400, message: "The signed transaction is missing the token transfer call" });
  });

  it("rejects calldata that is not a transfer() call", async () => {
    const signed = await signTokenTransfer({ data: "0xdeadbeef" });
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(tokenIntent(), signed));
    expect(err).toMatchObject({ statusCode: 400, message: "The signed transaction does not contain a valid token transfer" });
  });

  it("rejects a transfer paying a different recipient than the intent", async () => {
    // Same contract, but the encoded recipient is a different address.
    const data = ERC20.encodeFunctionData("transfer", [OTHER, ethers.parseUnits("25", 6)]);
    const signed = await signTokenTransfer({ data });
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(tokenIntent(), signed));
    expect(err).toMatchObject({
      statusCode: 400,
      message: "The signed token transfer pays a different recipient than the prepared transfer",
    })
  });

  it("rejects a transfer of a different amount than the intent", async () => {
    const data = ERC20.encodeFunctionData("transfer", [RECIPIENT, ethers.parseUnits("26", 6)]);
    const signed = await signTokenTransfer({ data });
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(tokenIntent(), signed));
    expect(err).toMatchObject({
      statusCode: 400,
      message: "The signed token transfer amount does not match the prepared transfer",
    })
  });

  it("scales the expected amount with the token's decimals, not 18", async () => {
    // "25" at 6 decimals is 25_000_000 units. A transaction encoding 25 * 10^18
    // (the naive 18-decimal assumption) must be REJECTED, not accepted.
    const wrongScale = ERC20.encodeFunctionData("transfer", [RECIPIENT, ethers.parseUnits("25", 18)]);
    const signed = await signTokenTransfer({ data: wrongScale });
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(tokenIntent(), signed));
    expect(err).toMatchObject({ statusCode: 400 });
  });

  it("rejects a token transfer signed for the wrong network", async () => {
    const signed = await signTokenTransfer({ chainId: 1 });
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(tokenIntent(), signed));
    expect(err).toMatchObject({
      statusCode: 400,
      message: "The signed transaction targets a different network than the prepared transfer",
    })
  });

  it("rejects a NATIVE transfer submitted for a token intent", async () => {
    // A client must not be able to pass off a plain value transfer as a token
    // transfer: the contract and calldata checks catch it.
    const signed = await signNative();
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(tokenIntent(), signed));
    expect(err).toMatchObject({ statusCode: 400 });
  });

  it("rejects a token that is not configured for this network", async () => {
    // USDT is not issued on Sepolia.
    const signed = await signTokenTransfer({ data: ERC20.encodeFunctionData("transfer", [RECIPIENT, 1n]) });
    const err = captureThrow(() => externalTransferService.verifySignedTransaction(intent({ asset: "USDT", amount: { toString: () => "1" } }), signed));
    expect(err).toMatchObject({ statusCode: 400 });
  });
});

describe("wrong-network / wrong-token rejection at the asset layer", () => {
  it("accepts a configured native asset and returns null (native path)", () => {
    expect(externalTransferService.resolveAsset("ETH", "ETH")).toBeNull();
  });

  it("returns the token for a configured token asset", () => {
    const token = externalTransferService.resolveAsset("ETH", "USDC");
    expect(token).toMatchObject({ symbol: "USDC", address: SEPOLIA_USDC, decimals: 6, chainId: 11155111 });
  });

  it("rejects an asset that is neither the native coin nor a configured token", () => {
    expect(() => externalTransferService.resolveAsset("ETH", "DAI")).toThrow(/DAI transfers are not supported on ETH/);
  });

  it("names the supported assets in the rejection so the client can self-correct", () => {
    try {
      externalTransferService.resolveAsset("ETH", "DAI");
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(400);
      expect((err as Error).message).toContain("USDC");
    }
  });

  it("rejects a mainnet token while running Sepolia (and vice versa)", () => {
    // Sepolia has USDC configured; it must resolve to the Sepolia contract.
    expect(externalTransferService.resolveAsset("ETH", "USDC")!.address).toBe(SEPOLIA_USDC);

    // Switch to mainnet: the address set changes, and the intent's token
    // resolution follows it — never a mix.
    envState.env.ETHEREUM_CHAIN_ID = 1;
    resetTokenOverrides();
    const mainnet = externalTransferService.resolveAsset("ETH", "USDC")!;
    expect(mainnet.address).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(mainnet.address).not.toBe(SEPOLIA_USDC);
  });

  it("rejects an asset on a chain that has no token coverage configured", () => {
    envState.env.BSC_CHAIN_ID = 97; // BSC Testnet
    expect(() => externalTransferService.resolveAsset("BSC", "USDT")).toThrow(/USDT transfers are not supported on BSC/);
    // Native BNB is still fine.
    expect(externalTransferService.resolveAsset("BSC", "BNB")).toBeNull();
  });
});
