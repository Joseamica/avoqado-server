-- DropIndex
DROP INDEX "DeliveryOrderEvent_provider_externalEventId_eventType_key";

-- AlterTable
ALTER TABLE "DeliveryOrderEvent" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryFeeAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "DeliveryOrderEvent_status_nextAttemptAt_idx" ON "DeliveryOrderEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryOrderEvent_provider_channelLinkId_externalEventId_e_key" ON "DeliveryOrderEvent"("provider", "channelLinkId", "externalEventId", "eventType");

