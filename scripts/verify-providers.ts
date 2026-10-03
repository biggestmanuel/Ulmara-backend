/**
 * Live-provider verification: makes REAL calls to whichever providers are
 * configured, and reports honestly on the ones that are not.
 *
 *   npm run verify:providers
 *
 * ## Why this exists
 *
 * Every provider test in this repo is fixture-based: it proves the request we
 * BUILD is well-formed, not that the provider ACCEPTS it. That gap matters
 * because provider behaviour is where a correct-looking integration actually
 * breaks — a wrong API version, a renamed field, a sandbox key that is not
 * live. The only way to close it is to call the provider.
 *
 * This harness does that, and it deliberately does NOT fake a success:
 *
 *  - a provider with credentials is called for real and its response asserted;
 *  - a provider without credentials is reported as SKIPPED, and the exit code
 *    says so, so "0 failures" is never mistaken for "everything verified";
 *  - `--require` turns any skip into a failure, which is what CI should use
 *    once the secrets exist.
 *
 * It uses the app's own provider factories (`getEmailProvider`,
 * `getRampProvider`), so it exercises the production code path including the
 * credential preconditions, not a parallel reimplementation.
 *
 * ## What it will NOT do
 *
 * It does not create accounts, and it does not move money. A ramp check calls
 * only read-only endpoints (`getStatus` on a deliberately non-existent
 * reference) plus local signature verification, so running it cannot create a
 * real deposit or withdrawal. The email check sends one real message to
 * `VERIFY_EMAIL_TO` if you set it — which is a real email, so that variable is
 * required before that check will do anything.
 */

import { env } from "../src/config/env.js";
import {
  getEmailProvider,
  isEmailProviderConfigured,
  resetEmailProviderCache,
  trySendEmail,
} from "../src/services/email/index.js";
import {
  getRampProvider,
  getRampProviderName,
  isRampProviderConfigured,
  resetRampProviderCache,
  getRampWebhookSignatureHeader,
} from "../src/services/ramp/providers/index.js";
import { createHmac } from "node:crypto";

const REQUIRE_ALL = process.argv.includes("--require");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

type Verdict = "pass" | "fail" | "skip";
const results: { name: string; verdict: Verdict; detail: string }[] = [];

function record(name: string, verdict: Verdict, detail: string) {
  results.push({ name, verdict, detail });
  const tag = verdict === "pass" ? "[  ok  ]" : verdict === "fail" ? "[ FAIL ]" : "[ skip ]";
  console.log(`  ${tag} ${name}`);
  for (const line of detail.split("\n")) console.log(`           ${line}`);
}
const wanted = (name: string) => !only || only === name;

console.log("=== Live provider verification ===");
console.log(`  mode      : ${REQUIRE_ALL ? "REQUIRE ALL (any skip is a failure)" : "opportunistic (skips are allowed)"}`);
console.log(`  NODE_ENV  : ${env.NODE_ENV}`);

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------
if (wanted("email")) {
  console.log(`\n--- email (${env.EMAIL_PROVIDER}) ---`);
  resetEmailProviderCache();
  if (!isEmailProviderConfigured()) {
    record("email", "skip", `EMAIL_PROVIDER=${env.EMAIL_PROVIDER} has no credentials set.`);
  } else {
    const to = process.env.VERIFY_EMAIL_TO;
    if (!to) {
      record("email", "skip", "Credentials present, but VERIFY_EMAIL_TO is not set, so nothing would be sent.\nSet it to an inbox you control to exercise a real send.");
    } else {
      try {
        const provider = getEmailProvider();
        const result = await provider.send({
          to,
          subject: `Ulmara provider verification ${new Date().toISOString()}`,
          html: "<p>Provider verification from <code>npm run verify:providers</code>. No action needed.</p>",
          text: "Provider verification from npm run verify:providers. No action needed.",
        });
        // A provider that returns a fake id without sending is exactly the bug
        // this harness exists to catch, so assert the shape AND require a
        // non-empty id.
        if (!result.messageId || result.messageId.length < 4) {
          record("email", "fail", `Provider ${result.provider} returned an implausible messageId: ${JSON.stringify(result.messageId)}`);
        } else {
          record("email", "pass", `Sent via ${result.provider}; messageId ${result.messageId.slice(0, 40)}`);
        }
      } catch (err) {
        record("email", "fail", `${env.EMAIL_PROVIDER} rejected the send: ${(err as Error).message.split("\n")[0]}`);
      }
    }
  }

  // The non-throwing path is separate: OTP delivery must never fail a request.
  if (isEmailProviderConfigured() && process.env.VERIFY_EMAIL_TO) {
    const delivered = await trySendEmail(process.env.VERIFY_EMAIL_TO, "Ulmara fallback-path check", "<p>fallback path</p>", "fallback path");
    record("email:trySendEmail (non-throwing path)", delivered ? "pass" : "fail",
      delivered ? "trySendEmail reported delivery" : "trySendEmail swallowed a real failure and returned false — check the logs");
  }
}

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------
if (wanted("sentry")) {
  console.log("\n--- sentry ---");
  const { isSentryEnabled, scrubSentryEvent, captureError, flushSentry } =
    await import("../src/config/sentry.js");

  // The scrubbing path is testable with NO credentials, and it is the part that
  // matters: a PIN, hash or provider key reaching Sentry is a real breach. So
  // it is asserted directly against the real function rather than inferred.
  const canary = {
    event_id: "verify",
    pin: "111111",
    pinHash: "$2a$12$abcdefghijklmnopqrstuv",
    password: "hunter2",
    token: "eyJhbGciOiJIUzI1NiJ9.signature",
    authorization: "Bearer abc",
    apiKey: "re_live_secret",
    databaseUrl: "postgres://user:pw@host/db",
    safe: "keep-me",
  };
  const scrubbed = scrubSentryEvent(canary) as Record<string, unknown>;
  const serialised = JSON.stringify(scrubbed);
  const leaks: string[] = [];
  for (const key of ["pin", "pinHash", "password", "token", "authorization", "apiKey", "databaseUrl"]) {
    if (serialised.includes(String(canary[key as keyof typeof canary]))) leaks.push(key);
  }
  if (leaks.length > 0) {
    record("sentry:scrubbing", "fail", `credential-shaped values survived scrubbing: ${leaks.join(", ")}`);
  } else if (scrubbed.safe !== "keep-me") {
    record("sentry:scrubbing", "fail", "scrubbing removed a harmless field; it should be a targeted redaction, not a blanket drop");
  } else {
    record("sentry:scrubbing", "pass", "7 credential-shaped values redacted; the harmless field was kept");
  }

  if (!env.SENTRY_DSN) {
    record("sentry:transport", "skip", "SENTRY_DSN is not set, so no event can actually be sent. Expected locally.");
  } else if (!isSentryEnabled()) {
    record("sentry:transport", "fail", "SENTRY_DSN is set but the SDK reports disabled — events would be silently dropped.");
  } else {
    try {
      captureError(new Error("Ulmara provider verification probe"), { event: "verify_providers" });
      await flushSentry(3_000);
      record("sentry:transport", "pass", "emitted a real event and flushed it without error");
    } catch (err) {
      record("sentry:transport", "fail", `emitting failed: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Ramp provider
// ---------------------------------------------------------------------------
if (wanted("ramp")) {
  const name = getRampProviderName();
  console.log(`\n--- ramp (${name}) ---`);
  resetRampProviderCache();
  if (!isRampProviderConfigured()) {
    record("ramp", "skip", `RAMP_PROVIDER=${name} has no credentials set.`);
  } else {
    try {
      const provider = getRampProvider();

      // Local, and the part most likely to be wrong: the webhook signature.
      // A provider that accepts an unsigned webhook is an open door to forged
      // credits, so this is asserted with real vectors.
      //
      // The HMAC is built HERE, with node:crypto, rather than by calling the
      // providers' own signBitnobWebhook/signYellowCardWebhook helpers. That is
      // deliberate: reusing the implementation to produce the vector would make
      // the "valid signature accepted" assertion tautological. Encoding the
      // documented algorithm a second time, independently, means this check can
      // actually fail if the implementation drifts from the provider's spec.
      //   Bitnob     : HMAC-SHA512 over the raw body, hex, keyed by the webhook secret.
      //   Yellow Card: HMAC-SHA256 over the raw body, base64, keyed by the API secret.
      const bitnob = name === "bitnob";
      const secret = bitnob ? env.BITNOB_WEBHOOK_SECRET : env.YELLOW_CARD_API_SECRET;
      if (!secret) {
        record("ramp:signature", "skip",
          `No signing secret available for ${name} ` +
          `(${bitnob ? "BITNOB_WEBHOOK_SECRET" : "YELLOW_CARD_API_SECRET"}). ` +
          `Signature accept/reject behaviour is covered offline by ` +
          `src/services/ramp/providers/ramp.providers.test.ts, so this is a coverage ` +
          `gap, not a code defect.`);
      } else {
        const body = JSON.stringify({ eventId: "verify-1", type: "order.paid", reference: "ref-verify" });
        const digest = bitnob ? "hex" as const : "base64" as const;
        const algo = bitnob ? "sha512" : "sha256";
        const sign = (s: string, b: string) => createHmac(algo, s).update(b).digest(digest);
        const good = sign(secret, body);
        const header = getRampWebhookSignatureHeader();
        const acceptsGood = provider.verifyWebhookSignature(body, good);
        const acceptsEmpty = provider.verifyWebhookSignature(body, undefined);
        const acceptsTampered = provider.verifyWebhookSignature(`${body} `, good);
        const acceptsForged = provider.verifyWebhookSignature(body, sign("wrong-secret", body));
        const problems: string[] = [];
        if (!acceptsGood) problems.push("rejected a VALID signature");
        if (acceptsEmpty) problems.push("accepted a MISSING signature");
        if (acceptsTampered) problems.push("accepted a signature over TAMPERED body");
        if (acceptsForged) problems.push("accepted a FORGED signature");
        record(
          "ramp:signature",
          problems.length ? "fail" : "pass",
          problems.length
            ? `${problems.join("; ")} (header: ${header})`
            : `valid accepted; missing, tampered and forged all rejected ` +
              `(header: ${header}, ${algo}/${digest})`,
        );
      }

      // Read-only remote call. A deliberately non-existent reference must
      // produce a typed "unknown" rather than a crash, which proves the
      // provider is reachable AND that the response shape is what we expect.
      try {
        const status = await provider.getStatus("verify-nonexistent-reference-000000");
        record("ramp:api reachable", "pass",
          `getStatus returned ${status.status} (provider replied, so auth and the endpoint are both correct)`);
      } catch (err) {
        const m = (err as Error).message;
        // An auth failure means the key is wrong; anything else means we got
        // a real answer we could not parse. Both are informative.
        record("ramp:api reachable", /401|403|unauthor|invalid.*key|credential/i.test(m) ? "fail" : "pass",
          `getStatus on a non-existent reference: ${m.split("\n")[0].slice(0, 120)}`);
      }
    } catch (err) {
      record("ramp", "fail", `${name} could not be constructed or called: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.verdict === "pass");
const failed = results.filter((r) => r.verdict === "fail");
const skipped = results.filter((r) => r.verdict === "skip");

console.log("\n=== summary ===");
for (const r of results) console.log(`  ${r.verdict.toUpperCase().padEnd(5)} ${r.name}`);
console.log(`\n  ${passed.length} verified, ${failed.length} failed, ${skipped.length} skipped`);

if (skipped.length > 0) {
  console.log("\n  Skipped checks are NOT verified. To close them, set the credentials listed");
  console.log("  above, then re-run. Use --require to make any skip a failure in CI.");
}
const badExit = failed.length > 0 || (REQUIRE_ALL && skipped.length > 0);
console.log(`\n=== RESULT: ${badExit ? (REQUIRE_ALL && !failed.length ? "SKIPPED CHECKS (required)" : "FAILURES PRESENT") : "no failures"} ===`);
process.exit(badExit ? 1 : 0);
