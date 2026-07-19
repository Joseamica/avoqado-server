-- CreateEnum
CREATE TYPE "DeliveryProvider" AS ENUM ('DELIVERECT', 'UBER_EATS', 'RAPPI', 'DIDI_FOOD');

-- CreateEnum
CREATE TYPE "OrderAcceptanceMode" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "DeliveryChannelStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'DISABLED');

-- CreateEnum
CREATE TYPE "DeliveryOrderEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'DUPLICATE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderSource" ADD VALUE 'UBER_EATS';
ALTER TYPE "OrderSource" ADD VALUE 'RAPPI';
ALTER TYPE "OrderSource" ADD VALUE 'DIDI_FOOD';
ALTER TYPE "OrderSource" ADD VALUE 'DELIVERY_PLATFORM';

-- AlterEnum
ALTER TYPE "OriginSystem" ADD VALUE 'DELIVERY_PLATFORM';

-- AlterEnum
ALTER TYPE "PaymentSource" ADD VALUE 'DELIVERY_PLATFORM';

-- CreateTable
CREATE TABLE "DeliveryChannelLink" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "provider" "DeliveryProvider" NOT NULL,
    "externalLocationId" TEXT NOT NULL,
    "externalAccountId" TEXT,
    "webhookSecret" TEXT NOT NULL,
    "orderAcceptanceMode" "OrderAcceptanceMode" NOT NULL DEFAULT 'AUTO',
    "status" "DeliveryChannelStatus" NOT NULL DEFAULT 'PENDING',
    "autoSyncMenu" BOOLEAN NOT NULL DEFAULT true,
    "lastMenuSyncAt" TIMESTAMP(3),
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryChannelLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryOrderEvent" (
    "id" TEXT NOT NULL,
    "provider" "DeliveryProvider" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "channelLinkId" TEXT,
    "venueId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "DeliveryOrderEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "orderId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "DeliveryOrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryChannelLink_venueId_idx" ON "DeliveryChannelLink"("venueId");

-- CreateIndex
CREATE INDEX "DeliveryChannelLink_status_idx" ON "DeliveryChannelLink"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryChannelLink_provider_externalLocationId_key" ON "DeliveryChannelLink"("provider", "externalLocationId");

-- CreateIndex
CREATE INDEX "DeliveryOrderEvent_status_receivedAt_idx" ON "DeliveryOrderEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "DeliveryOrderEvent_venueId_idx" ON "DeliveryOrderEvent"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryOrderEvent_provider_externalEventId_eventType_key" ON "DeliveryOrderEvent"("provider", "externalEventId", "eventType");

-- AddForeignKey
ALTER TABLE "DeliveryChannelLink" ADD CONSTRAINT "DeliveryChannelLink_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryOrderEvent" ADD CONSTRAINT "DeliveryOrderEvent_channelLinkId_fkey" FOREIGN KEY ("channelLinkId") REFERENCES "DeliveryChannelLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;
