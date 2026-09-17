// TODO: wire up to Tribridge/TriVerify SDK (tribridge.tech) once friend's API is ready
// Address-existence verification layer, used on top of each chain adapter's
// format-only isValidAddress() check during the Send flow's Safety Confirmation step.

import { getChainAdapter, type ChainName } from "../chains/index.js";
import { verifyAddressOnChain, type ChainId } from "./verify.js";

export interface AddressVerificationResult {
  address: string;
  chain: ChainName;
  formatValid: boolean;
  existsOnChain: boolean;
  active: boolean;
  source?: string;
  error?: string;
}

export async function verifyAddressExists(
  address: string,
  chain: ChainName
): Promise<AddressVerificationResult> {
  const adapter = await getChainAdapter(chain);
  if (!adapter.isValidAddress(address)) {
    return { address, chain, formatValid: false, existsOnChain: false, active: false, error: "invalid_address_format" };
  }
  const result = await verifyAddressOnChain(address, chain.toLowerCase() as ChainId);
  if (!result.exists) {
    throw Object.assign(new Error(`Address could not be verified on ${chain}`), { statusCode: 400 });
  }
  return {
    address,
    chain,
    formatValid: true,
    existsOnChain: result.exists,
    active: result.active,
    source: result.source,
    error: result.error,
  };
}
