import { createEvmAdapter } from "../../evm.adapter.js";
import { env } from "../../../config/env.js";
import { getEvmChainId } from "../../chain.network.js";

// Chain id from getEvmChainId, not the omitted third argument: without it this
// adapter was pinned to mainnet (8453) and failed with
// "network changed: 8453 => 84532" whenever BASE_CHAIN_ID was a testnet.
export const baseAdapter = createEvmAdapter("BASE", env.BASE_RPC_URL ?? "", getEvmChainId("BASE"));
