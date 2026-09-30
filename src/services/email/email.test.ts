import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const { envState } = vi.hoisted(() => ({
  envState: {
    env: {
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: "no-reply@ulmara.app",
      EMAIL_FROM_NAME: "Ulmara",
      RESEND_API_KEY: undefined as string | undefined,
      SENDGRID_API_KEY: undefined as string | undefined,
      SENDGRID_FROM_EMAIL: undefined as string | undefined,
      AWS_SES_REGION: undefined as string | undefined,
      AWS_SES_ACCESS_KEY_ID: undefined as string | undefined,
      AWS_SES_SECRET_ACCESS_KEY: undefined as string | undefined,
      OTP_TTL_SECONDS: 600,
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      DEV_VERIFICATION_MODE: false,
    },
  },
}));

vi.mock("../../config/env.js", () => ({
  env: envState.env,
  assertEmailProviderConfigured: () => undefined,
  assertRampProviderConfigured: () => undefined,
  EMAIL_PROVIDERS: ["resend", "sendgrid", "ses"],
  RAMP_PROVIDERS: ["bitnob", "yellowcard"],
}));

// A real pino instance is not needed here; a spy logger lets the delivery
// outcome be asserted directly.
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock("../../config/logger.js", () => ({ logger: loggerMock }));

import { createResendProvider } from "./resend.provider.js";
import { createSendGridProvider } from "./sendgrid.provider.js";
import { createSesProvider, signAwsRequest } from "./ses.provider.js";
import { EmailDeliveryError } from "./types.js";
import { getEmailProvider, isEmailProviderConfigured, resetEmailProviderCache, trySendEmail } from "./index.js";
import { verificationEmailBody, verificationEmailSubject } from "./templates.js";

/** A fetch double that records the request and returns a canned response. */
function stubFetch(response: { status?: number; body?: unknown } = {}) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const impl = vi.fn(async (url: string | URL, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      // `init.body` is a `BodyInit`, so String() on a stream would silently
      // produce "[object Object]". Every provider under test posts JSON text.
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(response.body ?? { id: "msg_123" }), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", impl);
  return calls;
}

beforeEach(() => {
  envState.env.EMAIL_PROVIDER = "resend";
  envState.env.RESEND_API_KEY = undefined;
  envState.env.SENDGRID_API_KEY = undefined;
  envState.env.SENDGRID_FROM_EMAIL = undefined;
  envState.env.AWS_SES_REGION = undefined;
  envState.env.AWS_SES_ACCESS_KEY_ID = undefined;
  envState.env.AWS_SES_SECRET_ACCESS_KEY = undefined;
  resetEmailProviderCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetEmailProviderCache();
});

const MESSAGE = {
  to: "user@example.com",
  subject: "123456 is your Ulmara verification code",
  html: "<p>code</p>",
  text: "code",
};

describe("Resend adapter", () => {
  it("refuses to construct without an API key", () => {
    expect(() => createResendProvider("")).toThrow(EmailDeliveryError);
  });

  it("POSTs the documented envelope with a bearer token", async () => {
    const calls = stubFetch({ body: { id: "resend-abc" } });
    const provider = createResendProvider("re_test_key");

    const result = await provider.send(MESSAGE);

    expect(result).toEqual({ messageId: "resend-abc", provider: "resend" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.authorization).toBe("Bearer re_test_key");
    expect(calls[0].body).toMatchObject({
      from: "Ulmara <no-reply@ulmara.app>",
      to: ["user@example.com"],
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
    });
  });

  it("uses a custom base URL when given one", async () => {
    const calls = stubFetch();
    await createResendProvider("k", "https://api.resend.test/").send(MESSAGE);
    expect(calls[0].url).toBe("https://api.resend.test/emails");
  });

  it("raises a typed error on a non-2xx response", async () => {
    stubFetch({ status: 422, body: { message: "domain not verified" } });
    const provider = createResendProvider("k");
    await expect(provider.send(MESSAGE)).rejects.toMatchObject({
      code: "send_failed",
      provider: "resend",
      statusCode: 422,
    });
  });

  it("raises when the response carries no message id", async () => {
    stubFetch({ body: { unexpected: true } });
    await expect(createResendProvider("k").send(MESSAGE)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("classifies a network failure distinctly from a rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(createResendProvider("k").send(MESSAGE)).rejects.toMatchObject({ code: "network_error" });
  });

  it("classifies an abort as a timeout", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw abort; }));
    await expect(createResendProvider("k").send(MESSAGE)).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("SendGrid adapter", () => {
  it("refuses to construct without an API key", () => {
    expect(() => createSendGridProvider("")).toThrow(EmailDeliveryError);
  });

  it("POSTs SendGrid's personalizations/content shape", async () => {
    const calls = stubFetch({ status: 202, body: {} });
    const provider = createSendGridProvider("SG.key", undefined, "verified@ulmara.app");

    await provider.send(MESSAGE);

    expect(calls[0].url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(calls[0].headers.authorization).toBe("Bearer SG.key");
    expect(calls[0].body).toMatchObject({
      personalizations: [{ to: [{ email: "user@example.com" }] }],
      from: { name: "Ulmara", email: "verified@ulmara.app" },
      subject: MESSAGE.subject,
    });
    // Both a plain-text and an HTML part are sent.
    expect((calls[0].body as { content: { type: string }[] }).content.map((c) => c.type)).toEqual([
      "text/plain",
      "text/html",
    ]);
  });

  it("falls back to EMAIL_FROM when no override is set", async () => {
    const calls = stubFetch({ status: 202, body: {} });
    await createSendGridProvider("SG.key").send(MESSAGE);
    expect((calls[0].body as { from: { email: string } }).from.email).toBe("no-reply@ulmara.app");
  });

  it("raises a typed error on rejection", async () => {
    stubFetch({ status: 401, body: { errors: [{ message: "permission denied" }] } });
    const provider = createSendGridProvider("bad");
    await expect(provider.send(MESSAGE)).rejects.toMatchObject({ code: "send_failed", statusCode: 401 });
  });
});

describe("AWS SES adapter", () => {
  const REGION = "us-east-1";

  it("names every missing credential in one error", () => {
    expect(() => createSesProvider({ region: "", accessKeyId: "", secretAccessKey: "" })).toThrow(
      /region, accessKeyId, secretAccessKey/,
    );
  });

  it("POSTs the SES v2 SendEmail shape with a SigV4 Authorization header", async () => {
    const calls = stubFetch({ body: { MessageId: "ses-msg-1" } });
    const provider = createSesProvider({
      region: REGION,
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "SECRET",
      fromName: "Ulmara",
    });

    const result = await provider.send(MESSAGE);

    expect(result).toEqual({ messageId: "ses-msg-1", provider: "ses" });
    expect(calls[0].url).toBe(`https://email.${REGION}.amazonaws.com/v2/email`);
    expect(calls[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(calls[0].headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(calls[0].body).toMatchObject({
      FromEmailAddress: "Ulmara <no-reply@ulmara.app>",
      Destination: { ToAddresses: ["user@example.com"] },
      Content: { Simple: { Subject: { Data: MESSAGE.subject } } },
    });
  });

  it("raises a typed error when SES rejects the message", async () => {
    stubFetch({ status: 400, body: { message: "Email address is not verified" } });
    const provider = createSesProvider({ region: REGION, accessKeyId: "A", secretAccessKey: "S" });
    await expect(provider.send(MESSAGE)).rejects.toMatchObject({ code: "send_failed", statusCode: 400 });
  });

  it("raises when the response has no MessageId", async () => {
    stubFetch({ body: {} });
    const provider = createSesProvider({ region: REGION, accessKeyId: "A", secretAccessKey: "S" });
    await expect(provider.send(MESSAGE)).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("SigV4 request signing", () => {
  /**
   * Reproduces the canonical "get-vanilla" case from AWS's published SigV4
   * test suite (aws-sig-v4-test-suite/get-vanilla), whose expected signature
   * is a fixed, publicly documented value. Matching it proves the canonical
   * request, the string-to-sign and the signing-key derivation are all
   * correct — a real check against an external reference, not
   * self-consistency.
   *
   * The vector is a bodyless GET, so it signs only host + x-amz-date; the
   * SES adapter always adds content-type, hence omitContentType here.
   */
  it("matches the published AWS SigV4 get-vanilla test vector", () => {
    const signed = signAwsRequest({
      method: "GET",
      path: "/",
      region: "us-east-1",
      service: "service",
      body: "",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      host: "example.amazonaws.com",
      omitContentType: true,
      date: new Date("2015-08-30T12:36:00Z"),
    });

    expect(signed.amzDate).toBe("20150830T123600Z");
    expect(signed.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        // sha256("") — the empty-payload hash.
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    );
    expect(signed.stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20150830T123600Z",
        "20150830/us-east-1/service/aws4_request",
        // sha256 of the canonical request above, independently recomputed
        // here so a change in the canonicalisation cannot silently agree
        // with itself.
        createHash("sha256").update(signed.canonicalRequest, "utf8").digest("hex"),
      ].join("\n"),
    );
    // The documented expected signature for this vector.
    expect(signed.signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    expect(signed.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("always signs content-type for a real SES send (never the vector's shape)", () => {
    const signed = signAwsRequest({
      method: "POST",
      path: "/v2/email",
      region: "us-east-1",
      service: "ses",
      body: "{}",
      accessKeyId: "A",
      secretAccessKey: "S",
      date: new Date("2015-08-30T12:36:00Z"),
    });
    expect(signed.authorization).toContain("SignedHeaders=content-type;host;x-amz-date");
  });

  it("is deterministic for a fixed date", () => {
    const args = {
      method: "POST",
      path: "/v2/email",
      region: "eu-west-1",
      service: "ses",
      body: '{"a":1}',
      accessKeyId: "A",
      secretAccessKey: "S",
      date: new Date("2024-01-02T03:04:05Z"),
    };
    expect(signAwsRequest(args).authorization).toBe(signAwsRequest(args).authorization);
  });

  it("changes the signature when any covered field changes", () => {
    const base = {
      method: "POST",
      path: "/v2/email",
      region: "eu-west-1",
      service: "ses",
      body: '{"a":1}',
      accessKeyId: "A",
      secretAccessKey: "S",
      date: new Date("2024-01-02T03:04:05Z"),
    };
    const sig = signAwsRequest(base).signature;
    expect(signAwsRequest({ ...base, body: '{"a":2}' }).signature).not.toBe(sig);
    expect(signAwsRequest({ ...base, path: "/v2/other" }).signature).not.toBe(sig);
    expect(signAwsRequest({ ...base, region: "us-east-1" }).signature).not.toBe(sig);
    expect(signAwsRequest({ ...base, secretAccessKey: "S2" }).signature).not.toBe(sig);
    expect(signAwsRequest({ ...base, date: new Date("2024-01-02T03:04:06Z") }).signature).not.toBe(sig);
  });
});

describe("provider selection", () => {
  it("selects Resend by default", () => {
    envState.env.RESEND_API_KEY = "re_key";
    expect(getEmailProvider().name).toBe("resend");
    expect(isEmailProviderConfigured()).toBe(true);
  });

  it("selects SendGrid when configured", () => {
    envState.env.EMAIL_PROVIDER = "sendgrid";
    envState.env.SENDGRID_API_KEY = "SG.key";
    expect(getEmailProvider().name).toBe("sendgrid");
  });

  it("selects SES when configured", () => {
    envState.env.EMAIL_PROVIDER = "ses";
    envState.env.AWS_SES_REGION = "us-east-1";
    envState.env.AWS_SES_ACCESS_KEY_ID = "A";
    envState.env.AWS_SES_SECRET_ACCESS_KEY = "S";
    expect(getEmailProvider().name).toBe("ses");
  });

  it("reports unconfigured (not crash) when credentials are absent", () => {
    envState.env.RESEND_API_KEY = undefined;
    expect(isEmailProviderConfigured()).toBe(false);
  });

  it("memoises the provider for the process lifetime", () => {
    envState.env.RESEND_API_KEY = "re_key";
    expect(getEmailProvider()).toBe(getEmailProvider());
  });
});

describe("trySendEmail", () => {
  it("returns true and logs on success", async () => {
    stubFetch({ body: { id: "m1" } });
    envState.env.RESEND_API_KEY = "re_key";
    await expect(trySendEmail("a@b.com", "s", "h", "t")).resolves.toBe(true);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "email_sent", provider: "resend", messageId: "m1" }),
      expect.any(String),
    );
  });

  it("returns false rather than throwing when the provider is unconfigured", async () => {
    envState.env.RESEND_API_KEY = undefined;
    await expect(trySendEmail("a@b.com", "s", "h", "t")).resolves.toBe(false);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "email_send_failed" }),
      expect.any(String),
    );
  });

  it("returns false when the provider rejects the send", async () => {
    stubFetch({ status: 500, body: { message: "boom" } });
    envState.env.RESEND_API_KEY = "re_key";
    await expect(trySendEmail("a@b.com", "s", "h", "t")).resolves.toBe(false);
  });
});

describe("verification email template", () => {
  it("carries the code in the subject, html and text", () => {
    const code = "424242";
    expect(verificationEmailSubject(code)).toContain(code);
    const body = verificationEmailBody(code, 10);
    expect(body.html).toContain(code);
    expect(body.text).toContain(code);
    expect(body.html).toContain("10 minutes");
  });

  it("never embeds an email address or account identifier", () => {
    const body = verificationEmailBody("424242", 10);
    expect(body.html).not.toMatch(/user@example|@ulmara|password|pin/i);
  });
});
