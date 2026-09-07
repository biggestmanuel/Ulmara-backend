import { createEvmAdapter } from "../../evm.adapter.js";

// TODO: add BASE_RPC_URL to env schema
export const baseAdapter = createEvmAdapter("BASE", process.env.BASE_RPC_URL ?? "");
