-- AlterTable
ALTER TABLE "DeliveryOrderEvent" ADD COLUMN     "claimToken" TEXT,
ADD COLUMN     "dedupKey" TEXT,
ADD COLUMN     "externalOrderId" TEXT,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);
-- CreateIndex
CREATE UNIQUE INDEX "DeliveryOrderEvent_dedupKey_key" ON "DeliveryOrderEvent"("dedupKey");
