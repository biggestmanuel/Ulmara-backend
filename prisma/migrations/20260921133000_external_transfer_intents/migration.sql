-- CreateEnum
CREATE TYPE "ExternalIntentStatus" AS ENUM ('READY', 'USED');

-- CreateTable
CREATE TABLE "ExternalTransferIntent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "recipient" TEXT NOT NULL,
    "fee" TEXT,
    "status" "ExternalIntentStatus" NOT NULL DEFAULT 'READY',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalTransferIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalTransferIntent_userId_idx" ON "ExternalTransferIntent"("userId");

-- CreateIndex
CREATE INDEX "ExternalTransferIntent_status_expiresAt_idx" ON "ExternalTransferIntent"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalTransferIntent_transactionId_key" ON "ExternalTransferIntent"("transactionId");

-- AddForeignKey
ALTER TABLE "ExternalTransferIntent" ADD CONSTRAINT "ExternalTransferIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalTransferIntent" ADD CONSTRAINT "ExternalTransferIntent_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
