import { createEvmAdapter } from "../../evm.adapter.js";

// TODO: add BSC_RPC_URL to env schema
export const bscAdapter = createEvmAdapter("BSC", process.env.BSC_RPC_URL ?? "");
