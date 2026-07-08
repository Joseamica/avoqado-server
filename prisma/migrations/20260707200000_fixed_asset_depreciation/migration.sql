-- Activo fijo + su depreciación por periodo (deducción de inversiones, LISR art. 34-35). Opt-in.
CREATE TYPE "FixedAssetStatus" AS ENUM ('ACTIVE', 'FULLY_DEPRECIATED', 'DISPOSED');

CREATE TABLE "FixedAsset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rfc" TEXT NOT NULL,
    "venueId" TEXT,
    "description" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "moiCents" INTEGER NOT NULL,
    "annualRate" DECIMAL(5,4) NOT NULL,
    "acquisitionDate" TIMESTAMP(3) NOT NULL,
    "inServiceDate" TIMESTAMP(3) NOT NULL,
    "salvageValueCents" INTEGER NOT NULL DEFAULT 0,
    "status" "FixedAssetStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceExpenseId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FixedAsset_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FixedAsset_organizationId_rfc_idx" ON "FixedAsset"("organizationId", "rfc");
CREATE INDEX "FixedAsset_sourceExpenseId_idx" ON "FixedAsset"("sourceExpenseId");

CREATE TABLE "FixedAssetDepreciation" (
    "id" TEXT NOT NULL,
    "fixedAssetId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "depreciationCents" INTEGER NOT NULL,
    "accumulatedCents" INTEGER NOT NULL,
    "posted" BOOLEAN NOT NULL DEFAULT false,
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FixedAssetDepreciation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FixedAssetDepreciation_fixedAssetId_period_key" ON "FixedAssetDepreciation"("fixedAssetId", "period");
CREATE INDEX "FixedAssetDepreciation_fixedAssetId_idx" ON "FixedAssetDepreciation"("fixedAssetId");

ALTER TABLE "FixedAssetDepreciation" ADD CONSTRAINT "FixedAssetDepreciation_fixedAssetId_fkey" FOREIGN KEY ("fixedAssetId") REFERENCES "FixedAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
