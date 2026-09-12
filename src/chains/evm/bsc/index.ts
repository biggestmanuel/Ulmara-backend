import { createEvmAdapter } from "../../evm.adapter.js";
import { env } from "../../../config/env.js";

export const bscAdapter = createEvmAdapter("BSC", env.BSC_RPC_URL ?? "");
