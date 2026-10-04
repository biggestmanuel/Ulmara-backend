import crypto from "node:crypto";
import { prisma } from "../../config/database.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { reportError } from "../../config/sentry.js";
import { rampQueue } from "../../queues/ramp.queue.js";
import { isUniqueConstraintViolation } from "../../utils/prismaError.js";
import { HttpError } from "../../utils/apiResponse.js";
import {
  assertValidNgnAmount,
  getRampProvider,
  getRampProviderName,
  isRampProviderConfigured,
  RampProviderError,
  type RampCustomer,
  type RampStatusCanonical,
  type RampWebhookEvent,
} from "./providers/index.js";

/**
 * NGN fiat ramp orchestration.
 *
 * The service owns the ledger rows and the lifecycle; the provider adapter
 * (Bitnob or Yellow Card, chosen by RAMP_PROVIDER) owns every wire detail.
 * Nothing below branches on which provider is live.
 */

// HttpError, not a plain Error with a statusCode property: it is how the
// codebase marks a message as deliberately written for the user, and
// handleError only surfaces a 5xx message when the error is an HttpError. The
// previous Object.assign form made every one of these deliberate messages
// unreachable — a 503 whose text explained the outage reached the client as
// "Something went wrong".
function fail(statusCode: number, message: string): never {
  throw new HttpError(statusCode, message);
}

/** Provider status -> our enum. */
const STATUS_TO_ENUM: Record<RampStatusCanonical, "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED"> = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
};

/**
 * A terminal status is never walked backwards. Providers redeliver events and
 * can report out-of-order intermediate states; without this an "initialized"
 * arriving after "success" would reset a settled transaction to pending.
 */
const RANK: Record<"PENDING" | "PROCESSING" | "COMPLETED" | "FAILED", number> = {
  PENDING: 0,
  PROCESSING: 1,
  FAILED: 2,
  COMPLETED: 3,
};

async function loadUserCustomer(userId: string): Promise<{ email: string; name: string | null }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
  if (!user) fail(404, "Account not found");
  return user;
}

export const rampService = {
  /**
   * Starts an NGN -> balance deposit. Creates the ledger row first so a
   * webhook that races in before we finish the provider call still finds a row
   * to update.
   */
  async deposit(userId: string, input: { amountNgn: string }) {
    assertValidNgnAmount(input.amountNgn, env.RAMP_MIN_NGN, env.RAMP_MAX_NGN);
    if (!isRampProviderConfigured()) {
      logger.error({ event: "ramp_provider_unavailable", provider: getRampProviderName() }, "NGN deposit is unavailable");
      fail(503, "Naira deposits are temporarily unavailable. Please try again shortly.");
    }

    const user = await loadUserCustomer(userId);
    const reference = `DEP-${crypto.randomUUID()}`;
    const provider = getRampProvider();

    const existing = await prisma.rampTransaction.findUnique({ where: { reference } });
    if (existing) return existing;

    const rampTx = await prisma.rampTransaction.create({
      data: {
        userId,
        type: "DEPOSIT",
        amountNgn: input.amountNgn,
        provider: provider.name,
        reference,
        status: "PENDING",
      },
    });

    let customer: RampCustomer;
    try {
      customer = await provider.createCustomer({
        email: user.email,
        name: user.name ?? undefined,
        reference: `CUS-${rampTx.id}`,
      });
    } catch (err) {
      await markFailed(rampTx.id, describeError(err));
      throw err;
    }

    try {
      const instruction = await provider.createDeposit({
        reference,
        amountNgn: input.amountNgn,
        customer,
      });
      const updated = await prisma.rampTransaction.update({
        where: { id: rampTx.id },
        data: {
          providerReference: instruction.providerReference,
          providerCustomerId: customer.providerCustomerId,
          paymentInstructions: (instruction.paymentInstructions ?? undefined),
          status: STATUS_TO_ENUM[instruction.status],
        },
      });
      // The provider, not the queue, is the source of truth for ramp state:
      // completion arrives by webhook. The job only reconciles.
      await rampQueue.add(
        "reconcile-ramp",
        { rampTransactionId: rampTx.id },
        { delay: 30_000, attempts: 5, backoff: { type: "exponential", delay: 60_000 } },
      );
      return updated;
    } catch (err) {
      await markFailed(rampTx.id, describeError(err));
      throw err;
    }
  },

  /** Starts a balance -> NGN withdrawal to a Nigerian bank account. */
  async withdraw(
    userId: string,
    input: {
      amountNgn: string;
      accountNumber: string;
      bankCode: string;
      accountName: string;
    },
  ) {
    assertValidNgnAmount(input.amountNgn, env.RAMP_MIN_NGN, env.RAMP_MAX_NGN);
    if (!/^\d{10}$/.test(input.accountNumber)) {
      fail(400, "Enter a valid 10-digit Nigerian account number");
    }
    if (!input.bankCode?.trim()) fail(400, "Select a bank");
    if (!input.accountName?.trim()) fail(400, "Enter the account holder's name");
    if (!isRampProviderConfigured()) {
      logger.error({ event: "ramp_provider_unavailable", provider: getRampProviderName() }, "NGN withdrawal is unavailable");
      fail(503, "Naira withdrawals are temporarily unavailable. Please try again shortly.");
    }

    const user = await loadUserCustomer(userId);
    const reference = `WDR-${crypto.randomUUID()}`;
    const provider = getRampProvider();

    const rampTx = await prisma.rampTransaction.create({
      data: {
        userId,
        type: "WITHDRAWAL",
        amountNgn: input.amountNgn,
        provider: provider.name,
        reference,
        status: "PENDING",
      },
    });

    let customer: RampCustomer;
    try {
      customer = await provider.createCustomer({
        email: user.email,
        name: user.name ?? undefined,
        reference: `CUS-${rampTx.id}`,
      });
    } catch (err) {
      await markFailed(rampTx.id, describeError(err));
      throw err;
    }

    try {
      const instruction = await provider.createWithdrawal({
        reference,
        amountNgn: input.amountNgn,
        customer,
        bankAccount: {
          accountNumber: input.accountNumber,
          bankCode: input.bankCode,
          accountName: input.accountName,
        },
      });
      const updated = await prisma.rampTransaction.update({
        where: { id: rampTx.id },
        data: {
          providerReference: instruction.providerReference,
          providerCustomerId: customer.providerCustomerId,
          status: STATUS_TO_ENUM[instruction.status],
        },
      });
      await rampQueue.add(
        "reconcile-ramp",
        { rampTransactionId: rampTx.id },
        { delay: 30_000, attempts: 5, backoff: { type: "exponential", delay: 60_000 } },
      );
      return updated;
    } catch (err) {
      await markFailed(rampTx.id, describeError(err));
      throw err;
    }
  },

  async getStatus(userId: string, reference: string) {
    const rampTx = await prisma.rampTransaction.findFirst({ where: { reference, userId } });
    if (!rampTx) fail(404, "Ramp transaction not found");
    return {
      reference: rampTx.reference,
      status: rampTx.status,
      type: rampTx.type,
      amountNgn: rampTx.amountNgn.toString(),
      paymentInstructions: rampTx.paymentInstructions,
      failureReason: rampTx.failureReason,
      createdAt: rampTx.createdAt,
      updatedAt: rampTx.updatedAt,
    };
  },

  /**
   * Applies a verified webhook event exactly once.
   *
   * Idempotency is enforced by a unique insert on (provider, eventId): a
   * redelivery of the same event loses the race, and the caller still returns
   * 200 so the provider stops retrying.
   */
  async handleWebhook(params: {
    provider: string;
    event: RampWebhookEvent;
    rawPayload: unknown;
    signatureValid: boolean;
  }): Promise<{ applied: boolean; reason?: string }> {
    const { provider, event, rawPayload, signatureValid } = params;

    if (!event.reference) {
      logger.warn({ event: "ramp_webhook_no_reference", provider, type: event.type }, "Ignored a ramp webhook with no reference");
      return { applied: false, reason: "no_reference" };
    }

    try {
      await prisma.rampWebhookEvent.create({
        data: {
          provider,
          eventId: event.eventId,
          eventType: event.type,
          reference: event.reference,
          signatureValid,
          status: event.status,
          payload: (rawPayload ?? {}),
        },
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        logger.info(
          { event: "ramp_webhook_duplicate", provider, eventId: event.eventId, type: event.type },
          "Duplicate ramp webhook ignored",
        );
        return { applied: false, reason: "duplicate" };
      }
      throw err;
    }

    const rampTx = await prisma.rampTransaction.findUnique({ where: { reference: event.reference } });
    if (!rampTx) {
      // Recorded but not applied: a later reconciliation can pick this up.
      await prisma.rampWebhookEvent.updateMany({
        where: { provider, eventId: event.eventId },
        data: { processedAt: new Date() },
      });
      logger.warn(
        { event: "ramp_webhook_unmatched", provider, reference: event.reference, type: event.type },
        "Ramp webhook did not match a known transaction",
      );
      return { applied: false, reason: "unmatched_reference" };
    }

    // A signature that failed verification must never move money state. It is
    // still recorded so there is an audit trail of the attempt.
    if (!signatureValid) {
      logger.error(
        { event: "ramp_webhook_invalid_signature", provider, reference: event.reference, type: event.type },
        "Rejected a ramp webhook whose signature did not verify",
      );
      return { applied: false, reason: "invalid_signature" };
    }

    const nextStatus = STATUS_TO_ENUM[event.status];
    const current = rampTx.status;
    if (RANK[current] >= RANK[nextStatus]) {
      logger.info(
        { event: "ramp_webhook_stale", provider, reference: event.reference, from: current, to: nextStatus },
        "Ignored a ramp webhook that would move a transaction backwards",
      );
      await prisma.rampWebhookEvent.updateMany({
        where: { provider, eventId: event.eventId },
        data: { processedAt: new Date() },
      });
      return { applied: false, reason: "stale_status" };
    }

    await prisma.rampTransaction.update({
      where: { id: rampTx.id },
      data: {
        status: nextStatus,
        providerReference: event.providerReference ?? rampTx.providerReference,
        failureReason: event.failureReason ?? (nextStatus === "FAILED" ? "The provider reported a failure" : rampTx.failureReason),
        providerStatusRaw: event.status,
        lastSyncedAt: new Date(),
        ...(event.amountNgn ? { providerAmountNgn: event.amountNgn } : {}),
      },
    });
    await prisma.rampWebhookEvent.updateMany({
      where: { provider, eventId: event.eventId },
      data: { processedAt: new Date() },
    });

    logger.info(
      {
        event: "ramp_webhook_applied",
        provider,
        reference: event.reference,
        type: event.type,
        from: current,
        to: nextStatus,
        rampTransactionId: rampTx.id,
        userId: rampTx.userId,
      },
      "Ramp webhook applied",
    );
    return { applied: true };
  },

  /**
   * Pulls the authoritative state from the provider. Used by the ramp worker
   * as a backstop for missed webhooks (Bitnob explicitly recommends
   * reconciliation, and Yellow Card custody events have no retry at all).
   */
  async reconcile(reference: string): Promise<{ status: string; applied: boolean }> {
    const rampTx = await prisma.rampTransaction.findUnique({ where: { reference } });
    if (!rampTx) return { status: "UNKNOWN", applied: false };
    if (rampTx.status === "COMPLETED" || rampTx.status === "FAILED") {
      return { status: rampTx.status, applied: false };
    }
    if (!isRampProviderConfigured()) return { status: rampTx.status, applied: false };

    try {
      const result = await getRampProvider().getStatus(reference);
      const nextStatus = STATUS_TO_ENUM[result.status];
      const current = rampTx.status as keyof typeof RANK;
      if (RANK[current] >= RANK[nextStatus]) return { status: current, applied: false };
      await prisma.rampTransaction.update({
        where: { id: rampTx.id },
        data: {
          status: nextStatus,
          failureReason: result.failureReason,
          providerStatusRaw: result.status,
          lastSyncedAt: new Date(),
        },
      });
      logger.info(
        { event: "ramp_reconciled", reference, from: current, to: nextStatus },
        "Ramp transaction reconciled from the provider",
      );
      return { status: nextStatus, applied: true };
    } catch (err) {
      if (err instanceof RampProviderError) {
        logger.warn(
          { event: "ramp_reconcile_failed", reference, code: err.code, statusCode: err.statusCode },
          "Could not reconcile the ramp transaction",
        );
        // A 404 means the provider has no such record; stop retrying.
        if (err.statusCode === 404) {
          await prisma.rampTransaction.update({
            where: { id: rampTx.id },
            data: { status: "FAILED", failureReason: "The provider has no record of this transaction", lastSyncedAt: new Date() },
          });
        }
        return { status: rampTx.status, applied: false };
      }
      reportError(err, "Unexpected error reconciling a ramp transaction", { reference });
      return { status: rampTx.status, applied: false };
    }
  },
};

async function markFailed(rampTransactionId: string, reason: string): Promise<void> {
  await prisma.rampTransaction
    .update({
      where: { id: rampTransactionId },
      data: { status: "FAILED", failureReason: reason },
    })
    .catch((err) => reportError(err, "Could not mark a ramp transaction FAILED", { rampTransactionId }));
}

function describeError(err: unknown): string {
  if (err instanceof RampProviderError) {
    return `${err.provider} ${err.code}: ${err.message}`;
  }
  if (err instanceof Error) return err.message.slice(0, 300);
  return "Unknown provider error";
}
