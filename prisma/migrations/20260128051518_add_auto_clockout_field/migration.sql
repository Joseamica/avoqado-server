-- AlterTable
ALTER TABLE "public"."VenueSettings" ADD COLUMN     "autoClockOutEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoClockOutTime" TEXT,
ADD COLUMN     "maxShiftDurationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxShiftDurationHours" INTEGER NOT NULL DEFAULT 12;

-- AlterTable
ALTER TABLE "public"."time_entries" ADD COLUMN     "autoClockOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoClockOutNote" TEXT;
