import { createEvmAdapter } from "../../evm.adapter.js";
import { env } from "../../../config/env.js";

// TODO: add ETHEREUM_RPC_URL to env schema
export const ethereumAdapter = createEvmAdapter("ETH", process.env.ETHEREUM_RPC_URL ?? "");
