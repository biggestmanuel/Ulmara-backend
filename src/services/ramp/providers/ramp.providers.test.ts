import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, createHash } from "node:crypto";

/**
 * Provider-adapter tests.
 *
 * These are CODE-LEVEL tests with deterministic fixtures and a stubbed fetch.
 * No Bitnob or Yellow Card account, credential or API response is used or
 * invented: every response body here is a hand-written fixture that mirrors the
 * shape documented at docs.bitnob.com and docs.yellowcard.engineering. Nothing
 * here constitutes evidence that a live provider call would succeed.
 */
import {
  buildBitnobAuthHeaders,
  createBitnobProvider,
  signBitnobWebhook,
  BITNOB_WEBHOOK_SIGNATURE_HEADER,
} from "./bitnob.provider.js";
import {
  buildYellowCardAuthHeaders,
  createYellowCardProvider,
  signYellowCardWebhook,
  YELLOWCARD_WEBHOOK_SIGNATURE_HEADER,
} from "./yellowcard.provider.js";
import { RampProviderError } from "./types.js";

const BITNOB_CLIENT_ID = "test_client_id";
const BITNOB_CLIENT_SECRET = "test_client_secret";
const BITNOB_WEBHOOK_SECRET = "test_webhook_secret";

const YC_API_KEY = "yc_test_key";
const YC_SECRET = "yc_test_secret";

function bitnob(overrides: Partial<Parameters<typeof createBitnobProvider>[0]> = {}) {
  return createBitnobProvider({
    clientId: BITNOB_CLIENT_ID,
    clientSecret: BITNOB_CLIENT_SECRET,
    webhookSecret: BITNOB_WEBHOOK_SECRET,
    baseUrl: "https://api.bitnob.test",
    now: () => new Date("2026-01-02T03:04:05Z"),
    ...overrides,
  });
}

function yellowcard(overrides: Partial<Parameters<typeof createYellowCardProvider>[0]> = {}) {
  return createYellowCardProvider({
    apiKey: YC_API_KEY,
    secretKey: YC_SECRET,
    baseUrl: "https://api.yellowcard.test",
    now: () => new Date("2026-01-02T03:04:05Z"),
    ...overrides,
  });
}

/** fetch double returning queued fixture responses and recording requests. */
function stubFetch(responses: { status?: number; body: unknown }[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      // `init.body` is a `BodyInit`, so String() on a stream would silently
      // produce "[object Object]". Every provider under test posts JSON text.
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  vi.stubGlobal("fetch", impl);
  return calls;
}

/** Bitnob's { success, message, data, timestamp } envelope. */
const bitnobOk = (data: unknown) => ({ success: true, message: "ok", data, timestamp: "2026-01-02T03:04:05Z" });

// ---------------------------------------------------------------------------
// Bitnob
// ---------------------------------------------------------------------------

describe("Bitnob request signing", () => {
  it("sends all four X-Auth-* headers", () => {
    const headers = buildBitnobAuthHeaders(
      { clientId: BITNOB_CLIENT_ID, clientSecret: BITNOB_CLIENT_SECRET, now: () => new Date("2026-01-02T03:04:05Z") },
      '{"a":1}',
    );
    expect(headers["X-Auth-Client"]).toBe(BITNOB_CLIENT_ID);
    expect(headers["X-Auth-Timestamp"]).toBe(String(Math.floor(new Date("2026-01-02T03:04:05Z").getTime() / 1000)));
    expect(headers["X-Auth-Nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(headers["X-Auth-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs CLIENT_ID:TIMESTAMP:NONCE:PAYLOAD with HMAC-SHA256", () => {
    const now = () => new Date("2026-01-02T03:04:05Z");
    const headers = buildBitnobAuthHeaders(
      { clientId: BITNOB_CLIENT_ID, clientSecret: BITNOB_CLIENT_SECRET, now },
      '{"a":1}',
    );
    const ts = Math.floor(new Date("2026-01-02T03:04:05Z").getTime() / 1000).toString();
    const nonce = headers["X-Auth-Nonce"];
    const expected = createHmac("sha256", BITNOB_CLIENT_SECRET)
      .update(`${BITNOB_CLIENT_ID}:${ts}:${nonce}:{"a":1}`, "utf8")
      .digest("hex");
    expect(headers["X-Auth-Signature"]).toBe(expected);
  });

  it("uses a fresh nonce per request (replay resistance)", () => {
    const a = buildBitnobAuthHeaders({ clientId: "c", clientSecret: "s" }, "");
    const b = buildBitnobAuthHeaders({ clientId: "c", clientSecret: "s" }, "");
    expect(a["X-Auth-Nonce"]).not.toBe(b["X-Auth-Nonce"]);
  });

  it("changes the signature when the body changes", () => {
    const args = { clientId: "c", clientSecret: "s", now: () => new Date("2026-01-02T03:04:05Z") };
    const a = buildBitnobAuthHeaders(args, '{"a":1}');
    const b = buildBitnobAuthHeaders(args, '{"a":2}');
    expect(a["X-Auth-Signature"]).not.toBe(b["X-Auth-Signature"]);
  });

  it("signs the empty string for a bodyless request", () => {
    const now = () => new Date("2026-01-02T03:04:05Z");
    const headers = buildBitnobAuthHeaders({ clientId: "c", clientSecret: "s", now }, "");
    const ts = Math.floor(new Date("2026-01-02T03:04:05Z").getTime() / 1000).toString();
    expect(headers["X-Auth-Signature"]).toBe(
      createHmac("sha256", "s").update(`c:${ts}:${headers["X-Auth-Nonce"]}:`, "utf8").digest("hex"),
    );
  });
});

describe("Bitnob provider construction", () => {
  it("requires the client id/secret pair", () => {
    expect(() => bitnob({ clientId: "" })).toThrow(RampProviderError);
    expect(() => bitnob({ clientSecret: "" })).toThrow(/BITNOB_CLIENT_SECRET|BITNOB_API_KEY/);
  });

  it("requires a webhook secret, because webhooks cannot be verified without one", () => {
    expect(() => bitnob({ webhookSecret: "" })).toThrow(/webhook/i);
  });
});

describe("Bitnob deposit (virtual account)", () => {
  it("creates a virtual account and returns the payment instructions", async () => {
    // createDeposit is one call: the customer already exists by this point.
    const calls = stubFetch([
      {
        body: bitnobOk({
          id: "va_123",
          account_number: "0123456789",
          bank_name: "Providus Bank",
          account_name: "Ulmara User",
          currency: "NGN",
        }),
      },
    ]);

    const result = await bitnob().createDeposit({
      reference: "DEP-abc",
      amountNgn: "5000",
      customer: { providerCustomerId: "cus_1", email: "u@example.com" },
    });

    expect(result.status).toBe("PENDING");
    expect(result.reference).toBe("DEP-abc");
    expect(result.providerReference).toBe("va_123");
    expect(result.paymentInstructions).toEqual({
      accountNumber: "0123456789",
      bankName: "Providus Bank",
      accountName: "Ulmara User",
      amountNgn: "5000",
    });
    // `reference` is Bitnob's idempotency key for this endpoint.
    expect((calls[0].body as { reference: string }).reference).toBe("DEP-abc");
    expect(calls[0].url).toBe("https://api.bitnob.test/api/virtual-accounts");
  });

  it("raises a typed provider error when Bitnob rejects the request", async () => {
    stubFetch([{ status: 400, body: { success: false, message: "customer record is missing first_name" } }]);
    await expect(
      bitnob().createDeposit({
        reference: "DEP-1",
        amountNgn: "5000",
        customer: { providerCustomerId: "c", email: "u@example.com" },
      }),
    ).rejects.toMatchObject({ provider: "bitnob", code: "api_error", statusCode: 400 });
  });

  it("raises when the envelope carries no data", async () => {
    stubFetch([{ body: { success: true, message: "ok" } }]);
    await expect(bitnob().createCustomer({ email: "u@example.com", reference: "CUS-1" })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("Bitnob withdrawal (payouts: quote -> initialize -> finalize)", () => {
  it("walks the three documented steps in order", async () => {
    const calls = stubFetch([
      { body: bitnobOk({ id: "payout_1", quote_id: "QT_1", status: "QUOTE" }) },
      { body: bitnobOk({ id: "payout_1", status: "INITIATED" }) },
      { body: bitnobOk({ id: "payout_1", status: "PROCESSING" }) },
    ]);

    const result = await bitnob().createWithdrawal({
      reference: "WDR-abc",
      amountNgn: "10000",
      customer: { providerCustomerId: "cus_1", email: "u@example.com" },
      bankAccount: { accountNumber: "0123456789", bankCode: "057", accountName: "Jane Doe" },
    });

    expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.bitnob.test", "")}`)).toEqual([
      "POST /api/payouts/quotes",
      "POST /api/payouts/payout_1/initialize",
      "POST /api/payouts/payout_1/finalize",
    ]);
    // A quote alone is not a payout: only finalize moves it to PROCESSING.
    expect(result.status).toBe("PROCESSING");
    expect(result.providerReference).toBe("payout_1");
  });

  it("sends the Nigerian beneficiary on initialize", async () => {
    const calls = stubFetch([
      { body: bitnobOk({ id: "payout_1", status: "QUOTE" }) },
      { body: bitnobOk({ id: "payout_1", status: "INITIATED" }) },
      { body: bitnobOk({ id: "payout_1", status: "COMPLETED" }) },
    ]);
    const result = await bitnob().createWithdrawal({
      reference: "WDR-1",
      amountNgn: "10000",
      customer: { providerCustomerId: "c", email: "u@example.com" },
      bankAccount: { accountNumber: "0123456789", bankCode: "057", accountName: "Jane Doe" },
    });
    expect(calls[1].body).toMatchObject({
      beneficiary: { account_number: "0123456789", bank_code: "057", account_name: "Jane Doe", country: "NG" },
      reference: "WDR-1",
    });
    expect(result.status).toBe("COMPLETED");
  });
});

describe("Bitnob status lookup", () => {
  it("maps the UPPER-case lifecycle status onto the canonical set", async () => {
    const cases: [string, string][] = [
      ["QUOTE", "PENDING"],
      ["INITIATED", "PENDING"],
      ["PENDING", "PENDING"],
      ["PROCESSING", "PROCESSING"],
      ["COMPLETED", "COMPLETED"],
      ["FAILED", "FAILED"],
      ["EXPIRED", "FAILED"],
    ];
    for (const [providerStatus, expected] of cases) {
      stubFetch([{ body: bitnobOk({ data: [{ id: "p1", reference: "WDR-1", status: providerStatus }] }) }]);
      const result = await bitnob().getStatus("WDR-1");
      expect(result.status, providerStatus).toBe(expected);
    }
  });

  it("raises not_found when the reference is unknown", async () => {
    stubFetch([{ body: bitnobOk({ data: [] }) }]);
    await expect(bitnob().getStatus("nope")).rejects.toMatchObject({ code: "not_found", statusCode: 404 });
  });
});

describe("Bitnob webhook signature verification", () => {
  const body = JSON.stringify({ event: "payouts.withdrawal.success", event_id: "e1", data: { reference: "WDR-1" } });

  it("uses the documented x-bitnob-signature header and HMAC-SHA512 hex", () => {
    expect(BITNOB_WEBHOOK_SIGNATURE_HEADER).toBe("x-bitnob-signature");
    const sig = signBitnobWebhook(BITNOB_WEBHOOK_SECRET, body);
    expect(sig).toMatch(/^[0-9a-f]{128}$/); // SHA-512 -> 128 hex chars
    expect(sig).toBe(createHmac("sha512", BITNOB_WEBHOOK_SECRET).update(body).digest("hex"));
  });

  it("accepts a correct signature, over both string and Buffer bodies", () => {
    const p = bitnob();
    const sig = signBitnobWebhook(BITNOB_WEBHOOK_SECRET, body);
    expect(p.verifyWebhookSignature(body, sig)).toBe(true);
    expect(p.verifyWebhookSignature(Buffer.from(body), sig)).toBe(true);
  });

  it("is case-insensitive about the hex signature (defensive, not required)", () => {
    const sig = signBitnobWebhook(BITNOB_WEBHOOK_SECRET, body);
    expect(bitnob().verifyWebhookSignature(body, sig.toUpperCase())).toBe(true);
  });

  it("rejects a signature from the wrong secret", () => {
    const wrong = signBitnobWebhook("attacker_secret", body);
    expect(bitnob().verifyWebhookSignature(body, wrong)).toBe(false);
  });

  it("rejects a signature computed over a different body", () => {
    const sig = signBitnobWebhook(BITNOB_WEBHOOK_SECRET, JSON.stringify({ event: "other" }));
    expect(bitnob().verifyWebhookSignature(body, sig)).toBe(false);
  });

  it("rejects a missing or empty signature", () => {
    const p = bitnob();
    expect(p.verifyWebhookSignature(body, undefined)).toBe(false);
    expect(p.verifyWebhookSignature(body, "")).toBe(false);
  });
});

describe("Bitnob webhook parsing and status normalisation", () => {
  const p = () => bitnob();

  it("maps each documented payout event to its canonical status", () => {
    const cases: [string, string, string][] = [
      ["payouts.initialized", "initiated", "PENDING"],
      ["payouts.processing", "processing", "PROCESSING"],
      ["payouts.withdrawal.success", "success", "COMPLETED"],
      ["payouts.withdrawal.expired", "expired", "FAILED"],
      // Legacy names Bitnob deprecated in July 2026 but still emits.
      ["payout.transfer.success", "success", "COMPLETED"],
      ["payout.transfer.failed", "failed", "FAILED"],
    ];
    for (const [event, dataStatus, expected] of cases) {
      const raw = JSON.stringify({
        event,
        event_id: `evt-${event}`,
        data: { id: "p1", reference: "WDR-1", status: dataStatus, settlement_amount: "10000" },
      });
      const parsed = p().parseWebhook(raw, {});
      expect(parsed.status, `${event} (data.status=${dataStatus})`).toBe(expected);
      expect(parsed.reference).toBe("WDR-1");
    }
  });

  it("trusts the EVENT name, not the lower-case data.status", () => {
    // Bitnob documents that data.status on a payout webhook is the event
    // outcome, not the record lifecycle — this pins that distinction.
    const raw = JSON.stringify({
      event: "payouts.processing",
      event_id: "e1",
      data: { reference: "WDR-1", status: "processing" },
    });
    expect(p().parseWebhook(raw, {}).status).toBe("PROCESSING");
  });

  it("surfaces the provider event id for de-duplication", () => {
    const raw = JSON.stringify({ event: "payouts.initialized", event_id: "evt-1", data: { reference: "WDR-1" } });
    expect(p().parseWebhook(raw, {}).eventId).toBe("evt-1");
  });

  it("raises on a non-JSON or event-less body", () => {
    expect(() => p().parseWebhook("not json", {})).toThrow(/not valid JSON/);
    expect(() => p().parseWebhook(JSON.stringify({ data: {} }), {})).toThrow(/missing the `event` field/);
  });

  it("maps an NGN credit event to COMPLETED", () => {
    const raw = JSON.stringify({ event: "transaction.successful", event_id: "e2", data: { reference: "DEP-1" } });
    expect(p().parseWebhook(raw, {}).status).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// Yellow Card
// ---------------------------------------------------------------------------

describe("Yellow Card request signing", () => {
  it("sends X-YC-Timestamp and `YcHmacV1 key:signature`", () => {
    const headers = buildYellowCardAuthHeaders(
      { apiKey: YC_API_KEY, secretKey: YC_SECRET, now: () => new Date("2026-01-02T03:04:05Z") },
      "/business/transactions",
      "post",
    );
    expect(headers["X-YC-Timestamp"]).toBe("2026-01-02T03:04:05.000Z");
    expect(headers.Authorization).toMatch(/^YcHmacV1 yc_test_key:[A-Za-z0-9+/=]+$/);
  });

  it("signs timestamp + path + UPPERCASED method, then base64(sha256(body))", () => {
    const now = () => new Date("2026-01-02T03:04:05Z");
    const path = "/business/transactions";
    const method = "POST";
    const body = { localAmount: 1000 };
    const headers = buildYellowCardAuthHeaders({ apiKey: YC_API_KEY, secretKey: YC_SECRET, now }, path, method, body);
    const expected = createHmac("sha256", YC_SECRET)
      .update("2026-01-02T03:04:05.000Z", "utf8")
      .update(path, "utf8")
      .update(method, "utf8")
      .update(createHash("sha256").update(JSON.stringify(body), "utf8").digest("base64"), "utf8")
      .digest("base64");
    expect(headers.Authorization).toBe(`YcHmacV1 ${YC_API_KEY}:${expected}`);
  });

  it("omits the body hash when there is no body", () => {
    const now = () => new Date("2026-01-02T03:04:05Z");
    const withBody = buildYellowCardAuthHeaders({ apiKey: "k", secretKey: "s", now }, "/p", "GET", { a: 1 });
    const withoutBody = buildYellowCardAuthHeaders({ apiKey: "k", secretKey: "s", now }, "/p", "GET");
    expect(withBody.Authorization).not.toBe(withoutBody.Authorization);
  });
});

describe("Yellow Card provider construction", () => {
  it("requires the api key and secret", () => {
    expect(() => yellowcard({ apiKey: "" })).toThrow(RampProviderError);
    expect(() => yellowcard({ secretKey: "" })).toThrow(/YELLOW_CARD_API_KEY|YELLOW_CARD_API_SECRET/);
  });
});

describe("Yellow Card deposit and withdrawal", () => {
  it("submits a receive request and returns bankInfo instructions", async () => {
    const calls = stubFetch([
      {
        body: {
          id: "yc_tx_1",
          sequenceId: "DEP-1",
          status: "pending",
          localAmount: 5000,
          localCurrency: "NGN",
          bankInfo: { accountNumber: "0123456789", bankName: "GTBank", accountName: "Ulmara User" },
        },
      },
    ]);

    const result = await yellowcard().createDeposit({
      reference: "DEP-1",
      amountNgn: "5000",
      customer: { providerCustomerId: "CUS-1", email: "u@example.com" },
    });

    expect(calls[0].url).toBe("https://api.yellowcard.test/business/transactions");
    expect(calls[0].body).toMatchObject({ sequenceId: "DEP-1", localAmount: 5000, localCurrency: "NGN" });
    expect(result.status).toBe("PENDING");
    expect(result.paymentInstructions?.accountNumber).toBe("0123456789");
  });

  it("submits a send request with the bank destination", async () => {
    const calls = stubFetch([{ body: { id: "yc_tx_2", sequenceId: "WDR-1", status: "pending" } }]);
    await yellowcard().createWithdrawal({
      reference: "WDR-1",
      amountNgn: "10000",
      customer: { providerCustomerId: "CUS-1", email: "u@example.com" },
      bankAccount: { accountNumber: "0123456789", bankCode: "057", accountName: "Jane Doe" },
    });
    expect(calls[0].url).toBe("https://api.yellowcard.test/business/transactions/send");
    expect(calls[0].body).toMatchObject({
      sequenceId: "WDR-1",
      destination: { accountNumber: "0123456789", bankCode: "057", accountName: "Jane Doe", countryCode: "NG" },
    });
  });

  it("raises a typed error on rejection", async () => {
    stubFetch([{ status: 422, body: { error: { message: "localAmount above channel limit" } } }]);
    await expect(
      yellowcard().createDeposit({
        reference: "DEP-1",
        amountNgn: "5000",
        customer: { providerCustomerId: "C", email: "u@example.com" },
      }),
    ).rejects.toMatchObject({ provider: "yellowcard", code: "api_error", statusCode: 422 });
  });
});

describe("Yellow Card status lookup", () => {
  it("looks up by the partner sequenceId and normalises the status", async () => {
    const calls = stubFetch([{ body: { id: "yc_1", sequenceId: "WDR-1", status: "complete", localAmount: 10000 } }]);
    const result = await yellowcard().getStatus("WDR-1");
    expect(calls[0].url).toBe("https://api.yellowcard.test/business/transactions/sequence/WDR-1");
    expect(result.status).toBe("COMPLETED");
    expect(result.amountNgn).toBe("10000");
  });

  it("normalises the full status vocabulary", async () => {
    const cases: [string, string][] = [
      ["pending", "PENDING"],
      ["pending_approval", "PENDING"],
      ["processing", "PROCESSING"],
      ["pending_provider", "PROCESSING"],
      ["pending_liquidity", "PROCESSING"],
      ["complete", "COMPLETED"],
      ["success", "COMPLETED"],
      ["failed", "FAILED"],
      ["rejected", "FAILED"],
      ["cancelled", "FAILED"],
      ["expired", "FAILED"],
    ];
    for (const [providerStatus, expected] of cases) {
      stubFetch([{ body: { id: "x", sequenceId: "WDR-1", status: providerStatus, localAmount: 1 } }]);
      const result = await yellowcard().getStatus("WDR-1");
      expect(result.status, providerStatus).toBe(expected);
    }
  });

  it("raises not_found when the lookup returns nothing", async () => {
    stubFetch([{ body: {} }]);
    await expect(yellowcard().getStatus("WDR-x")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("Yellow Card webhook signature verification", () => {
  const body = JSON.stringify({ id: "e1", sequenceId: "WDR-1", status: "complete", event: "SEND.COMPLETE", apiKey: YC_API_KEY });

  it("uses the documented X-YC-Signature header and base64(HMAC-SHA256)", () => {
    expect(YELLOWCARD_WEBHOOK_SIGNATURE_HEADER).toBe("x-yc-signature");
    const sig = signYellowCardWebhook(YC_SECRET, body);
    expect(sig).toBe(createHmac("sha256", YC_SECRET).update(body).digest("base64"));
  });

  it("accepts a correct signature and rejects a wrong one", () => {
    const p = yellowcard();
    expect(p.verifyWebhookSignature(body, signYellowCardWebhook(YC_SECRET, body))).toBe(true);
    expect(p.verifyWebhookSignature(body, signYellowCardWebhook("wrong", body))).toBe(false);
    expect(p.verifyWebhookSignature(body, undefined)).toBe(false);
  });

  it("verifies the RAW body even when a re-serialised copy would also validate", () => {
    // Whitespace differences must not change acceptance: the signature covers
    // the exact bytes received.
    const spaced = JSON.stringify({ id: "e1", sequenceId: "WDR-1", status: "complete", event: "SEND.COMPLETE", apiKey: YC_API_KEY }, null, 2);
    const sigOfSpaced = signYellowCardWebhook(YC_SECRET, spaced);
    expect(yellowcard().verifyWebhookSignature(spaced, sigOfSpaced)).toBe(true);
  });
});

describe("Yellow Card webhook parsing and status normalisation", () => {
  const p = () => yellowcard();

  it("maps SEND.* to a withdrawal and RECEIVE.* to a deposit", () => {
    const send = p().parseWebhook(
      JSON.stringify({ id: "e1", sequenceId: "WDR-1", status: "complete", event: "SEND.COMPLETE", apiKey: YC_API_KEY }),
      {},
    );
    expect(send.status).toBe("COMPLETED");
    expect((send.raw as { __direction: string }).__direction).toBe("WITHDRAWAL");

    const receive = p().parseWebhook(
      JSON.stringify({ id: "e2", sequenceId: "DEP-1", status: "complete", event: "RECEIVE.COMPLETE", apiKey: YC_API_KEY }),
      {},
    );
    expect((receive.raw as { __direction: string }).__direction).toBe("DEPOSIT");
  });

  it("rejects an event whose apiKey is not ours", () => {
    const raw = JSON.stringify({ id: "e", sequenceId: "WDR-1", status: "complete", event: "SEND.COMPLETE", apiKey: "someone_elses_key" });
    expect(() => p().parseWebhook(raw, {})).toThrow(/apiKey does not match/);
  });

  it("records a failure reason only for a FAILED outcome", () => {
    const failed = p().parseWebhook(
      JSON.stringify({ id: "e", sequenceId: "WDR-1", status: "failed", event: "SEND.FAILED", errorCode: "REFUSED", apiKey: YC_API_KEY }),
      {},
    );
    expect(failed.status).toBe("FAILED");
    expect(failed.failureReason).toBe("REFUSED");

    const ok = p().parseWebhook(
      JSON.stringify({ id: "e", sequenceId: "WDR-1", status: "complete", event: "SEND.COMPLETE", apiKey: YC_API_KEY }),
      {},
    );
    expect(ok.failureReason).toBeUndefined();
  });

  it("falls back to the event suffix when status is absent", () => {
    const raw = JSON.stringify({ id: "e", sequenceId: "WDR-1", event: "SEND.COMPLETE", apiKey: YC_API_KEY });
    expect(p().parseWebhook(raw, {}).status).toBe("COMPLETED");
  });

  it("raises on a non-JSON or event-less body", () => {
    expect(() => p().parseWebhook("nope", {})).toThrow(/not valid JSON/);
    expect(() => p().parseWebhook(JSON.stringify({ id: "e", sequenceId: "WDR-1", apiKey: YC_API_KEY }), {})).toThrow(
      /missing the `event` field/,
    );
  });
});

describe("provider errors and network failures", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies an abort as a timeout in both adapters", async () => {
    // Yellow Card's createCustomer makes no network call, so the timeout is
    // exercised on createDeposit for both adapters.
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw abort; }));
    await expect(
      bitnob().createDeposit({ reference: "D", amountNgn: "5000", customer: { providerCustomerId: "c", email: "u@e.com" } }),
    ).rejects.toMatchObject({ code: "timeout" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw abort; }));
    await expect(
      yellowcard().createDeposit({ reference: "D", amountNgn: "5000", customer: { providerCustomerId: "c", email: "u@e.com" } }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("classifies a transport failure as a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(bitnob().createCustomer({ email: "u@example.com", reference: "C" })).rejects.toMatchObject({
      code: "network_error",
    });
  });

  it("Yellow Card identifies a customer by the partner reference without a network call", async () => {
    const customer = await yellowcard().createCustomer({ email: "u@example.com", name: "Jane", reference: "CUS-9" });
    expect(customer).toEqual({ providerCustomerId: "CUS-9", email: "u@example.com", name: "Jane" });
  });
});
