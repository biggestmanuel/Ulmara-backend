import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// account.service — the service behind /api/account/me, create-account-id,
// the public lookup, and the settings PATCH whose contract this hardening pass
// changed. It had no tests of its own; only the request SCHEMA was covered,
// which proves nothing about whether the write actually lands.
//
// The properties that matter:
//
//  1. updateSettings must distinguish an ABSENT key from an explicit `null`.
//     Prisma ignores `undefined` and writes `null`, so passing the parsed body
//     through verbatim is what makes "omit to leave alone, null to clear" work.
//     If the service ever normalised null to undefined, clearing would silently
//     become a no-op and the endpoint would 200 while doing nothing.
//
//  2. `me()` must never return passwordHash or pinHash. That is a security
//     boundary, not a formatting detail.
//
//  3. createAccountId must be one-per-user (409 on a second call) and must retry
//     on a collision rather than looping forever.
//
//  4. getByAccountId is PUBLIC (no auth on the route), so what it returns
//     matters more than an authenticated endpoint's would.
// ---------------------------------------------------------------------------

const { prismaMock, accountIds, users, generateAccountId } = vi.hoisted(() => {
  // Declared before the mocks that close over it: `let` is not hoisted into
  // scope, so using `accSeq` before this line is a TDZ error at call time.
  let accSeq = 0;
  const accountIds = new Map<string, { id: string; accountId: string; userId: string }>();
  const users = new Map<
    string,
    {
      id: string;
      email: string;
      passwordHash: string;
      pinHash: string | null;
      name: string | null;
      photoUrl: string | null;
      defaultCurrency: string;
      defaultLanguage: string;
      defaultNetwork: string | null;
    }
  >();
  const prismaMock = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = users.get(where.id);
        return row ? { ...row, accountId: accountIds.get(where.id) ?? null } : null;
      }),
      update: vi.fn(
        async ({
          where,
          data,
          select,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
          select?: Record<string, boolean>;
        }) => {
          const row = users.get(where.id);
          if (!row) throw Object.assign(new Error("No user"), { code: "P2025" });
          // Prisma semantics under test: `undefined` keys are NOT written,
          // `null` keys ARE. This is what makes omit-vs-null work.
          for (const [k, v] of Object.entries(data)) {
            if (v === undefined) continue;
            (row as Record<string, unknown>)[k] = v;
          }
          return select ? { ...row } : { ...row };
        },
      ),
    },
    accountId: {
      findUnique: vi.fn(async ({ where }: { where: { userId?: string; accountId?: string } }) => {
        for (const row of accountIds.values()) {
          if (where.userId && row.userId === where.userId) return { ...row };
          if (where.accountId && row.accountId === where.accountId) return { ...row };
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: { accountId: string; userId: string } }) => {
        const created = { id: `acc-${++accSeq}`, ...data };
        accountIds.set(data.userId, { ...created });
        return { ...created };
      }),
    },
  };
  return { prismaMock, accountIds, users, generateAccountId: vi.fn(() => "0000000001") };
});

vi.mock("../../config/database.js", () => ({ prisma: prismaMock }));
vi.mock("../../utils/generateAccountId.js", () => ({ generateAccountId }));

const { accountService } = await import("./account.service.js");

const USER = "user-1";

/** A row as Prisma would return it after a real write. */
function seedUser(over: Record<string, unknown> = {}) {
  users.set(USER, {
    id: USER,
    email: "fe@example.test",
    passwordHash: "bcrypt-hash",
    pinHash: "bcrypt-pin",
    name: null,
    photoUrl: null,
    defaultCurrency: "NGN",
    defaultLanguage: "en",
    defaultNetwork: null,
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  accountIds.clear();
  users.clear();
  seedUser();
});

describe("accountService.updateSettings — omit vs null", () => {
  it("passes an explicit null straight through so Prisma writes NULL", async () => {
    // The whole point of `.nullable().optional()`: this must not be normalised
    // away. If the service mapped null -> undefined, the endpoint would answer
    // 200 and clear nothing.
    await accountService.updateSettings(USER, { name: null, photoUrl: null, defaultNetwork: null });
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: null, photoUrl: null, defaultNetwork: null },
      }),
    );
    expect(users.get(USER)!.name).toBeNull();
    expect(users.get(USER)!.photoUrl).toBeNull();
    expect(users.get(USER)!.defaultNetwork).toBeNull();
  });

  it("writes nothing at all for an empty body", async () => {
    await accountService.updateSettings(USER, {});
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: {} }),
    );
    // Untouched: name/photoUrl/defaultNetwork are still null, not "set to null".
    expect(prismaMock.user.update.mock.calls[0][0].data).toEqual({});
  });

  it("leaves unmentioned columns alone when setting one field", async () => {
    seedUser({ name: "Ada", photoUrl: "https://x/p.png", defaultNetwork: "ETH" });
    await accountService.updateSettings(USER, { name: "Grace" });
    const row = users.get(USER)!;
    expect(row.name).toBe("Grace");
    // The load-bearing assertion: the others are NOT cleared.
    expect(row.photoUrl).toBe("https://x/p.png");
    expect(row.defaultNetwork).toBe("ETH");
  });

  it("updates only the columns it is given, in one write", async () => {
    seedUser({ name: "Ada" });
    await accountService.updateSettings(USER, { name: "Grace", defaultCurrency: "USD" });
    expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.user.update.mock.calls[0][0].data).toEqual({
      name: "Grace",
      defaultCurrency: "USD",
    });
  });

  it("never asks Prisma to write a credential column", async () => {
    await accountService.updateSettings(USER, { name: "Grace" });
    const data = prismaMock.user.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("pinHash");
    expect(data).not.toHaveProperty("passwordHash");
    expect(data).not.toHaveProperty("emailVerified");
  });
});

describe("accountService.me — credentials must not escape", () => {
  it("omits passwordHash and pinHash", async () => {
    const result = await accountService.me(USER);
    expect(result).not.toHaveProperty("passwordHash");
    expect(result).not.toHaveProperty("pinHash");
    // And it is not merely undefined — the key is absent, so JSON.stringify
    // cannot emit it either.
    expect(JSON.stringify(result)).not.toContain("bcrypt");
  });

  it("returns the profile fields and the nested accountId", async () => {
    accountIds.set(USER, { id: "acc-1", accountId: "0957683584", userId: USER });
    const result = await accountService.me(USER);
    expect(result).toMatchObject({
      email: "fe@example.test",
      defaultCurrency: "NGN",
      accountId: { accountId: "0957683584" },
    });
  });

  it("404s for an unknown user", async () => {
    await expect(accountService.me("no-such-user")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("accountService.createAccountId", () => {
  it("creates one and returns it", async () => {
    generateAccountId.mockReturnValue("0957683584");
    const row = await accountService.createAccountId(USER);
    expect(row).toMatchObject({ accountId: "0957683584", userId: USER });
  });

  it("409s on a second call rather than issuing a second ID", async () => {
    generateAccountId.mockReturnValue("0957683584");
    await accountService.createAccountId(USER);
    await expect(accountService.createAccountId(USER)).rejects.toMatchObject({
      statusCode: 409,
      message: "Account ID already created",
    });
  });

  it("retries on a collision instead of failing immediately", async () => {
    // A collision must cost one attempt, not the whole request.
    accountIds.set("someone-else", {
      id: "acc-x",
      accountId: "0000000001",
      userId: "someone-else",
    });
    generateAccountId
      .mockReturnValueOnce("0000000001") // taken
      .mockReturnValueOnce("0000000002"); // free
    const row = await accountService.createAccountId(USER);
    expect(row.accountId).toBe("0000000002");
    expect(generateAccountId).toHaveBeenCalledTimes(2);
  });

  it("gives up with a 500 after the retry budget, not an infinite loop", async () => {
    // Every candidate is taken by someone else.
    for (let i = 0; i < 10; i++) {
      accountIds.set(`other-${i}`, {
        id: `acc-${i}`,
        accountId: "0000000001",
        userId: `other-${i}`,
      });
    }
    generateAccountId.mockReturnValue("0000000001");
    await expect(accountService.createAccountId(USER)).rejects.toMatchObject({ statusCode: 500 });
    // Bounded: the documented budget is 5 attempts.
    expect(generateAccountId).toHaveBeenCalledTimes(5);
  });

  it("reports exhaustion with a message the user can act on", async () => {
    accountIds.set("other", { id: "acc-x", accountId: "0000000001", userId: "other" });
    generateAccountId.mockReturnValue("0000000001");
    // An HttpError, so handleError surfaces this on a 500 rather than
    // genericising it — that is the convention the other services follow.
    await expect(accountService.createAccountId(USER)).rejects.toMatchObject({
      message: "Could not generate a unique Account ID, try again",
    });
  });
});

describe("accountService.getByAccountId — this route is PUBLIC", () => {
  it("404s for an unknown Account ID", async () => {
    await expect(accountService.getByAccountId("0000000000")).rejects.toMatchObject({
      statusCode: 404,
      message: "Account ID not found",
    });
  });

  it("does not leak credential columns through the public lookup", async () => {
    accountIds.set(USER, { id: "acc-1", accountId: "0957683584", userId: USER });
    const record = await accountService.getByAccountId("0957683584");
    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain("bcrypt");
    expect(serialised).not.toContain("passwordHash");
  });
});
