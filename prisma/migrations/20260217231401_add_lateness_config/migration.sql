-- AlterTable
ALTER TABLE "public"."VenueSettings" ADD COLUMN     "expectedCheckInTime" TEXT NOT NULL DEFAULT '09:00',
ADD COLUMN     "latenessThresholdMinutes" INTEGER NOT NULL DEFAULT 30;
