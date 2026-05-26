-- CreateEnum
CREATE TYPE "public"."RateCorrectionStatus" AS ENUM ('PENDING', 'APPLIED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "public"."RateCorrectionMissingCostMode" AS ENUM ('FIX_PAYMENT_ONLY', 'CREATE_COST');

-- CreateTable
CREATE TABLE "public"."RateCorrectionBatch" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "merchantAccountId" TEXT NOT NULL,
    "accountType" "public"."AccountType" NOT NULL,
    "oldRates" JSONB NOT NULL,
    "newRates" JSONB NOT NULL,
    "dateFrom" TIMESTAMP(3),
    "dateTo" TIMESTAMP(3),
    "missingCostMode" "public"."RateCorrectionMissingCostMode" NOT NULL,
    "status" "public"."RateCorrectionStatus" NOT NULL DEFAULT 'PENDING',
    "paymentCount" INTEGER NOT NULL DEFAULT 0,
    "costCreatedCount" INTEGER NOT NULL DEFAULT 0,
    "estimatedImpact" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "appliedById" TEXT,
    "appliedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateCorrectionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RateCorrectionEntry" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "beforeFeeAmount" DECIMAL(12,4) NOT NULL,
    "beforeNetAmount" DECIMAL(12,4) NOT NULL,
    "beforeFeePercentage" DECIMAL(5,4) NOT NULL,
    "beforeVenueTxnFee" DECIMAL(12,4),
    "beforeVenueTxnNet" DECIMAL(12,4),
    "beforeVenueTxnNetSettlement" DECIMAL(12,4),
    "costCreated" BOOLEAN NOT NULL DEFAULT false,
    "beforeCostJson" JSONB,
    "afterFeeAmount" DECIMAL(12,4) NOT NULL,
    "afterNetAmount" DECIMAL(12,4) NOT NULL,
    "afterFeePercentage" DECIMAL(5,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateCorrectionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateCorrectionBatch_venueId_idx" ON "public"."RateCorrectionBatch"("venueId");

-- CreateIndex
CREATE INDEX "RateCorrectionBatch_merchantAccountId_idx" ON "public"."RateCorrectionBatch"("merchantAccountId");

-- CreateIndex
CREATE INDEX "RateCorrectionBatch_status_idx" ON "public"."RateCorrectionBatch"("status");

-- CreateIndex
CREATE INDEX "RateCorrectionBatch_createdAt_idx" ON "public"."RateCorrectionBatch"("createdAt");

-- CreateIndex
CREATE INDEX "RateCorrectionEntry_batchId_idx" ON "public"."RateCorrectionEntry"("batchId");

-- CreateIndex
CREATE INDEX "RateCorrectionEntry_paymentId_idx" ON "public"."RateCorrectionEntry"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "RateCorrectionEntry_batchId_paymentId_key" ON "public"."RateCorrectionEntry"("batchId", "paymentId");

-- AddForeignKey
ALTER TABLE "public"."RateCorrectionBatch" ADD CONSTRAINT "RateCorrectionBatch_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RateCorrectionBatch" ADD CONSTRAINT "RateCorrectionBatch_merchantAccountId_fkey" FOREIGN KEY ("merchantAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RateCorrectionBatch" ADD CONSTRAINT "RateCorrectionBatch_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "public"."Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RateCorrectionBatch" ADD CONSTRAINT "RateCorrectionBatch_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "public"."Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RateCorrectionEntry" ADD CONSTRAINT "RateCorrectionEntry_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."RateCorrectionBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RateCorrectionEntry" ADD CONSTRAINT "RateCorrectionEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "public"."Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
