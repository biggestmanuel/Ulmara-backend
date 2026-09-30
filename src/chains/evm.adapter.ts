import { ethers } from "ethers";
import { ProviderUnavailableError, type ChainAdapter, type TokenTransferPlan } from "./chain.types.js";
import { type ChainName } from "./chain.network.js";
import { listTokens, type TokenConfig } from "./tokens/registry.js";
import { fromBaseUnits, toBaseUnits } from "../utils/money.js";

const CHAIN_CONFIG: Record<string, { chainId: number; decimals: number }> = {
  // Mainnet defaults. The concrete ETH adapter is created with
  // env.ETHEREUM_CHAIN_ID, which runs Sepolia during the pilot phase.
  ETH: { chainId: 1, decimals: 18 },
  BSC: { chainId: 56, decimals: 18 },
  BASE: { chainId: 8453, decimals: 18 },
  POLYGON: { chainId: 137, decimals: 18 },
};

/** ERC-20 ABI — the four calls needed for balance, transfer and fee checks. */
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
] as const;

const ERC20_INTERFACE = new ethers.Interface(ERC20_ABI);

/** Gas for a plain value transfer. */
const NATIVE_TRANSFER_GAS = 21_000n;
/** ERC-20 transfer: cold account access + cold token contract + calldata. */
const TOKEN_TRANSFER_GAS = 65_000n;

export interface NativeTransferInput {
  fromAddress: string;
  toAddress: string;
  asset: string;
  amount: string;
}

export type TransferInput = NativeTransferInput;

/** Shared EVM logic: native transfers, ERC-20 reads, token transfer plans. */
export function createEvmAdapter(chainName: ChainName, rpcUrl: string, chainIdOverride?: number): ChainAdapter {
  const config = CHAIN_CONFIG[chainName];
  if (!config) throw new Error(`Unsupported EVM chain: ${chainName}`);
  const chainId = chainIdOverride ?? config.chainId;
  const nativeDecimals = config.decimals;
  const provider = rpcUrl ? new ethers.JsonRpcProvider(rpcUrl, chainId) : null;
  const requireProvider = () => provider ?? (() => { throw new ProviderUnavailableError(chainName, "RPC"); })();

  // A minimal read-only contract handle; a wallet is never held server-side.
  const contractFor = (token: TokenConfig) =>
    new ethers.Contract(token.address, ERC20_INTERFACE, requireProvider());

  const sendSigned = async (signedTx: string) => {
    const response = await requireProvider().broadcastTransaction(signedTx);
    return { txHash: response.hash };
  };

  const assertNativeAsset = (asset: string) => {
    const native = chainName === "BASE" ? "ETH" : chainName;
    if (asset !== native) {
      throw Object.assign(
        new Error(`Native EVM adapter cannot transfer ${asset} on ${chainName}`),
        { statusCode: 400 },
      );
    }
  };

  /** Rejects a token not configured for the chain id we are actually on. */
  const tokenFor = (asset: string): TokenConfig => {
    const token = findToken(asset);
    if (!token) {
      const available = tokensForChain().map((t) => t.symbol);
      const hint = available.length > 0 ? ` Supported on ${chainName}: ${available.join(", ")}.` : "";
      throw Object.assign(
        new Error(`${asset} is not a supported token on ${chainName}.${hint}`),
        { statusCode: 400 },
      );
    }
    if (token.chainId !== chainId) {
      throw Object.assign(
        new Error(
          `${token.symbol} on ${chainName} is configured for chain id ${token.chainId}, ` +
            `but this deployment runs chain id ${chainId}`,
        ),
        { statusCode: 500 },
      );
    }
    return token;
  };

  /** Tokens configured for THIS chain on the network we are actually on. */
  const tokensForChain = (): TokenConfig[] => listTokens(chainName, chainId);

  const findToken = (asset: string): TokenConfig | null =>
    tokensForChain().find((token) => token.symbol === asset.toUpperCase()) ?? null;

  /** feePerGas * gasLimit, in the NATIVE asset, as a decimal string. */
  const gasCost = async (gasLimit: bigint): Promise<string> => {
    const feeData = await requireProvider().getFeeData();
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!gasPrice) throw new Error("Unable to estimate gas price");
    return fromBaseUnits(gasPrice * gasLimit, nativeDecimals);
  };

  const buildTokenTransfer = async (input: NativeTransferInput, token?: TokenConfig): Promise<TokenTransferPlan> => {
    const resolved = token ?? tokenFor(input.asset);
    if (resolved.chainId !== chainId) {
      throw Object.assign(new Error(`${resolved.symbol} is not configured for chain id ${chainId}`), {
        statusCode: 400,
      });
    }
    // Fee hints are BEST EFFORT. Building the verifiable calldata must not
    // require a live RPC: the client wallet supplies its own gas params, and
    // the server's job here is to produce a plan it can re-verify on submit.
    // If the provider is missing or the RPC is down, the plan is still correct
    // and simply carries no fee suggestion.
    const feeData = provider ? await requireProvider().getFeeData().catch(() => null) : null;
    const data = ERC20_INTERFACE.encodeFunctionData("transfer", [
      ethers.getAddress(input.toAddress),
      toBaseUnits(input.amount, resolved.decimals),
    ]);
    return {
      kind: "erc20",
      chain: chainName,
      chainId,
      token: {
        symbol: resolved.symbol,
        name: resolved.name,
        decimals: resolved.decimals,
        address: resolved.address,
      },
      to: resolved.address,
      recipient: ethers.getAddress(input.toAddress),
      value: "0",
      data,
      gasLimit: TOKEN_TRANSFER_GAS,
      maxFeePerGas: feeData?.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: feeData?.maxPriorityFeePerGas ?? undefined,
    };
  };

  return {
    chain: chainName,

    isValidAddress(address: string): boolean {
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    },

    /** Native balance, or an ERC-20 balance when `asset` names a configured token. */
    async getBalance(address: string, asset?: string): Promise<string> {
      if (!asset || asset === (chainName === "BASE" ? "ETH" : chainName)) {
        return fromBaseUnits(await requireProvider().getBalance(address), nativeDecimals);
      }
      const token = tokenFor(asset);
      const raw = (await contractFor(token).balanceOf(address)) as bigint;
      return fromBaseUnits(raw, token.decimals);
    },

    /** Native balance of the gas asset, independent of any token. */
    async getNativeBalance(address: string): Promise<string> {
      return fromBaseUnits(await requireProvider().getBalance(address), nativeDecimals);
    },

    listTokens(): TokenConfig[] {
      return tokensForChain();
    },

    resolveToken(asset: string): TokenConfig | null {
      return findToken(asset);
    },

    async getTokenBalance(address: string, asset: string): Promise<string> {
      const token = tokenFor(asset);
      const raw = (await contractFor(token).balanceOf(address)) as bigint;
      return fromBaseUnits(raw, token.decimals);
    },

    /** Gas cost in the native asset of moving `amount` of `asset`. */
    async estimateFee(input: NativeTransferInput): Promise<string> {
      if (findToken(input.asset)) {
        // A token transfer is more expensive than a value transfer; price it
        // as such so the user is not quoted a native-transfer fee.
        return gasCost(TOKEN_TRANSFER_GAS);
      }
      return gasCost(NATIVE_TRANSFER_GAS);
    },

    /**
     * Builds the unsigned transaction the client will sign.
     *
     * For a token this is a call to the token contract: `to` is the CONTRACT,
     * `value` is 0, and the payload is transfer(recipient, amount). Getting
     * this wrong is the classic way to burn funds, so the submit path
     * re-decodes and re-verifies every field against the stored intent.
     */
    async buildTransaction(input: NativeTransferInput): Promise<unknown> {
      const token = findToken(input.asset);
      if (token) return buildTokenTransfer(input, token);

      assertNativeAsset(input.asset);
      const feeData = await requireProvider().getFeeData();
      return {
        from: ethers.getAddress(input.fromAddress),
        to: ethers.getAddress(input.toAddress),
        value: toBaseUnits(input.amount, nativeDecimals),
        chainId,
        gasLimit: NATIVE_TRANSFER_GAS,
        maxFeePerGas: feeData.maxFeePerGas ?? undefined,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
      };
    },

    /** Token transfer plan, chain-native values for the client signer. */
    async buildTokenTransfer(input: NativeTransferInput, token?: TokenConfig): Promise<TokenTransferPlan> {
      return buildTokenTransfer(input, token);
    },

    /**
     * Can this address pay `requiredNative` in gas? Used before accepting a
     * token transfer, which needs native gas even though it moves no native.
     */
    async canPayGas(address: string, requiredNative: string): Promise<boolean> {
      const balance = await requireProvider().getBalance(address);
      return balance >= toBaseUnits(requiredNative, nativeDecimals);
    },

    async sendTransaction(signedTx: unknown): Promise<{ txHash: string }> {
      if (typeof signedTx !== "string") throw new Error("Signed EVM transaction must be serialized hex");
      return sendSigned(signedTx);
    },

    async getTransactionStatus(txHash: string) {
      const receipt = await requireProvider().getTransactionReceipt(txHash);
      if (!receipt) return "pending" as const;
      return receipt.status === 1 ? "confirmed" as const : "failed" as const;
    },

    async sendSignedTransaction(signedTx: string) {
      return sendSigned(signedTx);
    },
  };
}
