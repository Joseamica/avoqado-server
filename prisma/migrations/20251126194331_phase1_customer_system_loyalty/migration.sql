/*
  Warnings:

  - Added the required column `venueId` to the `Customer` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "public"."LoyaltyTransactionType" AS ENUM ('EARN', 'REDEEM', 'EXPIRE', 'ADJUST');

-- AlterTable
ALTER TABLE "public"."Customer" ADD COLUMN     "averageOrderValue" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "customerGroupId" TEXT,
ADD COLUMN     "firstVisitAt" TIMESTAMP(3),
ADD COLUMN     "lastVisitAt" TIMESTAMP(3),
ADD COLUMN     "loyaltyPoints" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "tags" TEXT[],
ADD COLUMN     "totalSpent" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalVisits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "venueId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "public"."Order" ADD COLUMN     "customerId" TEXT;

-- CreateTable
CREATE TABLE "public"."CustomerGroup" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "autoAssignRules" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LoyaltyConfig" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "pointsPerDollar" DECIMAL(5,2) NOT NULL DEFAULT 1,
    "pointsPerVisit" INTEGER NOT NULL DEFAULT 0,
    "redemptionRate" DECIMAL(5,4) NOT NULL DEFAULT 0.01,
    "minPointsRedeem" INTEGER NOT NULL DEFAULT 100,
    "pointsExpireDays" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LoyaltyTransaction" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "public"."LoyaltyTransactionType" NOT NULL,
    "points" INTEGER NOT NULL,
    "orderId" TEXT,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerGroup_venueId_idx" ON "public"."CustomerGroup"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerGroup_venueId_name_key" ON "public"."CustomerGroup"("venueId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyConfig_venueId_key" ON "public"."LoyaltyConfig"("venueId");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_customerId_createdAt_idx" ON "public"."LoyaltyTransaction"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_orderId_idx" ON "public"."LoyaltyTransaction"("orderId");

-- CreateIndex
CREATE INDEX "Customer_venueId_idx" ON "public"."Customer"("venueId");

-- CreateIndex
CREATE INDEX "Customer_customerGroupId_idx" ON "public"."Customer"("customerGroupId");

-- CreateIndex
CREATE INDEX "Customer_venueId_email_idx" ON "public"."Customer"("venueId", "email");

-- CreateIndex
CREATE INDEX "Customer_venueId_phone_idx" ON "public"."Customer"("venueId", "phone");

-- CreateIndex
CREATE INDEX "Order_customerId_idx" ON "public"."Order"("customerId");

-- AddForeignKey
ALTER TABLE "public"."Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Customer" ADD CONSTRAINT "Customer_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Customer" ADD CONSTRAINT "Customer_customerGroupId_fkey" FOREIGN KEY ("customerGroupId") REFERENCES "public"."CustomerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerGroup" ADD CONSTRAINT "CustomerGroup_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LoyaltyConfig" ADD CONSTRAINT "LoyaltyConfig_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."StaffVenue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
