/**
 * Verifies every configured ERC-20 entry against its live network.
 *
 * For each registry entry this reads the contract on-chain and compares
 *   - that there IS contract code at the address (an EOA or an empty address
 *     is the classic wrong-network symptom),
 *   - the on-chain `decimals()` against our configured value,
 *   - the on-chain `symbol()` against our configured symbol.
 *
 * Run it after changing ERC20_TOKEN_CONFIG or moving a chain to a new network:
 *   npm run verify:tokens
 *
 * Exit code is non-zero when any entry disagrees, so it can gate a deploy.
 * Requires the relevant *_RPC_URL to be set for the chains being checked.
 */
import { JsonRpcProvider, Interface, isAddress, getAddress } from "ethers";
import { env } from "../src/config/env.js";
import { listTokens } from "../src/chains/tokens/registry.js";
import { getEvmChainId } from "../src/chains/chain.network.js";
import type { ChainName } from "../src/chains/index.js";

const ERC20 = new Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const RPC_BY_CHAIN: Record<string, string | undefined> = {
  ETH: env.ETHEREUM_RPC_URL,
  BSC: env.BSC_RPC_URL,
  BASE: env.BASE_RPC_URL,
  POLYGON: env.POLYGON_RPC_URL,
};

const SYMBOL_IFACE = new Interface(["function symbol() view returns (string)"]);

/**
 * Decodes a `symbol()` return value. Tokens vary: some return a dynamic
 * string, others a bytes32, and older ABIs wrap either in an array — so this
 * coerces defensively rather than assuming a plain string.
 */
function decodeSymbol(hex: string | null): string | null {
  if (!hex || hex === "0x") return null;
  try {
    const decoded = SYMBOL_IFACE.decodeFunctionResult("symbol", hex) as unknown;
    const value = Array.isArray(decoded) ? decoded[0] : decoded;
    if (typeof value === "string") return value.replace(/\0+$/, "").trim() || null;
    if (value && typeof value === "object" && "toString" in value) {
      const text = String(value).replace(/[^ -~]/g, "").trim();
      return text || null;
    }
    return null;
  } catch {
    // bytes32-style tokens are not decodable by this interface; fall back to a
    // best-effort read of the raw word.
    const body = hex.slice(2);
    if (body.length >= 128) {
      const raw = Buffer.from(body.slice(0, 64), "hex").toString("utf8").replace(/\0/g, "").trim();
      return raw || null;
    }
    return null;
  }
}

interface Row {
  chain: string;
  chainId: number;
  symbol: string;
  address: string;
  configuredDecimals: number;
  onchainDecimals: number | null;
  onchainSymbol: string | null;
  hasCode: boolean;
  status: "OK" | "NO_CODE" | "DECIMALS_MISMATCH" | "SYMBOL_MISMATCH" | "BAD_ADDRESS" | "NO_RPC" | "RPC_ERROR";
  detail?: string;
}

const rows: Row[] = [];
const chains: ChainName[] = ["ETH", "BSC", "BASE", "POLYGON"];

for (const chain of chains) {
  let chainId: number;
  try {
    chainId = getEvmChainId(chain);
  } catch {
    continue;
  }
  const tokens = listTokens(chain, chainId);
  const rpcUrl = RPC_BY_CHAIN[chain];

  if (tokens.length === 0) {
    console.log(`\n${chain} (chain id ${chainId}): no tokens configured — skipped`);
    continue;
  }
  if (!rpcUrl) {
    console.log(`\n${chain} (chain id ${chainId}): ${tokens.length} token(s) configured but no RPC URL set — cannot verify`);
    for (const t of tokens) {
      rows.push({
        chain, chainId, symbol: t.symbol, address: t.address,
        configuredDecimals: t.decimals, onchainDecimals: null, onchainSymbol: null,
        hasCode: false, status: "NO_RPC", detail: "set the chain's RPC URL to verify",
      });
    }
    continue;
  }

  console.log(`\n${chain} (chain id ${chainId}) via ${rpcUrl.replace(/\/\/[^@]*@/, "//***@")}`);
  const provider = new JsonRpcProvider(rpcUrl, chainId);

  // Confirm we are talking to the network the registry thinks we are on.
  const actualChainId = Number((await provider.getNetwork()).chainId);
  if (actualChainId !== chainId) {
    console.log(`  !! RPC reports chain id ${actualChainId} but ${chain} is configured as ${chainId}`);
  }

  for (const token of tokens) {
    const row: Row = {
      chain, chainId, symbol: token.symbol, address: token.address,
      configuredDecimals: token.decimals, onchainDecimals: null,
      onchainSymbol: null, hasCode: false, status: "OK",
    };
    try {
      if (!isAddress(token.address)) {
        row.status = "BAD_ADDRESS";
        row.detail = "not a valid EVM address";
        rows.push(row);
        continue;
      }
      const [code, dec, sym] = await Promise.all([
        provider.getCode(getAddress(token.address)),
        provider.call({ to: getAddress(token.address), data: ERC20.encodeFunctionData("decimals") }),
        provider.call({ to: getAddress(token.address), data: ERC20.encodeFunctionData("symbol") }),
      ]);
      row.hasCode = code !== "0x";
      if (typeof dec === "string" && dec !== "0x") row.onchainDecimals = Number(BigInt(dec));
      row.onchainSymbol = decodeSymbol(typeof sym === "string" ? sym : null);

      if (!row.hasCode) {
        // Almost always the address belongs to a different network.
        row.status = "NO_CODE";
        row.detail = `no contract at this address on chain id ${chainId}`;
      } else if (row.onchainDecimals !== null && row.onchainDecimals !== row.configuredDecimals) {
        row.status = "DECIMALS_MISMATCH";
        row.detail = `configured ${row.configuredDecimals}, on-chain ${row.onchainDecimals}`;
      } else if (row.onchainSymbol && row.onchainSymbol.toUpperCase() !== token.symbol.toUpperCase()) {
        row.status = "SYMBOL_MISMATCH";
        row.detail = `configured ${token.symbol}, on-chain ${row.onchainSymbol}`;
      }
    } catch (err) {
      row.status = "RPC_ERROR";
      row.detail = (err as Error).message.slice(0, 120);
    }
    rows.push(row);
  }
}

const ICON: Record<Row["status"], string> = {
  OK: "  ok  ",
  NO_CODE: " CODE ",
  DECIMALS_MISMATCH: " DECIM",
  SYMBOL_MISMATCH: " SYMBO",
  BAD_ADDRESS: " ADDR ",
  NO_RPC: " NO_RPC",
  RPC_ERROR: " ERROR",
};

console.log("\n=== ERC-20 registry verification ===");
for (const r of rows) {
  const detail = r.detail ? `  (${r.detail})` : "";
  console.log(
    `[${ICON[r.status]}] ${r.chain}`.padEnd(12) +
      `${r.symbol.padEnd(6)} ${r.address}  dec=${r.configuredDecimals}` +
      `${r.onchainDecimals !== null ? `/${r.onchainDecimals}` : ""}` +
      `${r.onchainSymbol ? ` sym=${r.onchainSymbol}` : ""}${detail}`,
  );
}

const failures = rows.filter((r) => r.status !== "OK");
const unverified = rows.filter((r) => r.status === "NO_RPC");
console.log(`\ntotal=${rows.length} ok=${rows.length - failures.length} problems=${failures.length} unverified(no RPC)=${unverified.length}`);

if (failures.length > 0) {
  console.error("\nFAILED: at least one configured token does not match its network.");
  process.exit(1);
}
if (unverified.length > 0) {
  console.warn("\nSome entries could not be verified (no RPC configured). Set the RPC URL and re-run.");
}
console.log("\nAll verifiable ERC-20 entries match their network.");
