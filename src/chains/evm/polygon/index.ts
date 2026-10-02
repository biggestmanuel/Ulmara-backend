import { createEvmAdapter } from "../../evm.adapter.js";
import { env } from "../../../config/env.js";
import { getEvmChainId } from "../../chain.network.js";

// Chain id from getEvmChainId, not the omitted third argument: without it this
// adapter was pinned to mainnet (137) and failed with
// "network changed: 137 => 80002" whenever POLYGON_CHAIN_ID was a testnet.
export const polygonAdapter = createEvmAdapter("POLYGON", env.POLYGON_RPC_URL ?? "", getEvmChainId("POLYGON"));
