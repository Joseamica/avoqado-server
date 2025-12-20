-- AlterTable
ALTER TABLE "VenueSettings" ADD COLUMN     "requireClockInPhoto" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "time_entries" ADD COLUMN     "checkInPhotoUrl" TEXT;
