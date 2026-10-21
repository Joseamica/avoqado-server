-- CreateEnum
CREATE TYPE "HybridCampaignPurpose" AS ENUM ('LIST', 'PROMOTION');

-- AlterTable
ALTER TABLE "HybridCampaign" ADD COLUMN     "currentPublicationId" TEXT,
ADD COLUMN     "listProductKey" TEXT,
ADD COLUMN     "pendingPublicationId" TEXT,
ADD COLUMN     "promotionGroupId" TEXT,
ADD COLUMN     "purpose" "HybridCampaignPurpose" NOT NULL DEFAULT 'PROMOTION',
ALTER COLUMN "endsAt" DROP NOT NULL,
ALTER COLUMN "capacity" DROP NOT NULL;

-- CreateTable
CREATE TABLE "HybridPromotionGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "percentOff" INTEGER NOT NULL,
    "target" JSONB NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "promotionCycles" INTEGER,
    "capacityPerFeature" INTEGER NOT NULL,
    "status" "LaunchCampaignStatus" NOT NULL DEFAULT 'PAUSED',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HybridPromotionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HybridCampaign_purpose_status_idx" ON "HybridCampaign"("purpose", "status");

-- CreateIndex
CREATE INDEX "HybridCampaign_promotionGroupId_idx" ON "HybridCampaign"("promotionGroupId");

-- AddForeignKey
ALTER TABLE "HybridCampaign" ADD CONSTRAINT "HybridCampaign_promotionGroupId_fkey" FOREIGN KEY ("promotionGroupId") REFERENCES "HybridPromotionGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written: invariants Prisma cannot express (CHECKs, partial unique index) and the pointer backfill.
ALTER TABLE "HybridCampaign" ADD CONSTRAINT "HybridCampaign_purpose_shape" CHECK (
  ("purpose" = 'PROMOTION' AND "endsAt" IS NOT NULL AND "capacity" IS NOT NULL AND "listProductKey" IS NULL)
  OR ("purpose" = 'LIST' AND "endsAt" IS NULL AND "capacity" IS NULL AND "listProductKey" IS NOT NULL AND "promotionGroupId" IS NULL)
);
CREATE UNIQUE INDEX "HybridCampaign_one_list_per_product" ON "HybridCampaign" ("listProductKey") WHERE "purpose" = 'LIST';
ALTER TABLE "HybridPromotionGroup" ADD CONSTRAINT "HybridPromotionGroup_percent" CHECK ("percentOff" BETWEEN 1 AND 90 AND "capacityPerFeature" >= 1 AND "endsAt" > "startsAt");
-- Backfill: the current publication is today's "highest version" (same behavior as before).
UPDATE "HybridCampaign" c SET "currentPublicationId" = p.id
FROM (SELECT DISTINCT ON ("campaignId") "campaignId", id FROM "HybridOfferPublication" ORDER BY "campaignId", version DESC) p
WHERE p."campaignId" = c.id;
