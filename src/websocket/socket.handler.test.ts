import { beforeEach, describe, expect, it, vi } from "vitest";

// The real socket.handler is imported; prisma and jwt are stubbed so the tests
// exercise the actual auth gate and the actual per-user room registry.
// NOTE: this test file lives in src/websocket/, next to the module under test,
// so the mock specifiers are `../config/...` — the SAME resolved path the
// module under test uses. A `../../` here would mock a different module.
const { db, jwtMock } = vi.hoisted(() => ({
  db: { session: { findUnique: vi.fn() } },
  jwtMock: { verifySessionToken: vi.fn() },
}));

vi.mock("../config/database.js", () => ({ prisma: db }));
vi.mock("../config/jwt.js", () => ({ verifySessionToken: jwtMock.verifySessionToken }));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

import {
  authenticateSocketToken,
  publishToUser,
  registerWebsocketHandlers,
  resetRooms,
  roomOccupancy,
} from "./socket.handler.js";

/** A stand-in for a real ws socket that records what it received. */
function fakeSocket(readyState = 1) {
  const sent: string[] = [];
  const handlers = new Map<string, (arg: unknown) => void>();
  const socket = {
    readyState,
    sent,
    closeCode: null as number | null,
    close: vi.fn((code: number) => {
      socket.closeCode = code;
      socket.readyState = 3;
    }),
    terminate: vi.fn(),
    send: vi.fn((frame: string) => sent.push(frame)),
    on: vi.fn((event: string, handler: (arg: unknown) => void) => handlers.set(event, handler)),
    emit: (event: string, arg: unknown) => handlers.get(event)?.(arg),
    listenerCount: () => handlers.size,
  };
  return socket;
}

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

function liveSession(userId: string) {
  return { userId, expiresAt: new Date(Date.now() + 60_000) };
}

/** Drives the /ws handler and returns the socket the connection produced. */
async function connect(token?: string) {
  // @fastify/websocket invokes the handler as `handler.call(this, socket,
  // request)` — the first argument IS the ws WebSocket. The fake is therefore
  // passed directly and deliberately has NO `.socket` property, so any handler
  // that reaches for `connection.socket` fails here rather than in production.
  type Handler = (conn: unknown, req: unknown) => void;
  let getHandler!: Handler;
  const app = {
    get: (_route: string, _opts: unknown, handler: Handler) => {
      getHandler = handler;
    },
    server: { clients: new Set() },
  };
  registerWebsocketHandlers(app as never);
  const req = { query: token ? { token } : {}, headers: {}, ip: "127.0.0.1" };
  const socket = fakeSocket();
  getHandler(socket, req);
  // Let the async auth settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return { socket, app, req };
}

beforeEach(() => {
  resetRooms();
  db.session.findUnique.mockReset();
  jwtMock.verifySessionToken.mockReset();
});

describe("authenticateSocketToken", () => {
  it("rejects a missing token", async () => {
    await expect(authenticateSocketToken(undefined)).resolves.toEqual({ ok: false, reason: "missing_token" });
  });

  it("rejects a token the verifier refuses", async () => {
    jwtMock.verifySessionToken.mockReturnValue({ ok: false, reason: "expired" });
    await expect(authenticateSocketToken("bad")).resolves.toEqual({ ok: false, reason: "expired" });
    expect(db.session.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a signed token with no server-side session (revoked/logged out)", async () => {
    jwtMock.verifySessionToken.mockReturnValue({ ok: true, claims: { sub: USER_A } });
    db.session.findUnique.mockResolvedValue(null);
    await expect(authenticateSocketToken("t")).resolves.toEqual({ ok: false, reason: "unknown_session" });
  });

  it("rejects an expired session", async () => {
    jwtMock.verifySessionToken.mockReturnValue({ ok: true, claims: { sub: USER_A } });
    db.session.findUnique.mockResolvedValue({ userId: USER_A, expiresAt: new Date(Date.now() - 1) });
    await expect(authenticateSocketToken("t")).resolves.toEqual({ ok: false, reason: "expired_session" });
  });

  it("rejects a token whose subject does not match its session", async () => {
    // Guards against a token borrowing another user's session row.
    jwtMock.verifySessionToken.mockReturnValue({ ok: true, claims: { sub: USER_B } });
    db.session.findUnique.mockResolvedValue(liveSession(USER_A));
    await expect(authenticateSocketToken("t")).resolves.toEqual({ ok: false, reason: "subject_mismatch" });
  });

  it("accepts a valid token bound to a live session", async () => {
    jwtMock.verifySessionToken.mockReturnValue({ ok: true, claims: { sub: USER_A } });
    db.session.findUnique.mockResolvedValue(liveSession(USER_A));
    await expect(authenticateSocketToken("t")).resolves.toEqual({ ok: true, userId: USER_A });
  });
});

describe("/ws connection authentication", () => {
  it("operates on the socket @fastify/websocket hands it, not a nested .socket", async () => {
    // Regression guard. A `ws@8` server-side WebSocket has no `.socket`
    // property (asserted against the installed runtime), so reading
    // `connection.socket` yields undefined and every later call throws. The
    // fake socket exposes no `.socket` either, so this fails loudly if the
    // handler ever starts unwrapping again.
    jwtMock.verifySessionToken.mockReturnValue({ ok: true, claims: { sub: USER_A } });
    db.session.findUnique.mockResolvedValue(liveSession(USER_A));
    const { socket } = await connect("good.jwt");
    expect("socket" in socket).toBe(false);
    // The very first thing the handler does with a valid token is greet it.
    expect(socket.sent[0]).toContain('"type":"connected"');
  });

  it("closes an unauthenticated connection with 4401 and admits it to no room", async () => {
    const { socket } = await connect();
    expect(socket.close).toHaveBeenCalledWith(4401, "Unauthorized");
    expect(socket.closeCode).toBe(4401);
    expect(roomOccupancy()).toEqual({});
  });

  it("closes an invalid-token connection with 4401", async () => {
    jwtMock.verifySessionToken.mockReturnValue({ ok: false, reason: "malformed" });
    const { socket } = await connect("garbage");
    expect(socket.closeCode).toBe(4401);
    expect(roomOccupancy()).toEqual({});
  });

  it("closes an expired-token connection with 4401", async () => {
    jwtMock.verifySessionToken.mockReturnValue({ ok: false, reason: "expired" });
    const { socket } = await connect("expired.jwt");
    expect(socket.closeCode).toBe(4401);
    expect(roomOccupancy()).toEqual({});
  });

  it("admits an authenticated connection and greets it with its userId", async () => {
    jwtMock.verifySessionToken.mockReturnValue({ ok: true, claims: { sub: USER_A } });
    db.session.findUnique.mockResolvedValue(liveSession(USER_A));
    const { socket } = await connect("good.jwt");

    expect(socket.close).not.toHaveBeenCalled();
    expect(roomOccupancy()).toEqual({ [USER_A]: 1 });
    const hello = JSON.parse(socket.sent[0]) as { type: string; userId: string };
    expect(hello.type).toBe("connected");
    expect(hello.userId).toBe(USER_A);
  });

  it("removes the socket from its room on disconnect", async () => {
    jwtMock.verifySessionToken.mockReturnValue({ ok: true, claims: { sub: USER_A } });
    db.session.findUnique.mockResolvedValue(liveSession(USER_A));
    const { socket } = await connect("good.jwt");
    expect(roomOccupancy()).toEqual({ [USER_A]: 1 });

    socket.emit("close", undefined);
    expect(roomOccupancy()).toEqual({});
  });
});

describe("per-user event isolation", () => {
  async function connectAs(userId: string) {
    jwtMock.verifySessionToken.mockReturnValue({ ok: true, claims: { sub: userId } });
    db.session.findUnique.mockResolvedValue(liveSession(userId));
    return (await connect(`token-${userId}`)).socket;
  }

  // The "connected" greeting legitimately advertises every event NAME, so
  // event-content assertions look only at frames after it.
  const events = (socket: ReturnType<typeof fakeSocket>) => socket.sent.slice(1);

  it("delivers a user's event only to that user's sockets", async () => {
    const a1 = await connectAs(USER_A);
    const a2 = await connectAs(USER_A);
    const b1 = await connectAs(USER_B);

    const delivered = publishToUser(USER_A, "transaction:updated", { transactionId: "t1" });

    expect(delivered).toBe(2);
    expect(events(a1)).toHaveLength(1);
    expect(events(a2)).toHaveLength(1);
    // The critical assertion: user B receives nothing.
    expect(events(b1)).toHaveLength(0);
    expect(b1.sent.join()).not.toContain("t1");
  });

  it("never exposes another user's events", async () => {
    const a = await connectAs(USER_A);
    const b = await connectAs(USER_B);

    publishToUser(USER_A, "transaction:updated", { secretForA: "user-a-only" });
    publishToUser(USER_B, "transaction:updated", { secretForB: "user-b-only" });

    const aFrames = events(a).join();
    const bFrames = events(b).join();
    expect(aFrames).toContain("user-a-only");
    expect(aFrames).not.toContain("user-b-only");
    expect(bFrames).toContain("user-b-only");
    expect(bFrames).not.toContain("user-a-only");
  });

  it("returns 0 and sends nothing for a user with no sockets", () => {
    expect(publishToUser("no-such-user", "transaction:updated", {})).toBe(0);
  });

  it("skips a socket that is no longer open", async () => {
    const a = await connectAs(USER_A);
    a.readyState = 3; // CLOSED
    expect(publishToUser(USER_A, "transaction:updated", {})).toBe(0);
  });

  it("keeps two users' rooms completely separate over many events", async () => {
    const a = await connectAs(USER_A);
    const b = await connectAs(USER_B);
    for (let i = 0; i < 25; i++) {
      publishToUser(USER_A, "transaction:updated", { i });
      publishToUser(USER_B, "balance:updated", { i });
    }
    // 25 own events each, and zero cross-contamination of event CONTENT.
    expect(events(a)).toHaveLength(25);
    expect(events(b)).toHaveLength(25);
    for (const frame of events(a)) expect(frame).toContain("transaction:updated");
    for (const frame of events(b)) expect(frame).toContain("balance:updated");
  });
});

describe("message handling", () => {
  it("answers a ping with a pong", async () => {
    jwtMock.verifySessionToken.mockReturnValue({ ok: true, claims: { sub: USER_A } });
    db.session.findUnique.mockResolvedValue(liveSession(USER_A));
    const { socket } = await connect("good.jwt");

    socket.emit("message", Buffer.from(JSON.stringify({ type: "ping" })));
    const pong = JSON.parse(socket.sent.at(-1)!) as { type: string };
    expect(pong.type).toBe("pong");
  });

  it("ignores an unparseable frame without closing the socket", async () => {
    jwtMock.verifySessionToken.mockReturnValue({ ok: true, claims: { sub: USER_A } });
    db.session.findUnique.mockResolvedValue(liveSession(USER_A));
    const { socket } = await connect("good.jwt");

    socket.emit("message", Buffer.from("not json"));
    expect(socket.close).not.toHaveBeenCalled();
    expect(roomOccupancy()).toEqual({ [USER_A]: 1 });
  });

  it("ignores a client frame that tries to name another user", async () => {
    // A client cannot subscribe itself to anything: rooms are server-side.
    jwtMock.verifySessionToken.mockReturnValue({ ok: true, claims: { sub: USER_A } });
    db.session.findUnique.mockResolvedValue(liveSession(USER_A));
    const { socket } = await connect("good.jwt");

    socket.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", userId: USER_B })));
    publishToUser(USER_B, "transaction:updated", { x: 1 });

    expect(roomOccupancy()).toEqual({ [USER_A]: 1 });
    expect(socket.sent.join()).not.toContain('"x":1');
  });
});
