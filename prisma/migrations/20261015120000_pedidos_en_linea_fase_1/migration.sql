-- CreateEnum
CREATE TYPE "OnlineOrderStatus" AS ENUM ('PENDING_ACCEPTANCE', 'ACCEPTED', 'READY', 'COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_STAFF');

-- CreateEnum
CREATE TYPE "OnlineOrderPaymentMode" AS ENUM ('PAY_AT_PICKUP');

-- CreateEnum
CREATE TYPE "OnlineOrderRejectReason" AS ENUM ('OUT_OF_ITEMS', 'CLOSED', 'TOO_BUSY', 'OTHER');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "availableOnline" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OnlineOrderingSettings" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "minOrderAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "defaultPrepMinutes" INTEGER NOT NULL DEFAULT 15,
    "acceptsPayAtPickup" BOOLEAN NOT NULL DEFAULT true,
    "manualPause" BOOLEAN NOT NULL DEFAULT false,
    "pausedUntil" TIMESTAMP(3),
    "hours" JSONB,
    "lastInboxPollAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnlineOrderingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnlineOrder" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "status" "OnlineOrderStatus" NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
    "paymentMode" "OnlineOrderPaymentMode" NOT NULL,
    "trackingToken" TEXT NOT NULL,
    "acceptDeadlineAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "estimatedReadyAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" "OnlineOrderRejectReason",
    "rejectNote" TEXT,
    "expiredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "whatsappConsent" BOOLEAN NOT NULL DEFAULT false,
    "printClaimedAt" TIMESTAMP(3),
    "printClaimedBy" TEXT,
    "printedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnlineOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrderingSettings_venueId_key" ON "OnlineOrderingSettings"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrder_orderId_key" ON "OnlineOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrder_trackingToken_key" ON "OnlineOrder"("trackingToken");

-- CreateIndex
CREATE INDEX "OnlineOrder_venueId_status_acceptDeadlineAt_idx" ON "OnlineOrder"("venueId", "status", "acceptDeadlineAt");

-- CreateIndex
CREATE INDEX "OnlineOrder_venueId_createdAt_idx" ON "OnlineOrder"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "OnlineOrder_status_acceptDeadlineAt_idx" ON "OnlineOrder"("status", "acceptDeadlineAt");

-- AddForeignKey
ALTER TABLE "OnlineOrderingSettings" ADD CONSTRAINT "OnlineOrderingSettings_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlineOrder" ADD CONSTRAINT "OnlineOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlineOrder" ADD CONSTRAINT "OnlineOrder_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

