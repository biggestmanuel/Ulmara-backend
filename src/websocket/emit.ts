import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { getRedis } from "../queues/redis.client.js";
import { logger } from "../config/logger.js";
import { reportError } from "../config/sentry.js";
import { WS_PUBSUB_CHANNEL, type UserEvent } from "./events.js";
import { publishFrameToUser } from "./socket.handler.js";

/**
 * Cross-process user-event fan-out.
 *
 * Workers run in their own process (see src/worker/index.ts) and cannot touch
 * the API's sockets directly, so they PUBLISH a `{ userId, event, payload }`
 * envelope to Redis; every API instance SUBSCRIBES and forwards it to that
 * one user's socket room.
 *
 * Scoping guarantee: the destination room is computed from `userId` on the
 * receiving side, and the envelope carries no other addressing information,
 * so a subscriber can only ever reach the sockets of the user it names.
 */

let subscriber: Redis | null = null;
let started = false;

/** Publishes an event for one user. Safe to call from any process. */
export async function publishUserEvent(event: UserEvent): Promise<void> {
  if (!event?.userId || !event?.event) return;
  await getRedis().publish(WS_PUBSUB_CHANNEL, JSON.stringify(event));
}

/**
 * Subscribes this API instance to the pub/sub channel and wires each message
 * to the matching socket room. Idempotent: calling twice is a no-op.
 *
 * Returns true when the bridge is live. A Redis outage degrades real-time
 * delivery but must NOT prevent the API from serving REST — the bridge failure
 * is logged and reported rather than thrown, and the worker-side reconcile
 * jobs remain the source of truth for transaction/ramp state.
 */
export async function startUserEventBridge(): Promise<boolean> {
  if (started) return true;
  started = true;

  try {
    // A dedicated connection: a subscribed ioredis client cannot issue normal
    // commands, so this must not be the shared application client.
    subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true, retryStrategy: () => null });
    subscriber.on("error", (err: Error) => {
      logger.error({ err: err.message }, "WebSocket event subscriber error");
    });

    await subscriber.subscribe(WS_PUBSUB_CHANNEL);

    subscriber.on("message", (_channel: string, message: string) => {
      let envelope: UserEvent;
      try {
        envelope = JSON.parse(message) as UserEvent;
      } catch {
        logger.warn({ event: "ws_bridge_malformed" }, "Discarded a malformed WebSocket event envelope");
        return;
      }
      if (!envelope?.userId || !envelope?.event) {
        logger.warn({ event: "ws_bridge_incomplete" }, "Discarded an incomplete WebSocket event envelope");
        return;
      }
      // The ONLY addressing used is the server-side userId -> room mapping.
      publishFrameToUser(envelope.userId, JSON.stringify({ event: envelope.event, payload: envelope.payload }));
    });

    logger.info({ event: "ws_bridge_started" }, "WebSocket user-event bridge subscribed");
    return true;
  } catch (err) {
    started = false;
    reportError(err, "Could not start the WebSocket user-event bridge", { channel: WS_PUBSUB_CHANNEL });
    logger.error(
      { event: "ws_bridge_unavailable" },
      "Real-time WebSocket events are degraded; the API will continue serving requests",
    );
    return false;
  }
}

export async function stopUserEventBridge(): Promise<void> {
  if (!subscriber) return;
  const current = subscriber;
  subscriber = null;
  started = false;
  await current.quit().catch(() => current.disconnect());
}
