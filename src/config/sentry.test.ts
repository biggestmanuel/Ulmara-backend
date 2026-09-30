import { beforeEach, describe, expect, it, vi } from "vitest";

const { envState } = vi.hoisted(() => ({
  envState: {
    env: {
      NODE_ENV: "test",
      SENTRY_DSN: undefined as string | undefined,
      SENTRY_ENVIRONMENT: undefined as string | undefined,
      SENTRY_TRACES_SAMPLE_RATE: 0,
      SENTRY_PROFILES_SAMPLE_RATE: 0,
      SENTRY_RELEASE: undefined as string | undefined,
      SENTRY_DEBUG: false,
    },
  },
}));

vi.mock("./env.js", () => ({ env: envState.env }));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

// Capture what would be sent to Sentry without sending it.
const sentryMock = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(async () => true),
  httpIntegration: vi.fn(() => ({ name: "http" })),
  prismaIntegration: vi.fn(() => ({ name: "prisma" })),
}));
vi.mock("@sentry/node", () => sentryMock);

import { captureError, initSentry, isSentryEnabled, reportError, resetSentryForTests, scrubSentryEvent } from "./sentry.js";

beforeEach(() => {
  envState.env.SENTRY_DSN = undefined;
  envState.env.NODE_ENV = "test";
  vi.clearAllMocks();
  sentryMock.flush.mockResolvedValue(true);
  // initSentry is idempotent by design; reset so each test observes a fresh
  // first call.
  resetSentryForTests();
});

describe("isSentryEnabled", () => {
  it("is off with no DSN and on with one", () => {
    expect(isSentryEnabled()).toBe(false);
    envState.env.SENTRY_DSN = "https://abc@o1.ingest.sentry.io/2";
    expect(isSentryEnabled()).toBe(true);
  });
});

describe("initSentry", () => {
  it("does nothing at all without a DSN (monitoring must be safely absent)", () => {
    initSentry();
    expect(sentryMock.init).not.toHaveBeenCalled();
  });

  it("initialises once with the env-driven configuration", () => {
    envState.env.SENTRY_DSN = "https://abc@o1.ingest.sentry.io/2";
    envState.env.SENTRY_ENVIRONMENT = "staging";
    envState.env.SENTRY_RELEASE = "ulmara-backend@1.2.3";
    initSentry();

    expect(sentryMock.init).toHaveBeenCalledTimes(1);
    const opts = sentryMock.init.mock.calls[0][0];
    expect(opts).toMatchObject({
      dsn: "https://abc@o1.ingest.sentry.io/2",
      environment: "staging",
      release: "ulmara-backend@1.2.3",
    });
    // The scrubber must be wired in.
    expect(typeof opts.beforeSend).toBe("function");
  });

  it("never collects user payloads (bodies, cookies, headers, query params, DB params)", () => {
    envState.env.SENTRY_DSN = "https://abc@o1.ingest.sentry.io/2";
    initSentry();
    const opts = sentryMock.init.mock.calls[0][0];

    // @sentry/node v11 replaced the old `sendDefaultPii: false` boolean with
    // `dataCollection`, whose defaults are PERMISSIVE. These assertions exist to
    // fail loudly if anyone ever trims this block back to the SDK default: a
    // PIN or an authorization header must never be able to reach Sentry just
    // because an option was dropped.
    expect(opts).not.toHaveProperty("sendDefaultPii");
    expect(opts.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
    });
    expect(opts.includeServerName).toBe(false);
  });

  it("maps the profiling env var onto the v11 profileSessionSampleRate option", () => {
    envState.env.SENTRY_DSN = "https://abc@o1.ingest.sentry.io/2";
    envState.env.SENTRY_PROFILES_SAMPLE_RATE = 0.25;
    initSentry();
    const opts = sentryMock.init.mock.calls[0][0];
    // v11 renamed this option; the env var keeps its public name.
    expect(opts.profileSessionSampleRate).toBe(0.25);
    expect(opts).not.toHaveProperty("profilesSampleRate");
  });

  it("registers crash handlers for unhandled exceptions and rejections", () => {
    const before = process.listenerCount("uncaughtException");
    const beforeRej = process.listenerCount("unhandledRejection");
    envState.env.SENTRY_DSN = "https://abc@o1.ingest.sentry.io/2";
    initSentry();
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(beforeRej + 1);
    // Tidy up so the handlers do not leak into other test files.
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
  });
});

describe("scrubSentryEvent", () => {
  const secretish = (o: Record<string, unknown>) => JSON.stringify(scrubSentryEvent(o));

  it("redacts credential-shaped keys at the top level", () => {
    const out = secretish({
      pin: "123456",
      pinHash: "$2b$12$abc",
      password: "hunter2",
      token: "eyJhbGciOi...",
      jwt: "eyJhbGciOi...",
      authorization: "Bearer x",
      cookie: "sid=1",
      seed: "word word word",
      mnemonic: "twelve words here",
      privateKey: "0xdeadbeef",
      apiKey: "sk-live-1",
      dsn: "https://abc@o1.ingest.sentry.io/2",
    });
    for (const secret of [
      "123456", "$2b$12$abc", "hunter2", "eyJhbGciOi", "Bearer x", "sid=1",
      "word word word", "twelve words here", "0xdeadbeef", "sk-live-1",
    ]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain("[redacted]");
  });

  it("redacts nested credentials, not just top-level ones", () => {
    const out = secretish({
      request: { body: { pin: "654321", amount: "10" }, headers: { authorization: "Bearer y" } },
      user: { credentials: { password: "nested-secret" } },
    });
    expect(out).not.toContain("654321");
    expect(out).not.toContain("nested-secret");
    expect(out).not.toContain("Bearer y");
    // Non-sensitive siblings survive.
    expect(out).toContain("10");
  });

  it("redacts keys whose name merely CONTAINS a sensitive word", () => {
    const out = secretish({ userPin: "111111", sessionCookieValue: "abc", secretRotationId: "r1" });
    expect(out).not.toContain("111111");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("r1");
  });

  it("keeps non-sensitive diagnostic fields", () => {
    const out = secretish({ userId: "u-1", chain: "ETH", statusCode: 500, amount: "1.5" });
    expect(out).toContain("u-1");
    expect(out).toContain("ETH");
    expect(out).toContain("500");
  });

  it("truncates a very long string (e.g. a serialized signed transaction)", () => {
    const long = "a".repeat(5000);
    const out = secretish({ raw: long });
    expect(out.length).toBeLessThan(700);
    expect(out).toContain("truncated");
  });

  it("reduces an Error to name/message/stack only, dropping custom props", () => {
    const err = Object.assign(new Error("boom"), { pin: "999999", jwt: "leaky" });
    const scrubbed = scrubSentryEvent({ err }) as unknown as { err: Record<string, unknown> };
    expect(scrubbed.err).toEqual({ name: "Error", message: "boom", stack: expect.any(String) });
    expect(JSON.stringify(scrubbed)).not.toContain("999999");
    expect(JSON.stringify(scrubbed)).not.toContain("leaky");
  });

  // Found by `npm run verify:providers`, which asserted a real canary object
  // against the live scrubber: a Prisma connection string survived because the
  // key was `databaseUrl` and the key regex did not match it.
  it("redacts a database connection string announced by its key", () => {
    const out = secretish({ databaseUrl: "postgresql://avora:hunter2@ep-cool.us-east-2.aws.neon.tech/avora" });
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[redacted]");
  });

  it.each(["database_url", "DATABASEURL", "connectionString", "connection_string", "credentials"])(
    "redacts the connection-string key %s in any casing",
    (key) => {
      expect(secretish({ [key]: "postgresql://avora:hunter2@host/db" })).not.toContain("hunter2");
    },
  );

  // The worse vector: no key announces anything, and the URL arrives inside a
  // Prisma error message, which is exactly how the real leak would occur.
  it("strips the password out of a URL embedded in a value, keeping the host", () => {
    // No cast needed: scrubSentryEvent is generic over its argument, so the
    // inferred type already carries `env: string`.
    const out = scrubSentryEvent({
      env: "DATABASE_URL=postgresql://avora:hunter2@ep-cool.us-east-2.aws.neon.tech/avora?sslmode=require",
    });
    expect(out.env).not.toContain("hunter2");
    // The host is the diagnostic value and must survive.
    expect(out.env).toContain("ep-cool.us-east-2.aws.neon.tech");
    expect(out.env).toContain("sslmode=require");
  });

  it("redacts credentials inside an Error message and stack", () => {
    const err = new Error("Authentication failed against `postgresql://avora:hunter2@host/db`");
    const scrubbed = scrubSentryEvent({ err }) as unknown as { err: Record<string, unknown> };
    expect(scrubbed.err.message).not.toContain("hunter2");
    expect(scrubbed.err.message).toContain("host");
  });

  it("redacts every URL in a multi-URL string, not just the first", () => {
    const out = secretish({
      note: "a=postgresql://u:one@h1/db b=postgres://v:two@h2/db c=no-credentials-here",
    });
    expect(out).not.toContain("one@");
    expect(out).not.toContain("two@");
    expect(out).toContain("no-credentials-here");
  });

  it("leaves a credential-free URL untouched", () => {
    const url = "https://api.example.com/v1/orders?limit=10";
    expect(secretish({ next: url })).toContain(url);
  });

  it("stops recursing on deeply nested structures", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 30; i++) deep = { nested: deep };
    // Must not blow the stack or produce unbounded output.
    expect(() => scrubSentryEvent(deep)).not.toThrow();
    expect(JSON.stringify(scrubSentryEvent(deep)).length).toBeLessThan(2000);
  });

  it("caps very long arrays", () => {
    const out = JSON.stringify(scrubSentryEvent({ items: Array.from({ length: 500 }, (_, i) => i) }));
    expect(out.length).toBeLessThan(2000);
  });

  it("passes through null/undefined and primitives", () => {
    expect(scrubSentryEvent({ a: null, b: undefined, c: 1, d: true, e: "x" })).toEqual({
      a: null, b: undefined, c: 1, d: true, e: "x",
    });
  });
});

describe("captureError / reportError", () => {
  it("captureError is a no-op with no DSN configured", () => {
    captureError(new Error("x"), { userId: "u" });
    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });

  it("reportError always writes the pino log, even with no DSN", async () => {
    const { logger } = await import("./logger.js");
    reportError(new Error("boom"), "something broke", { chain: "ETH" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), chain: "ETH" }),
      "something broke",
    );
    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });

  it("reportError scrubs the context before it can reach Sentry", async () => {
    const { logger } = await import("./logger.js");
    envState.env.SENTRY_DSN = "https://abc@o1.ingest.sentry.io/2";
    reportError(new Error("boom"), "m", { pin: "123456" });
    const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logged).not.toContain("123456");
  });

  it("reportError sends to Sentry when a DSN is configured", () => {
    envState.env.SENTRY_DSN = "https://abc@o1.ingest.sentry.io/2";
    reportError(new Error("boom"), "m", { chain: "ETH" });
    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureException.mock.calls[0][1].extra).toMatchObject({ chain: "ETH", message: "m" });
  });

  it("uses captureMessage for a non-Error throw", () => {
    envState.env.SENTRY_DSN = "https://abc@o1.ingest.sentry.io/2";
    reportError("just a string", "m");
    expect(sentryMock.captureMessage).toHaveBeenCalledWith("just a string", expect.objectContaining({ level: "error" }));
  });
});
