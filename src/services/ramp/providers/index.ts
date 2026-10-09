import { env } from "../../../config/env.js";
import { createBitnobProvider, BITNOB_WEBHOOK_SIGNATURE_HEADER } from "./bitnob.provider.js";
import {
  createYellowCardProvider,
  YELLOWCARD_WEBHOOK_SIGNATURE_HEADER,
} from "./yellowcard.provider.js";
import { RampProviderError, type RampProvider } from "./types.js";

/**
 * Provider selection. RAMP_PROVIDER picks the adapter; nothing else in the
 * codebase branches on which provider is live.
 */
export function getRampProviderName(): string {
  return env.RAMP_PROVIDER;
}

/** Header each provider signs its webhooks with. */
export function getRampWebhookSignatureHeader(): string {
  return env.RAMP_PROVIDER === "bitnob"
    ? BITNOB_WEBHOOK_SIGNATURE_HEADER
    : YELLOWCARD_WEBHOOK_SIGNATURE_HEADER;
}

export function isRampProviderConfigured(): boolean {
  try {
    getRampProvider();
    return true;
  } catch {
    return false;
  }
}

let cached: RampProvider | null = null;

/** Test seam: forces the next getRampProvider() to rebuild. */
export function resetRampProviderCache(): void {
  cached = null;
}

export function getRampProvider(): RampProvider {
  if (cached) return cached;

  switch (env.RAMP_PROVIDER) {
    case "bitnob":
      // Bitnob authenticates with a client id + secret pair (not a bearer
      // token), and needs a separate webhook secret.
      cached = createBitnobProvider({
        clientId: env.BITNOB_API_KEY ?? "",
        clientSecret: env.BITNOB_CLIENT_SECRET ?? "",
        webhookSecret: env.BITNOB_WEBHOOK_SECRET ?? "",
        baseUrl: env.BITNOB_BASE_URL,
      });
      break;
    case "yellowcard":
      cached = createYellowCardProvider({
        apiKey: env.YELLOW_CARD_API_KEY ?? "",
        secretKey: env.YELLOW_CARD_API_SECRET ?? "",
        baseUrl: env.YELLOW_CARD_BASE_URL,
      });
      break;
    default: {
      // `env.RAMP_PROVIDER` is a zod enum, so the switch above narrows it to
      // `never` by the time control reaches `default` — a runtime guard for a
      // value the type system says cannot exist. Re-reading it as a plain
      // `string` keeps the offending value in the error message instead of
      // printing an unhelpfully empty one.
      const selected: string = env.RAMP_PROVIDER;
      throw new RampProviderError("unknown", "unsupported_provider", `Unsupported RAMP_PROVIDER: ${selected}`);
    }
  }
  return cached;
}

export * from "./types.js";
