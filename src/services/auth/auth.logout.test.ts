import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// `POST /api/auth/logout` must end the caller's session ON THE SERVER.
//
// The route did not exist, and that was a hole rather than a missing nicety. The
// client's logout is purely local — `clearAllSecureItems()` in the app's
// `userStore.logout` — so nothing ever told the server the session was over.
// Because `requireAuth` treats the `Session` row as the source of truth, the
// token kept working for the full `JWT_EXPIRES_IN` (7 days by default) after the
// user believed they had signed out.
//
// Measured live on a throwaway account, after deleting the token from the device
// exactly as the app does:
//
//   GET    /api/account/me          -> 200
//   GET    /api/transaction        -> 200
//   GET    /api/contact            -> 200
//   POST   /api/payment/request    -> 201
//   sessions still on the server   -> 3
//
// Transfers were NOT reachable — the PIN gate is independent of the session, and
// a PIN cannot be replaced with a session token alone — but balances, contacts
// and payment requests were all readable, and payment requests creatable, for a
// week. That is exactly the window a lost or wiped phone leaves behind.
//
// `DELETE /api/auth/me` was the only server-side way to end a session and it
// deletes the account, so signing out previously cost the user their account.
//
// The load-bearing assertion in every test is on the SURVIVING SESSIONS, not the
// status code: an implementation that returned 200 and left the row in place
// would pass a status-only test and keep the hole open.
// ---------------------------------------------------------------------------

const USER = "user-1";
const OTHER_USER = "user-2";

interface SessionRow {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
}

const { sessions, db } = vi.hoisted(() => {
  const rows = new Map<string, SessionRow>();
  const db = {
    session: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const now = new Date();
        return [...rows.values()].filter((r) => r.userId === where.userId && r.expiresAt > now);
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        rows.delete(where.id);
        return row ?? {};
      }),
      // The one logout uses. A `deleteMany` on the TOKEN, not the userId — the
      // whole point is that signing out on one device leaves the others alone.
      deleteMany: vi.fn(async ({ where }: { where: { token?: string; userId?: string } }) => {
        const victims = [...rows.values()].filter(
          (r) =>
            (where.token !== undefined && r.token === where.token) ||
            (where.userId !== undefined && r.userId === where.userId),
        );
        for (const v of victims) rows.delete(v.id);
        return { count: victims.length };
      }),
      create: vi.fn(async ({ data }: { data: Omit<SessionRow, "id"> }) => {
        const row = { id: `sess-${rows.size + 1}`, ...data };
        rows.set(row.id, row);
        return row;
      }),
    },
  };
  return { sessions: rows, db };
});

vi.mock("../../config/database.js", () => ({ prisma: db }));
vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));
vi.mock("../../config/env.js", () => ({
  env: { DEV_VERIFICATION_MODE: false, NODE_ENV: "test", OTP_TTL_SECONDS: 600, OTP_EXPIRY_GRACE_SECONDS: 60 },
  isProd: false,
}));

const { authService } = await import("./auth.service.js");

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

function addSession(token: string, userId = USER, id?: string) {
  const row: SessionRow = {
    id: id ?? `sess-${token.slice(0, 6)}-${sessions.size}`,
    userId,
    token,
    expiresAt: inDays(7),
  };
  sessions.set(row.id, row);
  return row;
}

const tokens = (userId = USER) =>
  [...sessions.values()].filter((r) => r.userId === userId).map((r) => r.token).sort();

beforeEach(() => {
  sessions.clear();
  vi.clearAllMocks();
});

describe("authService.logout", () => {
  it("ends the caller's own session", async () => {
    const mine = addSession("token-a");
    addSession("token-b"); // a second device

    await expect(authService.logout(mine.token)).resolves.toEqual({ success: true });

    expect(tokens()).not.toContain("token-a");
  });

  it("leaves the user's OTHER devices signed in", async () => {
    const mine = addSession("token-a");
    const tablet = addSession("token-b");

    await authService.logout(mine.token);

    expect(tokens()).toEqual([tablet.token]);
  });

  // The bug this route exists to fix, stated as an assertion: the token the
  // user believed was dead is gone from the server.
  it("makes the token unusable afterwards — the row is what authorises it", async () => {
    const mine = addSession("token-a");

    await authService.logout(mine.token);

    expect(sessions.has(mine.id)).toBe(false);
    expect(await db.session.findUnique({ where: { id: mine.id } })).toBeNull();
  });

  it("never touches another user's session", async () => {
    const mine = addSession("token-a");
    const stranger = addSession("token-z", OTHER_USER);

    await authService.logout(mine.token);

    expect(sessions.has(stranger.id)).toBe(true);
  });

  it("never takes a userId, so it cannot sign out a whole account", async () => {
    addSession("token-a");
    addSession("token-b");
    const stranger = addSession("token-z", OTHER_USER);

    await authService.logout("token-a");

    // The delete predicate is the token alone. A userId-scoped delete would
    // have removed token-b as well, and this asserts the scope is not widened.
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { token: "token-a" } });
    expect(tokens()).toEqual(["token-b"]);
    expect(sessions.has(stranger.id)).toBe(true);
  });

  // Idempotent at the SERVICE level: a token with no row is a success. End to
  // end a second call is a 401 from requireAuth, which is correct for a logout and
  // is why this is asserted here rather than as a route test.
  it("is idempotent at the service level — a second logout still succeeds", async () => {
    const mine = addSession("token-a");
    await authService.logout(mine.token);

    await expect(authService.logout(mine.token)).resolves.toEqual({ success: true });
  });

  it("succeeds on a token with no session row at all", async () => {
    await expect(authService.logout("never-existed")).resolves.toEqual({ success: true });
  });

  it("never logs the token itself", async () => {
    const mine = addSession("super-secret-token-value");
    const { logger } = await import("../../config/logger.js");

    await authService.logout(mine.token);

    const serialised = JSON.stringify(
      (logger.info as ReturnType<typeof vi.fn>).mock.calls,
    );
    expect(serialised).not.toContain("super-secret-token-value");
  });
});

describe("revokeSession points logout at a route that exists", () => {
  // The old message said "log out instead" while no such route existed, so a user
  // following the error was told to do something impossible. It now names the
  // endpoint, which is asserted here so the two cannot drift apart again.
  it("names POST /api/auth/logout when asked to revoke your own session", async () => {
    const mine = addSession("token-a");
    addSession("token-b");

    await expect(
      authService.revokeSession(USER, mine.id, mine.token),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("POST /api/auth/logout"),
    });
  });

  it("still refuses to revoke your own session", async () => {
    const mine = addSession("token-a");

    await expect(authService.revokeSession(USER, mine.id, mine.token)).rejects.toBeTruthy();
    expect(sessions.has(mine.id)).toBe(true);
  });

  it("still revokes somebody else's session", async () => {
    addSession("token-a");
    const other = addSession("token-b");

    await expect(authService.revokeSession(USER, other.id, "token-a")).resolves.toEqual({
      success: true,
    });
    expect(sessions.has(other.id)).toBe(false);
  });
});