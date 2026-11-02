-- CreateEnum
CREATE TYPE "OnlineOrderCardRefundStatus" AS ENUM ('REQUESTED', 'SENDING', 'PENDING', 'SUCCEEDED', 'RECORDED', 'FAILED', 'CANCELED', 'REVERSED', 'RESOLVED');

-- CreateTable
CREATE TABLE "OnlineOrderCardRefund" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "note" TEXT,
    "requestHash" TEXT NOT NULL,
    "stripeRefundId" TEXT,
    "status" "OnlineOrderCardRefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "refundPaymentId" TEXT,
    "feeRefundedCents" INTEGER,
    "stampReversedAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "alertedAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnlineOrderCardRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnlineOrderCardRefundReversal" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "cardRefundId" TEXT NOT NULL,
    "stripeRefundId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL,
    "failureReason" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "resolvedMethod" "PaymentMethod",
    "resolvedByStaffId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedNote" TEXT,
    "cashDrawerEventId" TEXT,

    CONSTRAINT "OnlineOrderCardRefundReversal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrderCardRefund_stripeRefundId_key" ON "OnlineOrderCardRefund"("stripeRefundId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrderCardRefund_refundPaymentId_key" ON "OnlineOrderCardRefund"("refundPaymentId");

-- CreateIndex
CREATE INDEX "OnlineOrderCardRefund_status_nextCheckAt_idx" ON "OnlineOrderCardRefund"("status", "nextCheckAt");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrderCardRefund_chargeId_key_key" ON "OnlineOrderCardRefund"("chargeId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrderCardRefundReversal_cardRefundId_key" ON "OnlineOrderCardRefundReversal"("cardRefundId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrderCardRefundReversal_stripeRefundId_key" ON "OnlineOrderCardRefundReversal"("stripeRefundId");

-- CreateIndex
CREATE INDEX "OnlineOrderCardRefundReversal_venueId_resolvedAt_idx" ON "OnlineOrderCardRefundReversal"("venueId", "resolvedAt");

-- AddForeignKey
ALTER TABLE "OnlineOrderCardRefund" ADD CONSTRAINT "OnlineOrderCardRefund_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "OnlineOrderCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlineOrderCardRefundReversal" ADD CONSTRAINT "OnlineOrderCardRefundReversal_cardRefundId_fkey" FOREIGN KEY ("cardRefundId") REFERENCES "OnlineOrderCardRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
