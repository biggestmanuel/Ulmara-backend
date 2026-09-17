-- AlterTable
ALTER TABLE "PaymentRequest"
ADD COLUMN "fulfilledTransactionId" TEXT,
ADD COLUMN "fulfilledAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRequest_fulfilledTransactionId_key" ON "PaymentRequest"("fulfilledTransactionId");
