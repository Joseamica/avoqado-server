-- CreateEnum
CREATE TYPE "CustomerApprovalEvent" AS ENUM ('REQUESTED_STAFF', 'PENDING_CUSTOMER', 'APPROVED_CUSTOMER', 'REJECTED_CUSTOMER');

-- CreateEnum
CREATE TYPE "CustomerApprovalDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "CustomerApprovalChannel" AS ENUM ('EMAIL', 'WHATSAPP');

-- CreateTable
CREATE TABLE "CustomerApprovalOutbox" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "event" "CustomerApprovalEvent" NOT NULL,
    "approvalVersion" INTEGER NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerApprovalOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerApprovalDelivery" (
    "id" TEXT NOT NULL,
    "outboxId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "channel" "CustomerApprovalChannel" NOT NULL,
    "providerKey" TEXT NOT NULL,
    "status" "CustomerApprovalDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerApprovalDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerApprovalOutbox_dedupeKey_key" ON "CustomerApprovalOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "CustomerApprovalOutbox_venueId_customerId_approvalVersion_idx" ON "CustomerApprovalOutbox"("venueId", "customerId", "approvalVersion");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerApprovalDelivery_providerKey_key" ON "CustomerApprovalDelivery"("providerKey");

-- CreateIndex
CREATE INDEX "CustomerApprovalDelivery_status_nextAttemptAt_idx" ON "CustomerApprovalDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "CustomerApprovalDelivery_status_leaseUntil_idx" ON "CustomerApprovalDelivery"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerApprovalDelivery_outboxId_recipient_channel_key" ON "CustomerApprovalDelivery"("outboxId", "recipient", "channel");

-- AddForeignKey
ALTER TABLE "CustomerApprovalOutbox" ADD CONSTRAINT "CustomerApprovalOutbox_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerApprovalOutbox" ADD CONSTRAINT "CustomerApprovalOutbox_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerApprovalDelivery" ADD CONSTRAINT "CustomerApprovalDelivery_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "CustomerApprovalOutbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

