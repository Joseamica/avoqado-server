/*
  Warnings:

  - A unique constraint covering the columns `[venueId,referralCode]` on the table `Customer` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "public"."ReferralStatus" AS ENUM ('PENDING', 'QUALIFIED', 'VOID');

-- CreateEnum
CREATE TYPE "public"."ReferralTier" AS ENUM ('TIER_1', 'TIER_2', 'TIER_3');

-- AlterTable
ALTER TABLE "public"."Customer" ADD COLUMN     "referralCode" TEXT,
ADD COLUMN     "referralCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "referralTier" "public"."ReferralTier",
ADD COLUMN     "referredByCustomerId" TEXT,
ADD COLUMN     "tierUnlockedAt" TIMESTAMP(3),
ADD COLUMN     "tierUpModalSeenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."Discount" ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "deactivatedReason" TEXT,
ADD COLUMN     "source" TEXT;

-- CreateTable
CREATE TABLE "public"."ReferralProgramConfig" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "activatedAt" TIMESTAMP(3),
    "newCustomerDiscountPercent" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "tier1ReferralsRequired" INTEGER NOT NULL DEFAULT 7,
    "tier1RewardPercent" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "tier2ReferralsRequired" INTEGER NOT NULL DEFAULT 12,
    "tier2RewardPercent" DECIMAL(5,2) NOT NULL DEFAULT 20,
    "tier3ReferralsRequired" INTEGER NOT NULL DEFAULT 20,
    "tier3RewardPercent" DECIMAL(5,2) NOT NULL DEFAULT 25,
    "rewardCouponExpiryDays" INTEGER NOT NULL DEFAULT 90,
    "welcomeMessageTemplate" TEXT,
    "tierUpMessageTemplate" TEXT,
    "codePrefix" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralProgramConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Referral" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "referrerCustomerId" TEXT NOT NULL,
    "referredCustomerId" TEXT NOT NULL,
    "status" "public"."ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "capturedByStaffVenueId" TEXT,
    "forcedOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "qualifyingOrderId" TEXT,
    "qualifiedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "rewardDiscountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralProgramConfig_venueId_key" ON "public"."ReferralProgramConfig"("venueId");

-- CreateIndex
CREATE INDEX "Referral_venueId_idx" ON "public"."Referral"("venueId");

-- CreateIndex
CREATE INDEX "Referral_referrerCustomerId_idx" ON "public"."Referral"("referrerCustomerId");

-- CreateIndex
CREATE INDEX "Referral_referredCustomerId_idx" ON "public"."Referral"("referredCustomerId");

-- CreateIndex
CREATE INDEX "Referral_status_idx" ON "public"."Referral"("status");

-- CreateIndex
CREATE INDEX "Customer_referredByCustomerId_idx" ON "public"."Customer"("referredByCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_venueId_referralCode_key" ON "public"."Customer"("venueId", "referralCode");

-- AddForeignKey
ALTER TABLE "public"."Customer" ADD CONSTRAINT "Customer_referredByCustomerId_fkey" FOREIGN KEY ("referredByCustomerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReferralProgramConfig" ADD CONSTRAINT "ReferralProgramConfig_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Referral" ADD CONSTRAINT "Referral_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Referral" ADD CONSTRAINT "Referral_referrerCustomerId_fkey" FOREIGN KEY ("referrerCustomerId") REFERENCES "public"."Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Referral" ADD CONSTRAINT "Referral_referredCustomerId_fkey" FOREIGN KEY ("referredCustomerId") REFERENCES "public"."Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Referral" ADD CONSTRAINT "Referral_capturedByStaffVenueId_fkey" FOREIGN KEY ("capturedByStaffVenueId") REFERENCES "public"."StaffVenue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Referral" ADD CONSTRAINT "Referral_qualifyingOrderId_fkey" FOREIGN KEY ("qualifyingOrderId") REFERENCES "public"."Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Referral" ADD CONSTRAINT "Referral_rewardDiscountId_fkey" FOREIGN KEY ("rewardDiscountId") REFERENCES "public"."Discount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
