/**
 * Proves the app's own Redis client can talk to a TLS + ACL endpoint.
 *
 *   npx tsx scripts/verify-redis-tls-client.ts <no-ca|extra-ca|explicit-ca>
 *
 * Driven by scripts/verify-redis-tls-acl.sh, which supplies REDIS_TLS_URL and
 * CA_CERT_FILE. This is a separate file from the shell driver because the
 * distinction that matters is between *redis-cli working* and *ioredis
 * working*: every Redis path in the app is `new Redis(env.REDIS_URL)` with no
 * extra options, so if ioredis cannot complete the handshake from a URL alone,
 * production will not either, and no amount of green CLI output changes that.
 *
 * The three modes are three separate PROCESS invocations, not three sections of
 * one run, and that is the whole point of the mode argument:
 *
 *   no-ca         What `new Redis(env.REDIS_URL)` does today. Against a private
 *                 CA this MUST fail. A pass here would mean the endpoint is not
 *                 actually verifying, which is the dangerous outcome.
 *   extra-ca      NODE_EXTRA_CA_CERTS, set by the driver before this process
 *                 starts. Node builds and caches its default trust store the
 *                 first time TLS is used, so the variable only has an effect if
 *                 it is present at process start — setting it from inside a
 *                 running process silently does nothing, and testing it that way
 *                 would wrongly conclude the env var is useless.
 *   explicit-ca   The URL plus an explicit `tls` option, i.e. the fix that lives
 *                 in application code rather than in the deployment.
 *
 * In every mode that connects, the ACL is then exercised through ioredis, so the
 * username/password in the URL are proven to arrive as `AUTH user pass` and the
 * operations the app depends on are proven to be permitted — not just reachable.
 */

import { readFileSync } from "node:fs";
import Redis from "ioredis";

const mode = process.argv[2] ?? "explicit-ca";
const url = process.env.REDIS_TLS_URL;
if (!url) {
  console.error("      REDIS_TLS_URL is not set. Run this via: npm run verify:redis:tls");
  process.exit(2);
}
const ca = process.env.CA_CERT_FILE ? readFileSync(process.env.CA_CERT_FILE) : undefined;

let failures = 0;
const ok = (m: string) => console.log(`        [  ok  ] ${m}`);
const bad = (m: string) => { failures++; console.log(`        [ FAIL ] ${m}`); };
const info = (m: string) => console.log(`        [ note ] ${m}`);

/** Reports a boolean assertion. Used instead of `cond ? ok() : bad()`, which is
 *  an expression statement and trips no-unused-expressions. */
const check = (cond: boolean, onPass: string, onFail: string): void => {
  if (cond) ok(onPass);
  else bad(onFail);
};

/**
 * ioredis collapses many TLS failures into a bare "Connection is closed.", which
 * hides the only interesting part. So the last 'error' event is captured
 * separately and reported alongside, rather than guessing from the message.
 */
async function probe(expect: "ok" | "refused", options: Redis.RedisOptions = {}): Promise<boolean> {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    retryStrategy: () => null,
    enableOfflineQueue: false,
    ...options,
  });
  let lastError = "";
  client.on("error", (err: Error) => { lastError = err.message.split("\n")[0]; });

  try {
    await client.connect();
    const reply = await client.ping();
    client.disconnect();
    if (expect === "ok" && reply === "PONG") { ok(`connected: PONG over ${url.split(":")[0]}://`); return true; }
    if (expect === "refused") { bad("connected when it was required to fail — the certificate is not being verified"); return false; }
    bad(`connected but replied ${JSON.stringify(reply)}`);
    return false;
  } catch (err) {
    client.disconnect();
    const m = (err as Error).message.split("\n")[0];
    const detail = lastError && !m.includes(lastError) ? `${m} (underlying: ${lastError})` : m;
    if (expect === "refused") { ok(`refused as required — ${detail.slice(0, 96)}`); return true; }
    bad(`could not connect — ${detail.slice(0, 110)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// The TLS handshake
// ---------------------------------------------------------------------------
if (mode === "no-ca") {
  if (!ca) { bad("CA_CERT_FILE is unset, so this mode cannot be tested"); process.exit(1); }
  // No NODE_EXTRA_CA_CERTS, and no tls option: the trust store is Node's default
  // public roots, which do not include our test CA.
  //
  // Refusal is the WHOLE point of this mode, so stop here. Continuing would
  // exercise the ACL probe, which passes an explicit `tls.ca` and would
  // therefore connect — reporting a success that says nothing about the mode
  // being tested.
  const refused = await probe("refused");
  console.log(refused
    ? "        RESULT: refused without a trusted CA, exactly as it must be. The URL alone is not sufficient for a private-CA endpoint."
    : "        RESULT: connected without trusting the CA — the endpoint is not verifying");
  process.exit(refused ? 0 : 1);
} else if (mode === "extra-ca") {
  if (!process.env.NODE_EXTRA_CA_CERTS) {
    bad("NODE_EXTRA_CA_CERTS is not set in this process; the driver must set it before exec");
    process.exit(1);
  }
  info(`NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS} (set at process start)`);
  await probe("ok");
} else if (mode === "explicit-ca") {
  if (!ca) { bad("CA_CERT_FILE is unset, so this mode cannot be tested"); process.exit(1); }
  await probe("ok", { tls: { ca, rejectUnauthorized: true } });
} else {
  bad(`unknown mode "${mode}"`);
  process.exit(2);
}

if (failures > 0) {
  console.log(`        RESULT: ${failures} failure(s) — skipping the ACL probe, the connection is not usable`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ACL correctness through the app's client, not just through redis-cli.
// ---------------------------------------------------------------------------
const tlsOptions: Redis.RedisOptions = ca ? { tls: { ca, rejectUnauthorized: true } } : {};
const client = new Redis(url, { maxRetriesPerRequest: 1, retryStrategy: () => null, ...tlsOptions });
client.on("error", () => { /* non-fatal; the awaits below report the outcome */ });
try {
  const expectedUser = url.match(/^rediss:\/\/([^:]+):/)?.[1];
  // NOT destructured. WHOAMI replies with a single bulk string, and
  // `const [who] = "avora"` destructures a STRING into its characters — which
  // silently yields "a" and fails the comparison for the wrong reason. Cost a
  // debugging cycle; noted so it is not written again.
  const who = await client.acl("WHOAMI") as unknown as string;
  check(who === expectedUser,
    `ACL WHOAMI returns "${who}", so the username in the URL is sent as AUTH user pass`,
    `ACL WHOAMI returned ${JSON.stringify(who)}, expected ${JSON.stringify(expectedUser)}`);

  // The OTP store's actual access pattern: an EX-TTL key plus Lua that reads and
  // writes. A key outside the granted pattern is not used here on purpose — it
  // would turn a permission problem into a confusing NOPERM.
  const key = "ulmara:tlsprobe";
  await client.set(key, "123456", "EX", 900);
  const ttl = await client.ttl(key);
  check(ttl > 890 && ttl <= 900,
    `EX TTL works over TLS: ${ttl}s (OTP_TTL_SECONDS=900)`,
    `EX TTL returned ${ttl}s, expected 890-900`);

  const read = await client.eval("return redis.call('GET', KEYS[1])", 1, key);
  check(read === "123456",
    "EVAL reads through redis.call over TLS",
    `EVAL returned ${JSON.stringify(read)}, expected "123456"`);

  const bumped = await client.eval("return redis.call('INCR', KEYS[1])", 1, "ulmara:tlsprobe:counter");
  check(bumped === 1,
    "EVAL writes through redis.call (the OTP attempt counter path)",
    `EVAL INCR returned ${JSON.stringify(bumped)}, expected 1`);

  const sha = (await client.script("LOAD", "return 1")) as string;
  check(sha.length >= 40,
    `SCRIPT LOAD works, so the Lua can be cached and later run by SHA (${sha.slice(0, 12)}…)`,
    `SCRIPT LOAD returned ${JSON.stringify(sha)}`);

  await client.del(key, "ulmara:tlsprobe:counter");
  check((await client.exists(key)) === 0, "DEL works over TLS", "DEL did not remove the key");

  // A wrong password must fail through ioredis too, not just through the CLI, or
  // the CLI result says nothing about the client.
  const wrong = new Redis(url.replace(/:[^:@]+@/, ":definitely-wrong@"), {
    maxRetriesPerRequest: 1, lazyConnect: true, retryStrategy: () => null, enableOfflineQueue: false, ...tlsOptions,
  });
  wrong.on("error", () => { /* expected */ });
  try {
    await wrong.connect();
    await wrong.ping();
    wrong.disconnect();
    bad("ioredis CONNECTED with a wrong password — the ACL is not enforced on this path");
  } catch {
    wrong.disconnect();
    ok("ioredis is rejected with a wrong password, so the ACL is enforced on the client's path too");
  }
} catch (err) {
  bad(`ACL/command probe failed: ${(err as Error).message.split("\n")[0]}`);
} finally {
  client.disconnect();
}

console.log(failures === 0 ? "        RESULT: all client checks passed" : `        RESULT: ${failures} client failure(s)`);
process.exit(failures === 0 ? 0 : 1);
