import "dotenv/config";
import { z } from "zod";

/** Email delivery providers. See src/services/email for the adapters. */
export const EMAIL_PROVIDERS = ["resend", "sendgrid", "ses"] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];

/** NGN fiat on/off-ramp providers. See src/services/ramp/providers. */
export const RAMP_PROVIDERS = ["bitnob", "yellowcard"] as const;
export type RampProviderName = (typeof RAMP_PROVIDERS)[number];

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DEV_VERIFICATION_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  PORT: z.coerce.number().default(4000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().min(1).optional(),

  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  // --- JWT signing key management (see config/jwt.ts for rotation) --------
  // JWT_SECRET is always the CURRENT key and the only key new tokens are
  // signed with. JWT_PREVIOUS_SECRET is the retiring key: tokens signed with
  // it keep verifying until JWT_PREVIOUS_SECRET_RETIRE_AT, after which they
  // are rejected. Leave PREVIOUS unset outside a rotation window.
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_PREVIOUS_SECRET: z.string().min(32).optional(),
  JWT_PREVIOUS_SECRET_RETIRE_AT: z.string().datetime().optional(),
  JWT_EXPIRES_IN: z.string().default("7d"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // Comma-separated CORS allowlist. Defaults cover the local dev/web flow
  // only; production deployments must set their real https:// origins (the
  // empty default fails fast in buildApp in production).
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:8081,http://localhost:19006,http://localhost:19000,http://localhost:3000"),

  // --- Reverse proxies -----------------------------------------------------
  // Comma-separated IPs or CIDR ranges of the reverse proxies in front of this
  // app, e.g. "10.0.0.0/8,172.17.0.1". Needed whenever the app is NOT exposed
  // directly, because the rate limiter keys on `request.ip`:
  //
  //   * With this UNSET, `request.ip` is the immediate peer. Behind a proxy
  //     that is the PROXY's address, so every user in the world shares one
  //     rate-limit budget per route and a single abusive client can lock every
  //     other user out of /login, /verify-pin and the rest.
  //   * With this set to "*" (or a list), `request.ip` becomes the leftmost
  //     untrusted address in X-Forwarded-For, which is the real client.
  //
  // NEVER use "*" when the app is directly internet-reachable: a client could
  // then forge X-Forwarded-For to evade its own rate limit (or to burn another
  // address's budget). List the proxy addresses, or leave this unset and keep
  // the app behind a proxy that overwrites the header.
  //
  // `TRUSTED_PROXY_COUNT` is the alternative form: trust exactly N hops from
  // the socket. Use it when the proxy chain length is fixed and known, which is
  // the usual case for a single nginx in front of the app.
  TRUSTED_PROXIES: z.string().default(""),
  TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).max(10).optional(),

  // --- EVM networks -------------------------------------------------------
  ETHEREUM_RPC_URL: z.string().url().optional(),
  // Sepolia (11155111) for the current dev/testnet pilot phase — the
  // frontend signs ETH transfers on Sepolia (lib/signing/evm.ts) and the
  // external-transfer tamper check compares signatures against this value.
  // At mainnet go-live, set ETHEREUM_CHAIN_ID=1 in the environment; no code
  // change is needed, every consumer reads this config.
  ETHEREUM_CHAIN_ID: z.coerce.number().int().positive().default(11155111),
  BSC_CHAIN_ID: z.coerce.number().int().positive().optional(),
  BASE_CHAIN_ID: z.coerce.number().int().positive().optional(),
  POLYGON_CHAIN_ID: z.coerce.number().int().positive().optional(),
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

  // --- ERC-20 tokens -----------------------------------------------------
  // Optional JSON array that ADDS or OVERRIDES registry entries. The built-in
  // table (src/chains/tokens/registry.ts) already covers the verified
  // mainnet/testnet USDC and USDT deployments. Use this to add a network the
  // registry does not know, or to correct one.
  //   [{ "chain":"ETH", "chainId":11155111, "symbol":"USDT",
  //      "address":"0x...", "decimals":6, "name":"Tether USD" }]
  // A malformed value is logged and ignored, never fatal.
  ERC20_TOKEN_CONFIG: z.string().optional(),

  // --- Email / OTP verification ------------------------------------------
  EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS).default("resend"),
  // Shared envelope sender. Provider-specific overrides (SENDGRID_FROM_EMAIL)
  // win when present because some providers reject unverified domains.
  EMAIL_FROM: z.string().min(3, "EMAIL_FROM is required (e.g. no-reply@ulmara.app)").default("no-reply@ulmara.app"),
  EMAIL_FROM_NAME: z.string().default("Ulmara"),
  RESEND_API_KEY: z.string().min(1).optional(),
  SENDGRID_API_KEY: z.string().min(1).optional(),
  SENDGRID_FROM_EMAIL: z.string().email().optional(),
  AWS_SES_REGION: z.string().min(1).optional(),
  AWS_SES_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SES_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  // Codes live in Redis for OTP_TTL_SECONDS. The stored record is retained
  // this long past expiry purely so a late submit can be told "expired"
  // rather than the less useful "invalid code".
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  OTP_EXPIRY_GRACE_SECONDS: z.coerce.number().int().positive().default(3600),
  // Wrong-code budget per issued code; guards the 6-digit space.
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // --- Error tracking / monitoring ---------------------------------------
  // All optional: with SENTRY_DSN unset the app logs normally and never
  // attempts to reach Sentry.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  SENTRY_PROFILES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_DEBUG: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Bearer token guarding the operational endpoints (/health/details,
  // /internal/queues). Optional: unset means those endpoints 404 in
  // production and stay open in dev.
  INTERNAL_API_TOKEN: z.string().min(16).optional(),
  // Serve the generated OpenAPI document and Swagger UI at /docs. Ignored in
  // production regardless of this value: an unauthenticated route inventory is
  // reconnaissance. See src/utils/openapi.ts.
  ENABLE_API_DOCS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Structured queue-depth log cadence (ms). 0 disables the periodic log.
  QUEUE_DEPTH_LOG_INTERVAL_MS: z.coerce.number().int().min(0).default(300_000),

  // --- NGN fiat ramp -----------------------------------------------------
  RAMP_PROVIDER: z.enum(RAMP_PROVIDERS).default("bitnob"),
  // Bitnob: dashboard -> Settings > API Keys. The pair is a CLIENT ID and a
  // CLIENT SECRET (HMAC request signing), not a bearer token; the dashboard
  // shows the id as "API key".
  BITNOB_BASE_URL: z.string().url().default("https://api.bitnob.com"),
  BITNOB_API_KEY: z.string().min(1).optional(),
  BITNOB_CLIENT_SECRET: z.string().min(1).optional(),
  // Separate from the client secret: used only to verify x-bitnob-signature.
  BITNOB_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Yellow Card: dashboard -> Developers. Sandbox base URL is
  // https://sandbox.api.yellowcard.io.
  YELLOW_CARD_BASE_URL: z.string().url().default("https://api.yellowcard.io"),
  YELLOW_CARD_API_KEY: z.string().min(1).optional(),
  YELLOW_CARD_API_SECRET: z.string().min(1).optional(),
  // Applied to both providers unless they advertise their own limits.
  RAMP_MIN_NGN: z.coerce.number().int().positive().default(1_000),
  RAMP_MAX_NGN: z.coerce.number().int().positive().default(5_000_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;

/**
 * Fails loudly at boot when production verification is switched on but the
 * selected email provider has no credentials. A missing key would otherwise
 * surface as a confusing 502 on the user's first "send code" tap.
 *
 * Only enforced in production: development may legitimately run with
 * DEV_VERIFICATION_MODE=true and no provider at all.
 */
export function assertEmailProviderConfigured(): void {
  if (env.NODE_ENV !== "production") return;
  if (env.DEV_VERIFICATION_MODE) return;

  const missing: string[] = [];
  switch (env.EMAIL_PROVIDER) {
    case "resend":
      if (!env.RESEND_API_KEY) missing.push("RESEND_API_KEY");
      break;
    case "sendgrid":
      if (!env.SENDGRID_API_KEY) missing.push("SENDGRID_API_KEY");
      break;
    case "ses":
      if (!env.AWS_SES_REGION) missing.push("AWS_SES_REGION");
      if (!env.AWS_SES_ACCESS_KEY_ID) missing.push("AWS_SES_ACCESS_KEY_ID");
      if (!env.AWS_SES_SECRET_ACCESS_KEY) missing.push("AWS_SES_SECRET_ACCESS_KEY");
      break;
  }

  if (missing.length > 0) {
    throw new Error(
      `EMAIL_PROVIDER=${env.EMAIL_PROVIDER} is selected for production but is missing required ` +
        `credentials: ${missing.join(", ")}. Set them in the environment, switch EMAIL_PROVIDER, ` +
        `or set DEV_VERIFICATION_MODE=true only for a non-production environment.`,
    );
  }
}

/** Same fail-loud rule for the selected NGN ramp provider. */
export function assertRampProviderConfigured(): void {
  if (env.NODE_ENV !== "production") return;
  const missing =
    env.RAMP_PROVIDER === "bitnob"
      ? (["BITNOB_API_KEY", "BITNOB_CLIENT_SECRET", "BITNOB_WEBHOOK_SECRET"] as const).filter(
          (key) => !env[key],
        )
      : (["YELLOW_CARD_API_KEY", "YELLOW_CARD_API_SECRET"] as const).filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(
      `RAMP_PROVIDER=${env.RAMP_PROVIDER} is selected for production but is missing required ` +
        `credentials: ${missing.join(", ")}. Set them in the environment or switch RAMP_PROVIDER.`,
    );
  }
}
