import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * rampService webhook handling, against an in-memory model of the two Prisma
 * tables it touches (RampTransaction + RampWebhookEvent). The unique-constraint
 * behaviour the idempotency guarantee rests on is modelled explicitly, because
 * that constraint is what makes a redelivery a no-op.
 */

interface RampRow {
  id: string;
  userId: string;
  type: string;
  amountNgn: { toString(): string };
  provider: string;
  reference: string;
  status: string;
  providerReference: string | null;
  paymentInstructions: unknown;
  failureReason: string | null;
  providerStatusRaw: string | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
interface EventRow {
  id: string;
  provider: string;
  eventId: string;
  eventType: string;
  reference: string | null;
  signatureValid: boolean;
  status: string | null;
  processedAt: Date | null;
}

// A mutable holder the tests drive. It lives in the SAME vi.hoisted block as
// the fake database because vi.mock factories are invoked while the hoisted
// imports are being resolved — i.e. before module-level `const`s initialise — so
// a factory closing over one would hit the temporal dead zone.
const { db, state, provider } = vi.hoisted(() => {
  const rampTx = new Map<string, RampRow>();
  const events = new Map<string, EventRow>();
  let seq = 0;
  const makeDb = () => ({
    rampTransaction: {
      findUnique: vi.fn(async ({ where }: { where: { reference?: string; id?: string } }) => {
        if (where.reference) return [...rampTx.values()].find((r) => r.reference === where.reference) ?? null;
        return rampTx.get(where.id!) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date();
        const row = {
          id: `ramp-${++seq}`,
          userId: data.userId as string,
          type: data.type as string,
          amountNgn: { toString: () => String(data.amountNgn) },
          provider: data.provider as string,
          reference: data.reference as string,
          status: (data.status as string) ?? "PENDING",
          providerReference: null,
          paymentInstructions: null,
          failureReason: null,
          providerStatusRaw: null,
          lastSyncedAt: null,
          createdAt: now,
          updatedAt: now,
        } as RampRow;
        rampTx.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rampTx.get(where.id)!;
        Object.assign(row, data);
        row.updatedAt = new Date();
        return row;
      }),
    },
    rampWebhookEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const key = `${String(data.provider)}:${String(data.eventId)}`;
        if (events.has(key)) {
          // Mirrors the UNIQUE(provider, eventId) constraint: P2002.
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = {
          id: `evt-${++seq}`,
          provider: data.provider as string,
          eventId: data.eventId as string,
          eventType: data.eventType as string,
          reference: (data.reference as string) ?? null,
          signatureValid: Boolean(data.signatureValid),
          status: (data.status as string) ?? null,
          processedAt: null,
        } as EventRow;
        events.set(key, row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { provider: string; eventId: string }; data: Record<string, unknown> }) => {
        const row = events.get(`${where.provider}:${where.eventId}`);
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      }),
    },
  });
  const holder = {
    getRampProviderName: () => "bitnob",
    isRampProviderConfigured: () => true,
    // Delegates to the mutable `getStatus` so a test can swap the provider
    // response; a re-assigned export would not be visible through the live
    // ESM binding.
    getRampProvider: () => ({
      getStatus: (reference: string) => holder.getStatus(reference),
    }),
    // Typed loosely on `status` so a test can return any canonical status
    // without fighting a narrow literal type.
    getStatus: async (_reference: string): Promise<{
      reference: string;
      providerReference: string;
      status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
      amountNgn: string;
    }> => ({
      reference: "",
      providerReference: "",
      status: "PENDING",
      amountNgn: "0",
    }),
    assertValidNgnAmount: () => undefined,
    RampProviderError: class extends Error {},
  };
  return {
    state: {
      rampTx,
      events,
      reset: () => {
        rampTx.clear();
        events.clear();
        seq = 0;
      },
      seed(over: Partial<RampRow> = {}): RampRow {
        const now = new Date();
        const row = {
          id: "ramp-1",
          userId: "user-1",
          type: "WITHDRAWAL",
          amountNgn: { toString: () => "10000" },
          provider: "bitnob",
          reference: "WDR-1",
          status: "PENDING",
          providerReference: null,
          paymentInstructions: null,
          failureReason: null,
          providerStatusRaw: null,
          lastSyncedAt: null,
          createdAt: now,
          updatedAt: now,
          ...over,
        };
        rampTx.set(row.id, row);
        return row;
      },
    },
    provider: holder,
    db: makeDb(),
  };
});

vi.mock("../../config/database.js", () => ({ prisma: db }));
// NOTE: this test file lives in src/services/ramp/, next to the module under
// test, so the mock specifier is `./providers/index.js` — the SAME resolved
// path ramp.service.ts imports. A `../providers/` here would mock a different
// (non-existent) module and leave the real provider layer in play.
vi.mock("./providers/index.js", () => provider);
vi.mock("../../queues/ramp.queue.js", () => ({ rampQueue: { add: vi.fn() } }));
vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock("../../config/sentry.js", () => ({ reportError: vi.fn() }));
vi.mock("../../config/env.js", () => ({ env: { RAMP_MIN_NGN: 1000, RAMP_MAX_NGN: 5_000_000, NODE_ENV: "test" } }));

import { rampService } from "./ramp.service.js";

/** A canonical webhook event as a provider adapter would produce. */
function event(over: Partial<Parameters<typeof rampService.handleWebhook>[0]["event"]> = {}) {
  return {
    type: "payouts.withdrawal.success",
    reference: "WDR-1",
    status: "COMPLETED" as const,
    amountNgn: "10000",
    providerReference: "payout_1",
    eventId: "evt-1",
    raw: { anything: true },
    ...over,
  };
}

beforeEach(() => {
  state.reset();
  vi.clearAllMocks();
  provider.getStatus = async (_reference: string) => ({
    reference: "",
    providerReference: "",
    status: "PENDING" as const,
    amountNgn: "0",
  });
});

describe("ramp webhook idempotency", () => {
  it("applies a first delivery and moves the transaction to COMPLETED", async () => {
    state.seed({ status: "PROCESSING" });
    const result = await rampService.handleWebhook({
      provider: "bitnob",
      event: event(),
      rawPayload: {},
      signatureValid: true,
    });

    expect(result).toEqual({ applied: true });
    expect(state.rampTx.get("ramp-1")!.status).toBe("COMPLETED");
    expect(state.rampTx.get("ramp-1")!.providerReference).toBe("payout_1");
    expect(state.rampTx.get("ramp-1")!.lastSyncedAt).not.toBeNull();
  });

  it("ignores a redelivery of the SAME event id", async () => {
    state.seed({ status: "PROCESSING" });
    await rampService.handleWebhook({ provider: "bitnob", event: event(), rawPayload: {}, signatureValid: true });
    // Simulate a provider retry after the row was already moved: force it back
    // to PROCESSING, then redeliver the identical event.
    state.rampTx.get("ramp-1")!.status = "PROCESSING";

    const second = await rampService.handleWebhook({
      provider: "bitnob",
      event: event(),
      rawPayload: {},
      signatureValid: true,
    });

    expect(second).toEqual({ applied: false, reason: "duplicate" });
    // The redelivery did NOT re-apply.
    expect(state.rampTx.get("ramp-1")!.status).toBe("PROCESSING");
  });

  it("applies exactly once under concurrent identical deliveries", async () => {
    state.seed({ status: "PROCESSING" });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        rampService.handleWebhook({ provider: "bitnob", event: event(), rawPayload: {}, signatureValid: true }),
      ),
    );
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(results.filter((r) => !r.applied)).toHaveLength(7);
    expect(state.rampTx.get("ramp-1")!.status).toBe("COMPLETED");
    // Only one receipt row was ever created.
    expect(state.events.size).toBe(1);
  });

  it("treats a different event id as a new event, not a duplicate", async () => {
    state.seed({ status: "PENDING" });
    await rampService.handleWebhook({ provider: "bitnob", event: event(), rawPayload: {}, signatureValid: true });
    // Rewind the row so the next event is genuinely newer, then deliver a
    // distinct event id for the same reference.
    state.rampTx.get("ramp-1")!.status = "PENDING";
    const second = await rampService.handleWebhook({
      provider: "bitnob",
      event: event({ eventId: "evt-2", type: "payouts.processing", status: "PROCESSING" }),
      rawPayload: {},
      signatureValid: true,
    });
    expect(second.applied).toBe(true);
    expect(state.rampTx.get("ramp-1")!.status).toBe("PROCESSING");
    expect(state.events.size).toBe(2);
  });

  it("scopes uniqueness per provider, so two providers cannot collide", async () => {
    state.seed({ status: "PROCESSING" });
    await rampService.handleWebhook({ provider: "bitnob", event: event(), rawPayload: {}, signatureValid: true });
    state.rampTx.get("ramp-1")!.status = "PROCESSING";
    const other = await rampService.handleWebhook({
      provider: "yellowcard",
      event: event(),
      rawPayload: {},
      signatureValid: true,
    });
    expect(other.applied).toBe(true);
  });
});

describe("ramp webhook safety", () => {
  it("never applies an event whose signature did not verify", async () => {
    state.seed({ status: "PENDING" });
    const result = await rampService.handleWebhook({
      provider: "bitnob",
      event: event({ status: "COMPLETED" }),
      rawPayload: {},
      signatureValid: false,
    });
    expect(result).toEqual({ applied: false, reason: "invalid_signature" });
    expect(state.rampTx.get("ramp-1")!.status).toBe("PENDING");
    // It is still recorded, for an audit trail of the attempt.
    expect(state.events.size).toBe(1);
    expect([...state.events.values()][0].signatureValid).toBe(false);
  });

  it("never walks a transaction backwards", async () => {
    // A late "initialized" arriving after "success" must not reset the row.
    state.seed({ status: "COMPLETED" });
    const result = await rampService.handleWebhook({
      provider: "bitnob",
      event: event({ status: "PENDING", type: "payouts.initialized", eventId: "evt-late" }),
      rawPayload: {},
      signatureValid: true,
    });
    expect(result).toEqual({ applied: false, reason: "stale_status" });
    expect(state.rampTx.get("ramp-1")!.status).toBe("COMPLETED");
  });

  it("ignores an event with no reference", async () => {
    state.seed();
    const result = await rampService.handleWebhook({
      provider: "bitnob",
      event: event({ reference: "" }),
      rawPayload: {},
      signatureValid: true,
    });
    expect(result).toEqual({ applied: false, reason: "no_reference" });
  });

  it("records but does not apply an event for an unknown reference", async () => {
    state.seed();
    const result = await rampService.handleWebhook({
      provider: "bitnob",
      event: event({ reference: "WDOES-NOT-EXIST", eventId: "evt-x" }),
      rawPayload: {},
      signatureValid: true,
    });
    expect(result).toEqual({ applied: false, reason: "unmatched_reference" });
    expect(state.rampTx.get("ramp-1")!.status).toBe("PENDING");
  });

  it("records a machine-readable failure reason on a FAILED outcome", async () => {
    state.seed({ status: "PROCESSING" });
    await rampService.handleWebhook({
      provider: "bitnob",
      event: event({ status: "FAILED", type: "payouts.withdrawal.expired", failureReason: "Quote expired" }),
      rawPayload: {},
      signatureValid: true,
    });
    const row = state.rampTx.get("ramp-1")!;
    expect(row.status).toBe("FAILED");
    expect(row.failureReason).toBe("Quote expired");
  });
});

describe("ramp reconciliation", () => {
  it("pulls the provider state and applies it when it is newer", async () => {
    state.seed({ status: "PENDING" });
    provider.getStatus = async () => ({
      reference: "WDR-1",
      providerReference: "payout_1",
      status: "COMPLETED" as const,
      amountNgn: "10000",
    });

    const result = await rampService.reconcile("WDR-1");
    expect(result).toEqual({ status: "COMPLETED", applied: true });
    expect(state.rampTx.get("ramp-1")!.status).toBe("COMPLETED");
  });

  it("leaves a terminal transaction alone without calling the provider", async () => {
    state.seed({ status: "COMPLETED" });
    const calls: string[] = [];
    provider.getStatus = async (reference: string) => {
      calls.push(reference);
      return { reference, providerReference: "p", status: "PENDING" as const, amountNgn: "0" };
    };
    const result = await rampService.reconcile("WDR-1");
    expect(result).toEqual({ status: "COMPLETED", applied: false });
    expect(calls).toHaveLength(0);
  });

  it("does not move a completed row backwards from a stale provider read", async () => {
    state.seed({ status: "COMPLETED" });
    provider.getStatus = async (reference: string) => ({
      reference,
      providerReference: "payout_1",
      status: "PROCESSING" as const,
      amountNgn: "10000",
    });
    // reconcile short-circuits on a terminal row, so this is belt-and-braces.
    const result = await rampService.reconcile("WDR-1");
    expect(result.applied).toBe(false);
    expect(state.rampTx.get("ramp-1")!.status).toBe("COMPLETED");
  });
});
