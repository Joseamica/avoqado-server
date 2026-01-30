-- CreateEnum
CREATE TYPE "public"."TimeEntryValidation" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "public"."Venue" ADD COLUMN     "zoneId" TEXT;

-- AlterTable
ALTER TABLE "public"."time_entries" ADD COLUMN     "validatedAt" TIMESTAMP(3),
ADD COLUMN     "validatedBy" TEXT,
ADD COLUMN     "validationNote" TEXT,
ADD COLUMN     "validationStatus" "public"."TimeEntryValidation" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "public"."Zone" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Zone_organizationId_idx" ON "public"."Zone"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Zone_organizationId_slug_key" ON "public"."Zone"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "time_entries_validationStatus_idx" ON "public"."time_entries"("validationStatus");

-- AddForeignKey
ALTER TABLE "public"."Zone" ADD CONSTRAINT "Zone_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Venue" ADD CONSTRAINT "Venue_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "public"."Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
