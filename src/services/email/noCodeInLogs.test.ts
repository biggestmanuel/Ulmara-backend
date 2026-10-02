import { beforeEach, describe, expect, it, vi } from "vitest";

// Appended to the existing email suite's harness by convention: the logger mock
// and the provider stub already exist in email.test.ts, so this file stands
// alone with its own minimal harness rather than editing that suite.

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

vi.mock("../../config/logger.js", () => ({ logger: loggerMock }));

const { state } = vi.hoisted(() => ({
  state: { sent: [] as unknown[], fail: false },
}));

vi.mock("./resend.provider.js", () => ({
  createResendProvider: () => ({
    name: "resend",
    send: async (msg: unknown) => {
      if (state.fail) throw new Error("boom");
      state.sent.push(msg);
      return { provider: "resend", messageId: "m1" };
    },
  }),
}));

const { envState } = vi.hoisted(() => ({
  envState: { env: { EMAIL_PROVIDER: "resend" as const, RESEND_API_KEY: "k", EMAIL_FROM: "a@b.test", EMAIL_FROM_NAME: "Ulmara" } },
}));
vi.mock("../../config/env.js", () => ({ env: envState.env }));

import { trySendEmail, resetEmailProviderCache } from "./index.js";
import { verificationEmailSubject } from "./templates.js";

const CODE = "482913";

beforeEach(() => {
  state.sent = [];
  state.fail = false;
  // getEmailProvider() memoises for the process lifetime, so the stub would
  // only be picked up on the first call without this.
  resetEmailProviderCache();
  vi.clearAllMocks();
});

describe("the verification code never reaches the log", () => {
  it("logs email_sent without the subject", async () => {
    await expect(trySendEmail("u@x.test", verificationEmailSubject(CODE), "<p>c</p>", "c")).resolves.toBe(true);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "email_sent", provider: "resend", messageId: "m1" }),
      "Verification email dispatched",
    );
  });

  it("the code appears NOWHERE in the logged payload", async () => {
    await trySendEmail("u@x.test", verificationEmailSubject(CODE), "<p>c</p>", "c");
    const serialised = JSON.stringify(loggerMock.info.mock.calls);
    expect(serialised).not.toContain(CODE);
    // And neither does the recipient, which is the other half of the leak.
    expect(serialised).not.toContain("u@x.test");
    expect(serialised).not.toContain("subject");
  });

  it("still delivers the code to the recipient", async () => {
    await trySendEmail("u@x.test", verificationEmailSubject(CODE), "<p>c</p>", "c");
    // The fix removes the code from the LOG, not from the email.
    expect(state.sent).toHaveLength(1);
    expect((state.sent[0] as { subject: string }).subject).toContain(CODE);
  });

  it("the failure path does not leak the code either", async () => {
    state.fail = true;
    await expect(trySendEmail("u@x.test", verificationEmailSubject(CODE), "<p>c</p>", "c")).resolves.toBe(false);
    expect(JSON.stringify(loggerMock.error.mock.calls)).not.toContain(CODE);
  });
});
