import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
 * Bitnob adapter.
 *
 * Shaped around Bitnob's public API as documented at
 * https://docs.bitnob.com (verified against the Authentication, Payouts and
 * Webhooks references).
 *
 *  - Base URL ......... https://api.bitnob.com  (endpoints live under /api)
 *  - Request auth ..... HMAC-SHA256 per request:
 *      canonical = `${clientId}:${unixTimestampSeconds}:${nonce}:${exactJsonBody}`
 *      signature = hex(HMAC-SHA256(clientSecret, canonical))
 *      headers   = X-Auth-Client, X-Auth-Timestamp, X-Auth-Nonce, X-Auth-Signature
 *      nonce     = 16 random bytes, hex encoded
 *  - Response envelope  { success, message, data, timestamp }
 *  - Webhooks ......... header `x-bitnob-signature` =
 *      hex(HMAC-SHA512(webhookSecret, rawRequestBody))
 *      envelope  = { event, event_id, data }
 *      retries   = up to 3 with exponential backoff, dedupe on `event_id`
 *
 * Flow mapping:
 *  - DEPOSIT    (NGN -> balance)  create a Nigerian virtual account for the
 *               customer and hand the account number to the user. Completion
 *               arrives by webhook and is reconciled against
 *               GET /api/virtual-accounts/:id/transactions.
 *  - WITHDRAWAL (balance -> NGN) Payouts: quote -> initialize -> finalize.
 *               `reference` is echoed back on every payout event, which is
 *               what the idempotent webhook handler keys on.
 */

export const BITNOB_WEBHOOK_SIGNATURE_HEADER = "x-bitnob-signature";

/** Documented payout lifecycle from Get Payout (UPPER case). */
const PAYOUT_STATUS_MAP: Record<string, RampStatusCanonical> = {
  QUOTE: "PENDING",
  INITIATED: "PENDING",
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  SUCCESS: "COMPLETED",
  FAILED: "FAILED",
  EXPIRED: "FAILED",
};

/**
 * `data.status` on a payout webhook is the lower-case EVENT outcome, not the
 * record lifecycle (documented explicitly by Bitnob). Mapping the event name
 * is therefore authoritative, and `data.status` is only a fallback.
 */
const PAYOUT_EVENT_MAP: Record<string, RampStatusCanonical> = {
  "payouts.initialized": "PENDING",
  "payouts.processing": "PROCESSING",
  "payouts.withdrawal.success": "COMPLETED",
  "payouts.withdrawal.expired": "FAILED",
  // Legacy names (Bitnob deprecated these in July 2026 but still emits them
  // during a merchant's transition window).
  "payout.transfer.success": "COMPLETED",
  "payout.transfer.failed": "FAILED",
  "payout.initiated": "PENDING",
  "payout.processing": "PROCESSING",
};

/**
 * NGN credits into a virtual account. Bitnob documents the webhook mechanism
 * and the `GET /api/virtual-accounts/:id/transactions` reconciliation
 * endpoint; the exact event names below are matched loosely and the
 * authoritative state always comes from the status lookup, so an unlisted
 * event name degrades to "look it up" rather than to a wrong status.
 */
const DEPOSIT_EVENT_MAP: Record<string, RampStatusCanonical> = {
  "transaction.successful": "COMPLETED",
  "charge.success": "COMPLETED",
  "transaction.success": "COMPLETED",
  "virtualaccount.receive.success": "COMPLETED",
  "transaction.failed": "FAILED",
  "charge.failed": "FAILED",
  "virtualaccount.receive.failed": "FAILED",
  "transaction.pending": "PENDING",
  "transaction.processing": "PROCESSING",
};

export interface BitnobConfig {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  baseUrl: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

/** Builds the four X-Auth-* headers for one request. */
export function buildBitnobAuthHeaders(
  config: Pick<BitnobConfig, "clientId" | "clientSecret" | "now">,
  body: string,
): Record<string, string> {
  const now = config.now?.() ?? new Date();
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  const canonical = `${config.clientId}:${timestamp}:${nonce}:${body}`;
  const signature = createHmac("sha256", config.clientSecret).update(canonical, "utf8").digest("hex");
  return {
    "content-type": "application/json",
    "X-Auth-Client": config.clientId,
    "X-Auth-Timestamp": timestamp,
    "X-Auth-Nonce": nonce,
    "X-Auth-Signature": signature,
  };
}

/** hex(HMAC-SHA512(secret, rawBody)) — the value Bitnob puts in x-bitnob-signature. */
export function signBitnobWebhook(secret: string, rawBody: string | Buffer): string {
  return createHmac("sha512", secret).update(rawBody).digest("hex");
}

/** Constant-time string comparison for signature verification. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

interface BitnobEnvelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
  timestamp?: string;
}

interface BitnobCustomer {
  id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
}

interface BitnobVirtualAccount {
  id: string;
  account_number: string;
  bank_name?: string;
  account_name?: string;
  reference?: string;
  currency?: string;
}

interface BitnobPayout {
  id: string;
  quote_id?: string;
  status?: string;
  reference?: string;
  from_asset?: string;
  to_currency?: string;
  amount?: string;
  settlement_amount?: string;
  fees?: string;
  beneficiary?: { account_number?: string; bank_code?: string; country?: string };
}

export function createBitnobProvider(config: BitnobConfig): RampProvider {
  if (!config.clientId || !config.clientSecret) {
    throw new RampProviderError("bitnob", "missing_credentials", "BITNOB_CLIENT_ID and BITNOB_CLIENT_SECRET are required");
  }
  if (!config.webhookSecret) {
    throw new RampProviderError("bitnob", "missing_webhook_secret", "BITNOB_WEBHOOK_SECRET is required to verify webhooks");
  }

  const base = config.baseUrl.replace(/\/$/, "");
  const timeoutMs = config.timeoutMs ?? 15_000;
  const doFetch = config.fetchImpl ?? fetch;

  async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: buildBitnobAuthHeaders(config, payload),
        body: method === "GET" ? undefined : payload,
        signal: controller.signal,
      });
    } catch (err) {
      const reason = (err as { name?: string })?.name === "AbortError" ? "timeout" : "network_error";
      throw new RampProviderError("bitnob", reason, `Bitnob ${method} ${path} failed (${reason})`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: BitnobEnvelope<T> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as BitnobEnvelope<T>) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok || parsed?.success === false) {
      throw new RampProviderError(
        "bitnob",
        "api_error",
        providerErrorMessage(parsed ?? text, `Bitnob ${method} ${path} failed with status ${response.status}`),
        response.status,
      );
    }
    if (parsed?.data === undefined) {
      throw new RampProviderError("bitnob", "invalid_response", `Bitnob ${method} ${path} returned no data envelope`);
    }
    return parsed.data;
  }

  return {
    name: "bitnob",

    async createCustomer(input: { email: string; name?: string; reference: string }): Promise<RampCustomer> {
      // Bitnob requires a BVN-backed identity before it will issue a NGN
      // virtual account; we forward what the caller collected and let Bitnob
      // name every missing field in one error.
      const [firstName, ...rest] = (input.name ?? "").trim().split(/\s+/);
      const data = await request<BitnobCustomer>("/api/customers", "POST", {
        first_name: firstName || undefined,
        last_name: rest.join(" ") || undefined,
        email: input.email,
        reference: input.reference,
        type: "individual",
      });
      return { providerCustomerId: data.id, email: data.email ?? input.email, name: input.name };
    },

    async createDeposit(input: CreateDepositInput): Promise<RampInstruction> {
      // `reference` is Bitnob's idempotency key for this endpoint, so a
      // retried deposit returns the same account rather than a second one.
      const account = await request<BitnobVirtualAccount>("/api/virtual-accounts", "POST", {
        customer_id: input.customer.providerCustomerId,
        reference: input.reference,
        preferred_bank: undefined,
      });
      return {
        reference: input.reference,
        providerReference: account.id,
        status: "PENDING",
        paymentInstructions: {
          accountNumber: account.account_number,
          bankName: account.bank_name,
          accountName: account.account_name,
          amountNgn: input.amountNgn,
        },
        raw: account,
      };
    },

    async createWithdrawal(input: CreateWithdrawalInput): Promise<RampInstruction> {
      const quote = await request<BitnobPayout>("/api/payouts/quotes", "POST", {
        source: "OFFCHAIN",
        from_asset: "USDT",
        to_currency: "ngn",
        amount: input.amountNgn,
        country: "NG",
        reference: input.reference,
      });

      // A quote is not a payout. The payout only exists after initialize, and
      // funds only move after finalize.
      const initialized = await request<BitnobPayout>(`/api/payouts/${quote.id}/initialize`, "POST", {
        beneficiary: {
          account_number: input.bankAccount.accountNumber,
          bank_code: input.bankAccount.bankCode,
          account_name: input.bankAccount.accountName,
          country: "NG",
        },
        reference: input.reference,
        payment_reason: "Crypto offramp",
      });

      const finalized = await request<BitnobPayout>(`/api/payouts/${initialized.id}/finalize`, "POST", {
        reference: input.reference,
      });

      const payout = { ...initialized, ...finalized };
      return {
        reference: input.reference,
        providerReference: payout.id,
        status: mapPayoutStatus(payout.status),
        paymentInstructions: undefined,
        raw: payout,
      };
    },

    async getStatus(reference: string): Promise<RampStatusResult> {
      // Bitnob has no "lookup by our reference" endpoint for a single payout,
      // so list and filter. Paginated defensively.
      let result: BitnobPayout | null = null;
      for (let page = 1; page <= 5 && !result; page++) {
        const data = await request<{ data?: BitnobPayout[] } | BitnobPayout[]>(
          `/api/payouts?reference=${encodeURIComponent(reference)}&page=${page}`,
          "GET",
        );
        const items = Array.isArray(data) ? data : (data?.data ?? []);
        result = items.find((p) => p.reference === reference) ?? null;
      }
      if (!result) {
        throw new RampProviderError("bitnob", "not_found", `No Bitnob payout found for reference ${reference}`, 404);
      }
      return {
        reference,
        providerReference: result.id,
        status: mapPayoutStatus(result.status),
        amountNgn: result.settlement_amount ?? result.amount ?? "0",
        raw: result,
      };
    },

    verifyWebhookSignature(rawBody: string | Buffer, signature: string | undefined): boolean {
      if (!signature) return false;
      const expected = signBitnobWebhook(config.webhookSecret, rawBody);
      return constantTimeEquals(expected, signature.trim().toLowerCase());
    },

    parseWebhook(rawBody: string | Buffer, _headers: Record<string, string | string[] | undefined>): RampWebhookEvent {
      let parsed: { event?: string; event_id?: string; data?: Record<string, unknown> };
      try {
        parsed = JSON.parse(rawBody.toString("utf8")) as typeof parsed;
      } catch {
        throw new RampProviderError("bitnob", "invalid_payload", "Bitnob webhook body is not valid JSON");
      }
      const event = parsed.event;
      if (!event) {
        throw new RampProviderError("bitnob", "invalid_payload", "Bitnob webhook is missing the `event` field");
      }
      const data = (parsed.data ?? {});

      const status =
        PAYOUT_EVENT_MAP[event] ??
        DEPOSIT_EVENT_MAP[event] ??
        // Unknown event: fall back to the lower-case outcome Bitnob puts in
        // data.status so an unlisted event still moves the row sensibly.
        mapPayoutStatus(typeof data.status === "string" ? data.status.toUpperCase() : undefined);

      const reference =
        typeof data.reference === "string" && data.reference
          ? data.reference
          : typeof data.order_id === "string"
            ? data.order_id
            : "";

      return {
        type: event,
        reference,
        status,
        amountNgn: typeof data.settlement_amount === "string" ? data.settlement_amount : undefined,
        providerReference: typeof data.id === "string" ? data.id : undefined,
        failureReason:
          typeof data.payment_reason === "string" && status === "FAILED"
            ? data.payment_reason
            : typeof data.failure_reason === "string"
              ? data.failure_reason
              : undefined,
        // Bitnob guarantees a stable event_id across retries; it is the
        // de-duplication key.
        eventId: parsed.event_id ?? `${event}:${reference}`,
        raw: parsed,
      };
    },
  };

  function mapPayoutStatus(status: string | undefined): RampStatusCanonical {
    if (!status) return "PENDING";
    return PAYOUT_STATUS_MAP[status.toUpperCase()] ?? "PENDING";
  }
}
