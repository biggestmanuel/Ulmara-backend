import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  ETHEREUM_RPC_URL: z.string().url().optional(),
  ETHEREUM_CHAIN_ID: z.coerce.number().int().positive().default(1),
  BSC_RPC_URL: z.string().url().optional(),
  BASE_RPC_URL: z.string().url().optional(),
  POLYGON_RPC_URL: z.string().url().optional(),
  SOLANA_RPC_URL: z.string().url().optional(),
  TRON_RPC_URL: z.string().url().optional(),
  TON_RPC_URL: z.string().url().optional(),
  BTC_RPC_URL: z.string().url().optional(),
  BTC_RPC_USER: z.string().optional(),
  BTC_RPC_PASSWORD: z.string().optional(),
  TRIVERIFY_API_KEY: z.string().min(1).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
