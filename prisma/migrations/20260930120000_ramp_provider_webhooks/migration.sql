-- NGN ramp provider integration: provider correlation fields + idempotent
-- webhook receipts.
--
--   * RampTransaction gains the provider-side identifiers and the payment
--     instructions handed to the user, so a webhook or a support agent can
--     reconcile a transaction without re-querying the provider.
--   * RampWebhookEvent is an append-only audit log of every delivery. The
--     UNIQUE (provider, eventId) index is the idempotency guarantee: a
--     provider redelivery (Bitnob retries up to 3 times with exponential
--     backoff) loses the insert race and is acknowledged without being applied
--     a second time.
--
-- Apply with: npx prisma migrate deploy
--
-- AlterTable
ALTER TABLE "RampTransaction" ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "paymentInstructions" JSONB,
ADD COLUMN     "providerAmountNgn" DECIMAL(18,2),
ADD COLUMN     "providerCustomerId" TEXT,
ADD COLUMN     "providerReference" TEXT,
ADD COLUMN     "providerStatusRaw" TEXT;

-- CreateTable
CREATE TABLE "RampWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "reference" TEXT,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "RampWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RampWebhookEvent_reference_idx" ON "RampWebhookEvent"("reference");

-- CreateIndex
CREATE INDEX "RampWebhookEvent_processedAt_idx" ON "RampWebhookEvent"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RampWebhookEvent_provider_eventId_key" ON "RampWebhookEvent"("provider", "eventId");

