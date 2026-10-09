import { createEvmAdapter } from "../../evm.adapter.js";
import { env } from "../../../config/env.js";
import { getEvmChainId } from "../../chain.network.js";

// The chain id MUST come from getEvmChainId. createEvmAdapter falls back to
// CHAIN_CONFIG's hardcoded mainnet value when the third argument is omitted, so
// leaving it out pinned this adapter to mainnet (56) and made every read fail
// with "network changed: 56 => 97" the moment BSC_CHAIN_ID pointed at a
// testnet. ETH passes it; BSC did not, and the two have now diverged.
export const bscAdapter = createEvmAdapter("BSC", env.BSC_RPC_URL ?? "", getEvmChainId("BSC"));
