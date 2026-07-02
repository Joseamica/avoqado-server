-- PREFLIGHT: void de referrals duplicados por orden (conservar el más antiguo).
-- Desempate por (createdAt, id): con timestamps IGUALES, el par (createdAt,id) sigue
-- siendo un orden total → sobrevive exactamente uno (Codex r5: sin el tie-breaker,
-- empates de createdAt dejaban varios activos y el índice único abortaba igual).
UPDATE "Referral" r SET "status" = 'VOID', "voidedAt" = now(),
  "voidReason" = 'dedupe_for_partial_unique_migration'
WHERE r."qualifyingOrderId" IS NOT NULL
  AND r."status" IN ('PENDING','QUALIFIED')
  AND EXISTS (
    SELECT 1 FROM "Referral" r2
    WHERE r2."qualifyingOrderId" = r."qualifyingOrderId"
      AND r2."status" IN ('PENDING','QUALIFIED')
      AND (r2."createdAt", r2."id") < (r."createdAt", r."id")
  );

CREATE UNIQUE INDEX "Referral_qualifyingOrderId_active_key"
  ON "Referral" ("qualifyingOrderId")
  WHERE "status" IN ('PENDING','QUALIFIED') AND "qualifyingOrderId" IS NOT NULL;

-- CreateEnum
CREATE TYPE "public"."ReferralRewardType" AS ENUM ('PERCENT_COUPON', 'PERMANENT_DISCOUNT', 'FREE_PRODUCT');

-- CreateEnum
CREATE TYPE "public"."ReferralRewardRecurrence" AS ENUM ('ONE_TIME', 'MONTHLY');

-- CreateEnum
CREATE TYPE "public"."ReferralGrantStatus" AS ENUM ('ISSUED', 'REDEEMED', 'REVOKED', 'MANUAL_PENDING', 'MANUAL_FULFILLED');

-- CreateTable
CREATE TABLE "public"."ReferralTierReward" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "tierLevel" INTEGER NOT NULL,
    "rewardType" "public"."ReferralRewardType" NOT NULL,
    "recurrence" "public"."ReferralRewardRecurrence" NOT NULL DEFAULT 'ONE_TIME',
    "rewardPercent" DECIMAL(5,2),
    "rewardProductId" TEXT,
    "rewardQuantity" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralTierReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReferralRewardGrant" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tierLevel" INTEGER NOT NULL,
    "referralId" TEXT,
    "tierRewardId" TEXT NOT NULL,
    "rewardType" "public"."ReferralRewardType" NOT NULL,
    "rewardPercent" DECIMAL(5,2),
    "rewardProductId" TEXT,
    "rewardQuantity" INTEGER NOT NULL DEFAULT 1,
    "discountId" TEXT,
    "couponCodeId" TEXT,
    "status" "public"."ReferralGrantStatus" NOT NULL DEFAULT 'ISSUED',
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "fulfilledByStaffVenueId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralRewardGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReferralTierUnlock" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tierLevel" INTEGER NOT NULL,
    "unlockedByReferralId" TEXT,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralTierUnlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferralTierReward_configId_tierLevel_idx" ON "public"."ReferralTierReward"("configId", "tierLevel");

-- CreateIndex
CREATE INDEX "ReferralRewardGrant_venueId_idx" ON "public"."ReferralRewardGrant"("venueId");

-- CreateIndex
CREATE INDEX "ReferralRewardGrant_customerId_idx" ON "public"."ReferralRewardGrant"("customerId");

-- CreateIndex
CREATE INDEX "ReferralRewardGrant_referralId_idx" ON "public"."ReferralRewardGrant"("referralId");

-- CreateIndex
CREATE INDEX "ReferralRewardGrant_status_idx" ON "public"."ReferralRewardGrant"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralRewardGrant_customerId_tierLevel_tierRewardId_key" ON "public"."ReferralRewardGrant"("customerId", "tierLevel", "tierRewardId");

-- CreateIndex
CREATE INDEX "ReferralTierUnlock_customerId_idx" ON "public"."ReferralTierUnlock"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralTierUnlock_customerId_tierLevel_key" ON "public"."ReferralTierUnlock"("customerId", "tierLevel");

-- AddForeignKey
ALTER TABLE "public"."ReferralTierReward" ADD CONSTRAINT "ReferralTierReward_configId_fkey" FOREIGN KEY ("configId") REFERENCES "public"."ReferralProgramConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReferralTierReward" ADD CONSTRAINT "ReferralTierReward_rewardProductId_fkey" FOREIGN KEY ("rewardProductId") REFERENCES "public"."Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReferralRewardGrant" ADD CONSTRAINT "ReferralRewardGrant_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReferralRewardGrant" ADD CONSTRAINT "ReferralRewardGrant_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReferralRewardGrant" ADD CONSTRAINT "ReferralRewardGrant_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "public"."Referral"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReferralRewardGrant" ADD CONSTRAINT "ReferralRewardGrant_tierRewardId_fkey" FOREIGN KEY ("tierRewardId") REFERENCES "public"."ReferralTierReward"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReferralRewardGrant" ADD CONSTRAINT "ReferralRewardGrant_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "public"."Discount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReferralTierUnlock" ADD CONSTRAINT "ReferralTierUnlock_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
