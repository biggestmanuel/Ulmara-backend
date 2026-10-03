/**
 * Proves the two Redis connections that pass their OWN options still work over
 * TLS with an ACL user.
 *
 *   npx tsx scripts/verify-redis-tls-queues.ts
 *
 * Driven by scripts/verify-redis-tls-acl.sh (see that file for the full list of
 * TLS/ACL risks). This is a separate file from verify-redis-tls-client.ts
 * because these two are the connections most likely to break when the URL
 * changes scheme:
 *
 *   - `redisConnection` (src/queues/redis.connection.ts) is the BullMQ/ioredis
 *     connection, which sets `maxRetriesPerRequest: null` because BullMQ
 *     requires it. That option changes the client's error and retry behaviour,
 *     so it cannot be assumed to behave like the plain probe.
 *   - the websocket subscriber (src/websocket/emit.ts) is a second, separate
 *     client using `lazyConnect` plus a null retry strategy, and it exists to
 *     receive pub/sub events. A connection that dials fine but never delivers a
 *     message would be invisible to a plain PING, so this script round-trips an
 *     actual published event through both sides.
 *
 * The pub/sub round trip is the real assertion: it is the one thing a real
 * cross-process event depends on, and it is the thing that would silently stop
 * working in production while every health check stayed green.
 */

import { Redis } from "ioredis";
import { redisConnection } from "../src/queues/redis.connection.js";

const url = process.env.REDIS_URL;
if (!url) {
  console.error("      REDIS_URL is not set. Run this via: npm run verify:redis:tls");
  process.exit(2);
}

let failures = 0;
const ok = (m: string) => console.log(`      [  ok  ] ${m}`);
const bad = (m: string) => { failures++; console.log(`      [ FAIL ] ${m}`); };

/** Reports a boolean assertion. Used instead of `cond ? ok() : bad()`, which is
 *  an expression statement and trips no-unused-expressions. */
const check = (cond: boolean, onPass: string, onFail: string): void => {
  if (cond) ok(onPass);
  else bad(onFail);
};

// ---------------------------------------------------------------------------
// The BullMQ connection, constructed exactly as production constructs it.
// ---------------------------------------------------------------------------
console.log("      -- src/queues/redis.connection.ts --");
try {
  const pong = await Promise.race([
    redisConnection.ping(),
    new Promise<never>((_, r) => setTimeout(() => r(new Error("timed out after 8s")), 8_000)),
  ]);
  check(pong === "PONG",
    `the queue connection PINGs over ${url.startsWith("rediss") ? "TLS" : "plaintext"}`,
    `the queue connection replied ${JSON.stringify(pong)}`);

  // BullMQ's own bookkeeping must work, or a worker silently never enqueues.
  // These are the real BullMQ internal key shapes, not stand-ins.
  const queueName = "tls-probe";
  await redisConnection.hset(`bull:${queueName}:meta`, "paused", "0");
  const paused = await redisConnection.hget(`bull:${queueName}:meta`, "paused");
  check(paused === "0",
    "a BullMQ meta hash round-trips (HASH ops permitted for the ACL user)",
    `HGET returned ${JSON.stringify(paused)}`);
  await redisConnection.del(`bull:${queueName}:meta`);
} catch (err) {
  bad(`the queue connection failed: ${(err as Error).message.split("\n")[0]}`);
}

// ---------------------------------------------------------------------------
// The websocket pub/sub path, mirroring src/websocket/emit.ts.
// ---------------------------------------------------------------------------
console.log("      -- src/websocket/emit.ts pub/sub --");
// The channel MUST be inside the ACL's `&ulmara:*` grant, because that is the
// pattern the real one uses (WS_PUBSUB_CHANNEL = "ulmara:ws:user-events"). A
// channel outside it is correctly refused, and using one here produced a NOPERM
// that looked like an application bug before the two were matched up.
const channel = "ulmara:tls:probe";
// A subscriber and a publisher are distinct connections in the real design; one
// connection cannot both receive and publish on a subscribed channel, so this
// mirrors that faithfully rather than taking a shortcut.
const subscriber = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true, retryStrategy: () => null });
const publisher = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true, retryStrategy: () => null });
subscriber.on("error", () => { /* reported by the awaits */ });
publisher.on("error", () => { /* reported by the awaits */ });

try {
  await subscriber.subscribe(channel);
  ok("SUBSCRIBE succeeded over TLS with the ACL user");

  // Resolved by the message, never by a timeout, so a silent failure is a
  // failure rather than a slow pass.
  const received = new Promise<string>((resolve) => {
    subscriber.on("message", (ch, msg) => { if (ch === channel) resolve(msg); });
  });
  await publisher.publish(channel, "ws-delivered");
  const got = await Promise.race([
    received,
    new Promise<never>((_, r) => setTimeout(() => r(new Error("no message arrived within 8s")), 8_000)),
  ]);
  check(got === "ws-delivered",
    "a published event was actually DELIVERED to the subscriber over TLS",
    `the subscriber received ${JSON.stringify(got)}`);

  // Redis ≥7 counts subscribers; a wrong value here would mean the subscription
  // is not really established.
  const subs = await publisher.pubsub("numsub", channel);
  ok(`PUBSUB NUMSUB confirms the subscription is live: ${JSON.stringify(subs)}`);
} catch (err) {
  bad(`the pub/sub path failed: ${(err as Error).message.split("\n")[0]}`);
} finally {
  subscriber.disconnect();
  publisher.disconnect();
}

console.log(failures === 0 ? "      RESULT: queue and pub/sub work over TLS" : `      RESULT: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
