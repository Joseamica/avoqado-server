/*
  Warnings:

  - You are about to drop the column `tpvDefaultTipPercentage` on the `VenueSettings` table. All the data in the column will be lost.
  - You are about to drop the column `tpvShowReceiptScreen` on the `VenueSettings` table. All the data in the column will be lost.
  - You are about to drop the column `tpvShowReviewScreen` on the `VenueSettings` table. All the data in the column will be lost.
  - You are about to drop the column `tpvShowTipScreen` on the `VenueSettings` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "public"."ModifierInventoryMode" AS ENUM ('ADDITION', 'SUBSTITUTION');

-- AlterTable
ALTER TABLE "public"."Modifier" ADD COLUMN     "cost" DECIMAL(10,4),
ADD COLUMN     "inventoryMode" "public"."ModifierInventoryMode" NOT NULL DEFAULT 'ADDITION',
ADD COLUMN     "quantityPerUnit" DECIMAL(12,3),
ADD COLUMN     "rawMaterialId" TEXT,
ADD COLUMN     "unit" "public"."Unit";

-- AlterTable
ALTER TABLE "public"."RecipeLine" ADD COLUMN     "isVariable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "linkedModifierGroupId" TEXT;

-- AlterTable
ALTER TABLE "public"."VenueSettings" DROP COLUMN "tpvDefaultTipPercentage",
DROP COLUMN "tpvShowReceiptScreen",
DROP COLUMN "tpvShowReviewScreen",
DROP COLUMN "tpvShowTipScreen";

-- CreateIndex
CREATE INDEX "Modifier_rawMaterialId_idx" ON "public"."Modifier"("rawMaterialId");

-- CreateIndex
CREATE INDEX "RecipeLine_linkedModifierGroupId_idx" ON "public"."RecipeLine"("linkedModifierGroupId");

-- AddForeignKey
ALTER TABLE "public"."RecipeLine" ADD CONSTRAINT "RecipeLine_linkedModifierGroupId_fkey" FOREIGN KEY ("linkedModifierGroupId") REFERENCES "public"."ModifierGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Modifier" ADD CONSTRAINT "Modifier_rawMaterialId_fkey" FOREIGN KEY ("rawMaterialId") REFERENCES "public"."RawMaterial"("id") ON DELETE SET NULL ON UPDATE CASCADE;
