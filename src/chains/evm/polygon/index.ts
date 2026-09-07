import { createEvmAdapter } from "../../evm.adapter.js";

// TODO: add POLYGON_RPC_URL to env schema
export const polygonAdapter = createEvmAdapter("POLYGON", process.env.POLYGON_RPC_URL ?? "");
