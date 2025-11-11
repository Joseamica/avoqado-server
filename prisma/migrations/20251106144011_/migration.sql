/*
  Warnings:

  - A unique constraint covering the columns `[venueId,externalId]` on the table `Review` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "public"."MerchantAccount_blumonSerialNumber_idx";

-- DropIndex
DROP INDEX "public"."Terminal_assignedMerchantIds_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Review_venueId_externalId_key" ON "public"."Review"("venueId", "externalId");
