-- CreateEnum
CREATE TYPE "StampEventType" AS ENUM ('EARN', 'REVERSAL', 'ADJUST');

-- CreateEnum
CREATE TYPE "StampRewardType" AS ENUM ('FREE_PRODUCT', 'FIXED_AMOUNT', 'PERCENTAGE');

-- CreateEnum
CREATE TYPE "StampRewardStatus" AS ENUM ('PENDING', 'REDEEMED', 'EXPIRED');

-- AlterTable
ALTER TABLE "LoyaltyConfig" ADD COLUMN     "maxStampsPerDay" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "stampRewardLabel" TEXT NOT NULL DEFAULT 'Un producto gratis',
ADD COLUMN     "stampRewardProductId" TEXT,
ADD COLUMN     "stampRewardType" "StampRewardType" NOT NULL DEFAULT 'FREE_PRODUCT',
ADD COLUMN     "stampRewardValue" DECIMAL(10,2),
ADD COLUMN     "stampsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stampsRequired" INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "StampCard" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "stampsRequired" INTEGER NOT NULL,
    "stampsEarned" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StampCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StampEvent" (
    "id" TEXT NOT NULL,
    "stampCardId" TEXT NOT NULL,
    "type" "StampEventType" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "orderId" TEXT,
    "venueId" TEXT NOT NULL,
    "createdById" TEXT,
    "terminalId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StampEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StampReward" (
    "id" TEXT NOT NULL,
    "stampCardId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "status" "StampRewardStatus" NOT NULL DEFAULT 'PENDING',
    "rewardType" "StampRewardType" NOT NULL,
    "rewardValue" DECIMAL(10,2),
    "rewardProductId" TEXT,
    "rewardLabel" TEXT NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "orderDiscountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StampReward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StampCard_venueId_customerId_idx" ON "StampCard"("venueId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "StampCard_customerId_venueId_cycle_key" ON "StampCard"("customerId", "venueId", "cycle");

-- CreateIndex
CREATE INDEX "StampEvent_stampCardId_createdAt_idx" ON "StampEvent"("stampCardId", "createdAt");

-- CreateIndex
CREATE INDEX "StampEvent_venueId_createdAt_idx" ON "StampEvent"("venueId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StampReward_stampCardId_key" ON "StampReward"("stampCardId");

-- CreateIndex
CREATE UNIQUE INDEX "StampReward_orderDiscountId_key" ON "StampReward"("orderDiscountId");

-- CreateIndex
CREATE INDEX "StampReward_customerId_status_idx" ON "StampReward"("customerId", "status");

-- CreateIndex
CREATE INDEX "StampReward_venueId_status_idx" ON "StampReward"("venueId", "status");

-- AddForeignKey
ALTER TABLE "StampCard" ADD CONSTRAINT "StampCard_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StampCard" ADD CONSTRAINT "StampCard_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StampEvent" ADD CONSTRAINT "StampEvent_stampCardId_fkey" FOREIGN KEY ("stampCardId") REFERENCES "StampCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StampEvent" ADD CONSTRAINT "StampEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StampEvent" ADD CONSTRAINT "StampEvent_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StampEvent" ADD CONSTRAINT "StampEvent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "StaffVenue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StampReward" ADD CONSTRAINT "StampReward_stampCardId_fkey" FOREIGN KEY ("stampCardId") REFERENCES "StampCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StampReward" ADD CONSTRAINT "StampReward_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StampReward" ADD CONSTRAINT "StampReward_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
