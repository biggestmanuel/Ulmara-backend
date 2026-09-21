-- Idempotent transfer submits: a client-generated key (one per transfer
-- attempt) anchors replay detection. Unique + nullable: Postgres allows many
-- NULLs, so rows created before this field existed are unaffected.
ALTER TABLE "Transaction" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_idempotencyKey_key" ON "Transaction"("idempotencyKey");
