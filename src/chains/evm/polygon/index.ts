import { createEvmAdapter } from "../../evm.adapter.js";
import { env } from "../../../config/env.js";

export const polygonAdapter = createEvmAdapter("POLYGON", env.POLYGON_RPC_URL ?? "");
