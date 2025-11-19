/*
  Warnings:

  - You are about to drop the column `externalMerchantId` on the `CheckoutSession` table. All the data in the column will be lost.
  - You are about to drop the `ExternalMerchant` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `ecommerceMerchantId` to the `CheckoutSession` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "public"."CheckoutSession" DROP CONSTRAINT "CheckoutSession_externalMerchantId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ExternalMerchant" DROP CONSTRAINT "ExternalMerchant_costStructureId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ExternalMerchant" DROP CONSTRAINT "ExternalMerchant_dashboardUserId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ExternalMerchant" DROP CONSTRAINT "ExternalMerchant_pricingStructureId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ExternalMerchant" DROP CONSTRAINT "ExternalMerchant_providerId_fkey";

-- DropIndex
DROP INDEX "public"."CheckoutSession_externalMerchantId_idx";

-- AlterTable
ALTER TABLE "public"."CheckoutSession" DROP COLUMN "externalMerchantId",
ADD COLUMN     "ecommerceMerchantId" TEXT NOT NULL;

-- DropTable
DROP TABLE "public"."ExternalMerchant";

-- CreateTable
CREATE TABLE "public"."EcommerceMerchant" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "channelName" TEXT NOT NULL DEFAULT 'Web Principal',
    "businessName" TEXT NOT NULL,
    "rfc" TEXT,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "website" TEXT,
    "publicKey" TEXT NOT NULL,
    "secretKeyEncrypted" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerCredentials" JSONB NOT NULL,
    "costStructureId" TEXT,
    "pricingStructureId" TEXT,
    "webhookUrl" TEXT,
    "webhookSecretEncrypted" TEXT,
    "webhookEvents" TEXT[] DEFAULT ARRAY['payment.completed', 'payment.failed']::TEXT[],
    "dashboardUserId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sandboxMode" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcommerceMerchant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EcommerceMerchant_contactEmail_key" ON "public"."EcommerceMerchant"("contactEmail");

-- CreateIndex
CREATE UNIQUE INDEX "EcommerceMerchant_publicKey_key" ON "public"."EcommerceMerchant"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "EcommerceMerchant_secretKeyEncrypted_key" ON "public"."EcommerceMerchant"("secretKeyEncrypted");

-- CreateIndex
CREATE UNIQUE INDEX "EcommerceMerchant_dashboardUserId_key" ON "public"."EcommerceMerchant"("dashboardUserId");

-- CreateIndex
CREATE INDEX "EcommerceMerchant_venueId_idx" ON "public"."EcommerceMerchant"("venueId");

-- CreateIndex
CREATE INDEX "EcommerceMerchant_publicKey_idx" ON "public"."EcommerceMerchant"("publicKey");

-- CreateIndex
CREATE INDEX "EcommerceMerchant_contactEmail_idx" ON "public"."EcommerceMerchant"("contactEmail");

-- CreateIndex
CREATE INDEX "EcommerceMerchant_active_idx" ON "public"."EcommerceMerchant"("active");

-- CreateIndex
CREATE INDEX "EcommerceMerchant_sandboxMode_idx" ON "public"."EcommerceMerchant"("sandboxMode");

-- CreateIndex
CREATE INDEX "EcommerceMerchant_providerId_idx" ON "public"."EcommerceMerchant"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "EcommerceMerchant_venueId_channelName_key" ON "public"."EcommerceMerchant"("venueId", "channelName");

-- CreateIndex
CREATE INDEX "CheckoutSession_ecommerceMerchantId_idx" ON "public"."CheckoutSession"("ecommerceMerchantId");

-- AddForeignKey
ALTER TABLE "public"."EcommerceMerchant" ADD CONSTRAINT "EcommerceMerchant_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EcommerceMerchant" ADD CONSTRAINT "EcommerceMerchant_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "public"."PaymentProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EcommerceMerchant" ADD CONSTRAINT "EcommerceMerchant_costStructureId_fkey" FOREIGN KEY ("costStructureId") REFERENCES "public"."ProviderCostStructure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EcommerceMerchant" ADD CONSTRAINT "EcommerceMerchant_pricingStructureId_fkey" FOREIGN KEY ("pricingStructureId") REFERENCES "public"."VenuePricingStructure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EcommerceMerchant" ADD CONSTRAINT "EcommerceMerchant_dashboardUserId_fkey" FOREIGN KEY ("dashboardUserId") REFERENCES "public"."Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CheckoutSession" ADD CONSTRAINT "CheckoutSession_ecommerceMerchantId_fkey" FOREIGN KEY ("ecommerceMerchantId") REFERENCES "public"."EcommerceMerchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
