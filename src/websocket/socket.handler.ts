import type { FastifyInstance, FastifyRequest } from "fastify";
import type ws from "ws";
import { verifySessionToken } from "../config/jwt.js";
import { prisma } from "../config/database.js";
import { logger } from "../config/logger.js";
import { WS_EVENTS } from "./events.js";

/**
 * WebSocket authentication + per-user event fan-out.
 *
 * Connection contract (unchanged for the client): GET /ws?token=<jwt>
 * (or Sec-WebSocket-Protocol: bearer,<jwt> for browser clients that cannot
 * set headers).
 *
 * A socket is authenticated BEFORE it is admitted to a user room, and events
 * are delivered by walking that user's room only. `ws` has no room support of
 * its own, so the registry below is explicit — which also makes the
 * isolation guarantee directly testable: a socket for user A is only ever
 * reachable through user A's Set.
 *
 * Close codes:
 *   4401 - no token supplied
 *   4401 - malformed / invalid / retired-key token
 *   4401 - valid signature but no live server-side session (revoked/expired)
 */

const UNAUTHORIZED = 4401;

type AuthenticatedSocket = ws & { data?: { userId?: string } };

/** userId -> that user's live sockets. The ONLY addressing used for events. */
const userRooms = new Map<string, Set<ws>>();

/** The `ws` server @fastify/websocket attaches to the raw HTTP server. */
function wsServer(app: FastifyInstance): { clients: Set<ws> } {
  const server = app.server as unknown as { clients?: Set<ws> };
  if (!server.clients) {
    throw new Error("WebSocket server is not initialised; register @fastify/websocket first");
  }
  return server as { clients: Set<ws> };
}

/**
 * Resolves the user a token belongs to, or a reason it does not.
 *
 * Checks the signature (honouring JWT rotation) and then the server-side
 * session row, matching the HTTP `requireAuth` gate exactly so a token that
 * works over REST also works over the socket and vice versa.
 */
export async function authenticateSocketToken(
  token: string | undefined,
): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  if (!token) return { ok: false, reason: "missing_token" };

  const verified = verifySessionToken(token);
  if (!verified.ok) {
    return { ok: false, reason: verified.reason };
  }

  const session = await prisma.session.findUnique({ where: { token } });
  if (!session) return { ok: false, reason: "unknown_session" };
  if (session.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired_session" };
  if (session.userId !== verified.claims.sub) return { ok: false, reason: "subject_mismatch" };

  return { ok: true, userId: verified.claims.sub };
}

function addToRoom(userId: string, socket: ws): void {
  const room = userRooms.get(userId) ?? new Set<ws>();
  room.add(socket);
  userRooms.set(userId, room);
}

function removeFromRoom(userId: string, socket: ws): void {
  const room = userRooms.get(userId);
  if (!room) return;
  room.delete(socket);
  if (room.size === 0) userRooms.delete(userId);
}

/**
 * Delivers an event to exactly one user's sockets.
 *
 * Scoping is structural: the recipient set is `userRooms.get(userId)` and
 * nothing else is consulted, so a socket can never observe another user's
 * traffic. Returns how many sockets received it (for logging and tests).
 *
 * The wire format is a single JSON envelope, `{ event, payload }`, so a
 * client parses one shape regardless of which event it is.
 */
export function publishToUser(userId: string, event: string, payload: unknown): number {
  if (!userId || !event) return 0;
  return publishFrameToUser(userId, JSON.stringify({ event, payload }));
}

/** Delivers a pre-framed payload (used by the Redis bridge). */
export function publishFrameToUser(userId: string, frame: string): number {
  if (!userId) return 0;
  const room = userRooms.get(userId);
  if (!room) return 0;
  let delivered = 0;
  for (const socket of room) {
    // 1 === WebSocket.OPEN. Compared numerically to avoid importing the enum.
    if ((socket as { readyState?: number }).readyState === 1) {
      try {
        socket.send(frame);
        delivered++;
      } catch (err) {
        logger.warn({ err, userId }, "Could not deliver a WebSocket event");
      }
    }
  }
  return delivered;
}

/** Test seam: current room occupancy per user (never used in production logic). */
export function roomOccupancy(): Record<string, number> {
  return Object.fromEntries([...userRooms].map(([userId, set]) => [userId, set.size]));
}

/** Test seam: drops every tracked socket. */
export function resetRooms(): void {
  userRooms.clear();
}

function tokenFrom(request: FastifyRequest): string | undefined {
  const query = request.query as { token?: string } | undefined;
  if (typeof query?.token === "string" && query.token) return query.token;
  // `sec-websocket-protocol` arrives as either one string or a list of them.
  // The annotation forces the compiler to check the narrowing instead of
  // letting an `any` header value flow into the token comparison.
  const header = request.headers["sec-websocket-protocol"] as string | string[] | undefined;
  const raw: string | undefined = Array.isArray(header) ? header[0] : header;
  if (typeof raw === "string" && raw.toLowerCase().startsWith("bearer,")) {
    return raw.slice("bearer,".length).trim() || undefined;
  }
  return undefined;
}

export function registerWebsocketHandlers(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (connection, request) => {
    // @fastify/websocket invokes this handler as `handler.call(this, socket,
    // request)`, i.e. the first argument IS the `ws` WebSocket instance. A
    // `ws@8` server-side socket does not expose a `.socket` property (verified
    // against the installed runtime), so the connection is used directly.
    const socket = connection as AuthenticatedSocket;

    void (async () => {
      const auth = await authenticateSocketToken(tokenFrom(request));
      if (!auth.ok) {
        // Reject BEFORE admission to any room: an unauthenticated socket is
        // in no room, so it is unreachable by any publishToUser call.
        logger.warn({ event: "ws_unauthorized", reason: auth.reason, ip: request.ip }, "Rejected a WebSocket connection");
        try {
          socket.close(UNAUTHORIZED, "Unauthorized");
        } catch {
          socket.terminate();
        }
        return;
      }

      socket.data = { userId: auth.userId };
      const wss = wsServer(app);
      wss.clients.add(socket);
      addToRoom(auth.userId, socket);

      logger.info({ event: "ws_connected", userId: auth.userId }, "WebSocket authenticated and admitted");

      socket.on("close", () => {
        removeFromRoom(auth.userId, socket);
        wss.clients.delete(socket);
        logger.info({ event: "ws_disconnected", userId: auth.userId }, "WebSocket disconnected");
      });

      socket.on("message", (message: Buffer) => {
        // Server -> client only. Echo a ping so clients can measure liveness
        // without the server interpreting client frames.
        try {
          const parsed = JSON.parse(message.toString()) as { type?: string };
          if (parsed?.type === "ping") {
            socket.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
          }
        } catch {
          // Unparseable frames are ignored; they carry no authority.
        }
      });

      socket.send(JSON.stringify({ type: "connected", userId: auth.userId, events: Object.values(WS_EVENTS) }));
    })();
  });
}
