import { createEvmAdapter } from "../../evm.adapter.js";
import { env } from "../../../config/env.js";

export const baseAdapter = createEvmAdapter("BASE", env.BASE_RPC_URL ?? "");
