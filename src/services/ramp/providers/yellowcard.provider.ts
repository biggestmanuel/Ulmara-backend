import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  RampProviderError,
  providerErrorMessage,
  type CreateDepositInput,
  type CreateWithdrawalInput,
  type RampCustomer,
  type RampInstruction,
  type RampProvider,
  type RampStatusCanonical,
  type RampStatusResult,
  type RampWebhookEvent,
} from "./types.js";

/**
 * Yellow Card adapter.
 *
 * Shaped around Yellow Card's public Payments API as documented at
 * https://docs.yellowcard.engineering (Authentication, Webhooks, Sends and
 * Receives references).
 *
 *  - Base URL ......... https://api.yellowcard.io  (sandbox: sandbox.api....)
 *  - Request auth ..... per-request HMAC-SHA256:
 *      signed   = ISO8601Timestamp + path + UPPERCASED_METHOD
 *                 + base64(sha256(JSON.stringify(body)))   [body only when present]
 *      headers  = X-YC-Timestamp: <ISO 8601>
 *                 Authorization: YcHmacV1 <apiKey>:<base64(signature)>
 *  - Webhooks ......... header `X-YC-Signature` =
 *      base64(HMAC-SHA256(secretKey, requestBody))
 *      and the body's `apiKey` must equal our configured key.
 *      envelope = { id, sequenceId, status, event, errorCode, executedAt, ... }
 *      Events are UPPER-case and prefixed: RECEIVE.* (fiat in / deposit),
 *      SEND.* (fiat out / withdrawal), CONVERT.*, CRYPTO_SEND.*, CUSTODY.*.
 *
 * Flow mapping:
 *  - DEPOSIT    -> Submit Receive Request; the response carries `bankInfo`
 *                 (account number to pay into) and/or a `redirectUrl`.
 *  - WITHDRAWAL -> Submit Send Request with the Nigerian bank destination.
 *  - `sequenceId` is the partner reference and is echoed on every status
 *    lookup and webhook, so it is the correlation key end to end.
 */

export const YELLOWCARD_WEBHOOK_SIGNATURE_HEADER = "x-yc-signature";
export const YELLOWCARD_WEBHOOK_TIMESTAMP_HEADER = "x-yc-timestamp";

/**
 * Yellow Card's transaction `status` vocabulary (lower case), mapped onto the
 * canonical set. Covers both the v2 SEND and RECEIVE event prefixes and the
 * legacy PAYMENT and COLLECTION prefixes still emitted during migration.
 */
const STATUS_MAP: Record<string, RampStatusCanonical> = {
  // Receive (on-ramp / deposit)
  received: "COMPLETED",
  complete: "COMPLETED",
  success: "COMPLETED",
  succeeded: "COMPLETED",
  // Send (off-ramp / withdrawal)
  sent: "COMPLETED",
  // In flight
  pending: "PENDING",
  pending_approval: "PENDING",
  pending_provider: "PROCESSING",
  pending_liquidity: "PROCESSING",
  processing: "PROCESSING",
  // Terminal failures
  failed: "FAILED",
  rejected: "FAILED",
  refused: "FAILED",
  cancelled: "FAILED",
  canceled: "FAILED",
  expired: "FAILED",
  expired_quote: "FAILED",
  denied: "FAILED",
  insufficient_funds: "FAILED",
};

function mapStatus(raw: string | undefined): RampStatusCanonical {
  if (!raw) return "PENDING";
  return STATUS_MAP[raw.toLowerCase()] ?? "PENDING";
}

export interface YellowCardConfig {
  apiKey: string;
  secretKey: string;
  baseUrl: string;
  timeoutMs?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

/** Builds the X-YC-Timestamp / Authorization pair for one request. */
export function buildYellowCardAuthHeaders(
  config: Pick<YellowCardConfig, "apiKey" | "secretKey" | "now">,
  path: string,
  method: string,
  body?: unknown,
): Record<string, string> {
  const timestamp = (config.now?.() ?? new Date()).toISOString();
  const hmac = createHmac("sha256", config.secretKey);
  hmac.update(timestamp, "utf8");
  hmac.update(path, "utf8");
  hmac.update(method.toUpperCase(), "utf8");
  if (body !== undefined && body !== null) {
    const bodyHash = createHash("sha256").update(JSON.stringify(body), "utf8").digest("base64");
    hmac.update(bodyHash, "utf8");
  }
  const signature = hmac.digest("base64");
  return {
    "content-type": "application/json",
    "X-YC-Timestamp": timestamp,
    Authorization: `YcHmacV1 ${config.apiKey}:${signature}`,
  };
}

/** base64(HMAC-SHA256(secretKey, rawBody)) — matches X-YC-Signature. */
export function signYellowCardWebhook(secretKey: string, rawBody: string | Buffer): string {
  return createHmac("sha256", secretKey).update(rawBody).digest("base64");
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

interface YellowCardTransaction {
  id: string;
  sequenceId?: string;
  status?: string;
  localAmount?: number;
  localCurrency?: string;
  usdAmount?: number;
  reason?: string;
  error?: string;
  errorCode?: string;
  bankInfo?: { accountNumber?: string; bankName?: string; accountName?: string };
  redirectUrl?: string;
  event?: string;
  apiKey?: string;
  executedAt?: string;
}

export function createYellowCardProvider(config: YellowCardConfig): RampProvider {
  if (!config.apiKey || !config.secretKey) {
    throw new RampProviderError(
      "yellowcard",
      "missing_credentials",
      "YELLOW_CARD_API_KEY and YELLOW_CARD_API_SECRET are required",
    );
  }

  const base = config.baseUrl.replace(/\/$/, "");
  const timeoutMs = config.timeoutMs ?? 15_000;
  const doFetch = config.fetchImpl ?? fetch;

  async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: buildYellowCardAuthHeaders(config, path, method, body),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = (err as { name?: string })?.name === "AbortError" ? "timeout" : "network_error";
      throw new RampProviderError("yellowcard", reason, `Yellow Card ${method} ${path} failed (${reason})`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      throw new RampProviderError(
        "yellowcard",
        "api_error",
        providerErrorMessage(parsed, `Yellow Card ${method} ${path} failed with status ${response.status}`),
        response.status,
      );
    }
    return (parsed ?? {}) as T;
  }

  return {
    name: "yellowcard",

    // Not `async`: there is no I/O to await, and the interface only requires a
    // `Promise<RampCustomer>` return type. `async` here would allocate a
    // promise for nothing.
    createCustomer(input: { email: string; name?: string; reference: string }): Promise<RampCustomer> {
      // Yellow Card identifies end users by the partner-supplied sequenceId
      // on each transaction, so there is no separate customer resource to
      // create; the reference is the stable identity.
      return Promise.resolve({ providerCustomerId: input.reference, email: input.email, name: input.name });
    },

    async createDeposit(input: CreateDepositInput): Promise<RampInstruction> {
      const data = await request<YellowCardTransaction>("/business/transactions", "POST", {
        sequenceId: input.reference,
        localAmount: Number(input.amountNgn),
        localCurrency: "NGN",
        countryCode: "NG",
        // `reason` is echoed on the webhook and shown to the payer.
        reason: "Ulmara wallet top-up",
        endUserId: input.customer.providerCustomerId,
        // Yellow Card returns instructions for the payer in the response.
        type: "receive",
      });
      return {
        reference: input.reference,
        providerReference: data.id,
        status: mapStatus(data.status),
        paymentInstructions: {
          accountNumber: data.bankInfo?.accountNumber,
          bankName: data.bankInfo?.bankName,
          accountName: data.bankInfo?.accountName,
          amountNgn: input.amountNgn,
          checkoutUrl: data.redirectUrl,
        },
        raw: data,
      };
    },

    async createWithdrawal(input: CreateWithdrawalInput): Promise<RampInstruction> {
      const data = await request<YellowCardTransaction>("/business/transactions/send", "POST", {
        sequenceId: input.reference,
        localAmount: Number(input.amountNgn),
        localCurrency: "NGN",
        countryCode: "NG",
        reason: "Ulmara wallet withdrawal",
        endUserId: input.customer.providerCustomerId,
        destination: {
          type: "bank",
          accountNumber: input.bankAccount.accountNumber,
          bankCode: input.bankAccount.bankCode,
          accountName: input.bankAccount.accountName,
          countryCode: "NG",
        },
      });
      return {
        reference: input.reference,
        providerReference: data.id,
        status: mapStatus(data.status),
        raw: data,
      };
    },

    async getStatus(reference: string): Promise<RampStatusResult> {
      // Yellow Card exposes a dedicated lookup by the partner sequenceId.
      const data = await request<YellowCardTransaction>(
        `/business/transactions/sequence/${encodeURIComponent(reference)}`,
        "GET",
      );
      if (!data?.id) {
        throw new RampProviderError("yellowcard", "not_found", `No Yellow Card transaction for reference ${reference}`, 404);
      }
      return {
        reference,
        providerReference: data.id,
        status: mapStatus(data.status),
        amountNgn:
          data.localAmount !== undefined
            ? String(data.localAmount)
            : data.localCurrency === "NGN" && data.usdAmount !== undefined
              ? String(data.usdAmount)
              : "0",
        failureReason: data.error ?? data.reason,
        raw: data,
      };
    },

    verifyWebhookSignature(rawBody: string | Buffer, signature: string | undefined): boolean {
      if (!signature) return false;
      // Verify the exact bytes we received. Yellow Card's own example
      // re-stringifies the parsed body, which is only equivalent when the
      // sender's key order matches; the raw body is always correct.
      const expected = signYellowCardWebhook(config.secretKey, rawBody);
      if (constantTimeEquals(expected, signature.trim())) return true;
      // Tolerance path for a sender that re-serialised with different spacing.
      try {
        const reparsed = JSON.stringify(JSON.parse(rawBody.toString("utf8")));
        return constantTimeEquals(signYellowCardWebhook(config.secretKey, reparsed), signature.trim());
      } catch {
        return false;
      }
    },

    parseWebhook(rawBody: string | Buffer, _headers: Record<string, string | string[] | undefined>): RampWebhookEvent {
      let parsed: YellowCardTransaction;
      try {
        parsed = JSON.parse(rawBody.toString("utf8")) as YellowCardTransaction;
      } catch {
        throw new RampProviderError("yellowcard", "invalid_payload", "Yellow Card webhook body is not valid JSON");
      }
      // The payload names the apiKey the signature was generated with; a
      // mismatch means the event belongs to a different integration.
      if (parsed.apiKey && parsed.apiKey !== config.apiKey) {
        throw new RampProviderError("yellowcard", "api_key_mismatch", "Yellow Card webhook apiKey does not match ours");
      }
      if (!parsed.event) {
        throw new RampProviderError("yellowcard", "invalid_payload", "Yellow Card webhook is missing the `event` field");
      }

      // SEND.* is a fiat payout, RECEIVE.* is a fiat collection; CRYPTO_*/CONVERT.*
      // are not NGN ramp legs and are surfaced as-is so business logic can ignore them.
      const direction = parsed.event.startsWith("SEND.")
        ? "WITHDRAWAL"
        : parsed.event.startsWith("RECEIVE.")
          ? "DEPOSIT"
          : "UNKNOWN";

      return {
        type: parsed.event,
        reference: parsed.sequenceId ?? "",
        status: mapStatus(parsed.status ?? parsed.event.split(".")[1]),
        amountNgn: parsed.localAmount !== undefined ? String(parsed.localAmount) : undefined,
        providerReference: parsed.id,
        failureReason: mapStatus(parsed.status) === "FAILED" ? parsed.errorCode ?? parsed.error : undefined,
        // Yellow Card does not guarantee retries for custody events, but
        // payment events do redeliver; `id` is stable either way.
        eventId: parsed.id ?? parsed.sequenceId ?? parsed.event,
        raw: { ...parsed, __direction: direction },
      };
    },
  };
}
