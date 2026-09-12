import { createEvmAdapter } from "../../evm.adapter.js";
import { env } from "../../../config/env.js";

export const ethereumAdapter = createEvmAdapter("ETH", env.ETHEREUM_RPC_URL ?? "", env.ETHEREUM_CHAIN_ID);
