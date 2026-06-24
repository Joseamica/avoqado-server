
-- CreateEnum
CREATE TYPE "public"."PricingStructureSource" AS ENUM ('VENUE', 'ORG');

-- CreateEnum
CREATE TYPE "public"."MerchantResolutionStatus" AS ENUM ('RESOLVED', 'FALLBACK_PRIMARY', 'UNRESOLVED');

-- AlterTable
ALTER TABLE "public"."Payment" ADD COLUMN     "merchantResolutionReason" TEXT,
ADD COLUMN     "merchantResolutionStatus" "public"."MerchantResolutionStatus",
ADD COLUMN     "originalMerchantAccountId" TEXT;

-- AlterTable
ALTER TABLE "public"."OrganizationPricingStructure" ADD COLUMN     "merchantAccountId" TEXT;

-- AlterTable
ALTER TABLE "public"."VenuePricingStructure" ADD COLUMN     "merchantAccountId" TEXT;

-- AlterTable
ALTER TABLE "public"."TransactionCost" ADD COLUMN     "organizationPricingStructureId" TEXT,
ADD COLUMN     "pricingStructureSource" "public"."PricingStructureSource",
ADD COLUMN     "providerCostFallbackUsed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "venuePricingFallbackUsed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "public"."VenueMerchantAccount" (
    "id" TEXT NOT NULL,
    "venuePaymentConfigId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "merchantAccountId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "legacySlotType" "public"."AccountType",
    "inheritedFromOrg" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueMerchantAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrganizationMerchantAccount" (
    "id" TEXT NOT NULL,
    "organizationPaymentConfigId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "merchantAccountId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "legacySlotType" "public"."AccountType",
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMerchantAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TerminalMerchantAccount" (
    "id" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "merchantAccountId" TEXT NOT NULL,
    "perTerminalOrder" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminalMerchantAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VenueMerchantAccount_merchantAccountId_idx" ON "public"."VenueMerchantAccount"("merchantAccountId");

-- CreateIndex
CREATE INDEX "VenueMerchantAccount_venueId_idx" ON "public"."VenueMerchantAccount"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueMerchantAccount_venuePaymentConfigId_merchantAccountId_key" ON "public"."VenueMerchantAccount"("venuePaymentConfigId", "merchantAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueMerchantAccount_venueId_merchantAccountId_key" ON "public"."VenueMerchantAccount"("venueId", "merchantAccountId");

-- CreateIndex
CREATE INDEX "OrganizationMerchantAccount_merchantAccountId_idx" ON "public"."OrganizationMerchantAccount"("merchantAccountId");

-- CreateIndex
CREATE INDEX "OrganizationMerchantAccount_organizationId_idx" ON "public"."OrganizationMerchantAccount"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMerchantAccount_organizationPaymentConfigId_mer_key" ON "public"."OrganizationMerchantAccount"("organizationPaymentConfigId", "merchantAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMerchantAccount_organizationId_merchantAccountI_key" ON "public"."OrganizationMerchantAccount"("organizationId", "merchantAccountId");

-- CreateIndex
CREATE INDEX "TerminalMerchantAccount_merchantAccountId_idx" ON "public"."TerminalMerchantAccount"("merchantAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "TerminalMerchantAccount_terminalId_merchantAccountId_key" ON "public"."TerminalMerchantAccount"("terminalId", "merchantAccountId");

-- AddForeignKey
ALTER TABLE "public"."VenueMerchantAccount" ADD CONSTRAINT "VenueMerchantAccount_venuePaymentConfigId_fkey" FOREIGN KEY ("venuePaymentConfigId") REFERENCES "public"."VenuePaymentConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VenueMerchantAccount" ADD CONSTRAINT "VenueMerchantAccount_merchantAccountId_fkey" FOREIGN KEY ("merchantAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationMerchantAccount" ADD CONSTRAINT "OrganizationMerchantAccount_organizationPaymentConfigId_fkey" FOREIGN KEY ("organizationPaymentConfigId") REFERENCES "public"."OrganizationPaymentConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationMerchantAccount" ADD CONSTRAINT "OrganizationMerchantAccount_merchantAccountId_fkey" FOREIGN KEY ("merchantAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TerminalMerchantAccount" ADD CONSTRAINT "TerminalMerchantAccount_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "public"."Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TerminalMerchantAccount" ADD CONSTRAINT "TerminalMerchantAccount_venueId_merchantAccountId_fkey" FOREIGN KEY ("venueId", "merchantAccountId") REFERENCES "public"."VenueMerchantAccount"("venueId", "merchantAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- PR-1 raw constraints (no modelables en Prisma schema) — spec §3.3/§3.4
-- Solo aditivo; build-safe (no toca accountType ni agrega el CHECK exactly-one).
-- ============================================================

-- FKs de pricing por cuenta (merchantAccountId / organizationPricingStructureId son plain scalars en Prisma)
ALTER TABLE "public"."VenuePricingStructure" ADD CONSTRAINT "VenuePricingStructure_merchantAccountId_fkey" FOREIGN KEY ("merchantAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."OrganizationPricingStructure" ADD CONSTRAINT "OrganizationPricingStructure_merchantAccountId_fkey" FOREIGN KEY ("merchantAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."TransactionCost" ADD CONSTRAINT "TransactionCost_organizationPricingStructureId_fkey" FOREIGN KEY ("organizationPricingStructureId") REFERENCES "public"."OrganizationPricingStructure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Índices de las nuevas columnas de pricing
CREATE INDEX "VenuePricingStructure_merchantAccountId_idx" ON "public"."VenuePricingStructure"("merchantAccountId");
CREATE INDEX "OrganizationPricingStructure_merchantAccountId_idx" ON "public"."OrganizationPricingStructure"("merchantAccountId");

-- Partial uniques de pricing por cuenta (scoped por venue/org — R7)
CREATE UNIQUE INDEX "VenuePricingStructure_venue_merchant_effective_key" ON "public"."VenuePricingStructure"("venueId", "merchantAccountId", "effectiveFrom") WHERE "merchantAccountId" IS NOT NULL;
CREATE UNIQUE INDEX "OrganizationPricingStructure_org_merchant_effective_key" ON "public"."OrganizationPricingStructure"("organizationId", "merchantAccountId", "effectiveFrom") WHERE "merchantAccountId" IS NOT NULL;

-- Un default por terminal
CREATE UNIQUE INDEX "TerminalMerchantAccount_one_default_per_terminal_key" ON "public"."TerminalMerchantAccount"("terminalId") WHERE "isDefault";

-- CHECK de consistencia de la fuente de pricing (§3.4). Permite source NULL (legacy/TEST).
ALTER TABLE "public"."TransactionCost" ADD CONSTRAINT "TransactionCost_pricing_source_chk" CHECK (
  "pricingStructureSource" IS NULL
  OR ("pricingStructureSource" = 'VENUE' AND "venuePricingStructureId" IS NOT NULL AND "organizationPricingStructureId" IS NULL)
  OR ("pricingStructureSource" = 'ORG'   AND "organizationPricingStructureId" IS NOT NULL AND "venuePricingStructureId" IS NULL)
);

-- DIFERIDO A PR-2 (requiere accountType nullable + reescribir consumidores; rompería el build en PR-1):
--   * accountType -> nullable en VenuePricingStructure / OrganizationPricingStructure
--   * CHECK exactly-one(accountType, merchantAccountId) en ambas
