/**
 * NGN fiat ramp provider abstraction.
 *
 * Business logic (ramp.service.ts) only ever sees these types, so switching
 * between Bitnob and Yellow Card is an `RAMP_PROVIDER` env change with no
 * business-logic edit.
 *
 * Status normalisation is the point of the abstraction: providers disagree
 * wildly about their status vocabularies, so each adapter maps its own onto
 * the small canonical set below and nothing upstream has to know the mapping.
 */

export const RAMP_TYPES = ["DEPOSIT", "WITHDRAWAL"] as const;
export type RampTypeCanonical = (typeof RAMP_TYPES)[number];

/** Canonical lifecycle. `PENDING` covers "accepted but not yet settled". */
export const RAMP_STATUSES = ["PENDING", "PROCESSING", "COMPLETED", "FAILED"] as const;
export type RampStatusCanonical = (typeof RAMP_STATUSES)[number];

export interface RampCustomer {
  /** Provider-side customer id, created once per user. */
  providerCustomerId: string;
  email: string;
  name?: string;
}

export interface CreateDepositInput {
  reference: string;
  amountNgn: string;
  customer: RampCustomer;
  /** Opaque callback URL the provider redirects/polls against. */
  returnUrl?: string;
}

export interface CreateWithdrawalInput {
  reference: string;
  amountNgn: string;
  customer: RampCustomer;
  /** Nigerian account receiving the payout. */
  bankAccount: {
    accountNumber: string;
    bankCode: string;
    accountName: string;
  };
}

export interface RampInstruction {
  reference: string;
  providerReference: string;
  status: RampStatusCanonical;
  /** Where the user should send NGN, or a shareable payload. */
  paymentInstructions?: {
    accountNumber?: string;
    bankName?: string;
    accountName?: string;
    amountNgn?: string;
    /** Provider-hosted page the client can open. */
    checkoutUrl?: string;
  };
  raw?: unknown;
}

export interface RampStatusResult {
  reference: string;
  providerReference: string;
  status: RampStatusCanonical;
  amountNgn: string;
  /** Set when the provider gave a machine-readable failure reason. */
  failureReason?: string;
  raw?: unknown;
}

/** A provider event delivered to our webhook endpoint. */
export interface RampWebhookEvent {
  /** Provider event type after mapping (e.g. "deposit.succeeded"). */
  type: string;
  reference: string;
  status: RampStatusCanonical;
  amountNgn?: string;
  providerReference?: string;
  failureReason?: string;
  /** Provider event id, used to de-duplicate redeliveries. */
  eventId: string;
  raw: unknown;
}

export class RampProviderError extends Error {
  readonly provider: string;
  readonly code: string;
  readonly statusCode: number | undefined;

  constructor(provider: string, code: string, message: string, statusCode?: number) {
    super(message);
    this.name = "RampProviderError";
    this.provider = provider;
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface RampProvider {
  readonly name: string;
  /** Creates (or reuses) the provider-side customer record for a user. */
  createCustomer(input: { email: string; name?: string; reference: string }): Promise<RampCustomer>;
  createDeposit(input: CreateDepositInput): Promise<RampInstruction>;
  createWithdrawal(input: CreateWithdrawalInput): Promise<RampInstruction>;
  getStatus(reference: string): Promise<RampStatusResult>;
  /**
   * Verifies a webhook signature over the RAW request body. Returns false
   * for any signature that does not validate — callers must reject.
   */
  verifyWebhookSignature(rawBody: string | Buffer, signature: string | undefined, timestamp?: string): boolean;
  /** Maps a verified webhook body onto a canonical event. */
  parseWebhook(rawBody: string | Buffer, headers: Record<string, string | string[] | undefined>): RampWebhookEvent;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Naira amounts are 2-decimal; reject anything the ledger cannot store.
 *
 * The comparison is done in **kobo** (integer NGN x 100) with BigInt, not in
 * NGN with a float: `Number(amount)` would round a long digit string and could
 * compare equal to a bound it is actually above. `amountNgn` is stored as
 * `Decimal(18, 2)`, so kobo is exactly the stored unit.
 */
export function assertValidNgnAmount(amount: string, min: number, max: number): void {
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
    throw Object.assign(new Error("Amount must be a positive amount with at most 2 decimals"), { statusCode: 400 });
  }
  const [whole, frac = ""] = amount.split(".");
  if (!/[1-9]/.test(whole) && !/[1-9]/.test(frac)) {
    throw Object.assign(new Error("Amount must be greater than zero"), { statusCode: 400 });
  }
  const kobo = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0") || "0");
  const minKobo = toKobo(min);
  const maxKobo = toKobo(max);
  if (kobo < minKobo) {
    throw Object.assign(new Error(`Amount must be at least ₦${min.toLocaleString("en-NG")}`), { statusCode: 400 });
  }
  if (kobo > maxKobo) {
    throw Object.assign(new Error(`Amount must be at most ₦${max.toLocaleString("en-NG")}`), { statusCode: 400 });
  }
}

/** Exact integer-NGN bound -> kobo, without going through a float. */
function toKobo(naira: number): bigint {
  const asString = naira.toFixed(0);
  return BigInt(asString) * 100n;
}

/** Extracts a usable failure message from an arbitrary provider error body. */
export function providerErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.length > 0) return body.slice(0, 300);
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "reason", "errors"]) {
      const value = record[key];
      if (typeof value === "string" && value) return value.slice(0, 300);
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
        return String(value[0]).slice(0, 300);
      }
      if (value && typeof value === "object" && typeof (value as { message?: string }).message === "string") {
        return String((value as { message: string }).message).slice(0, 300);
      }
    }
  }
  return fallback;
}
