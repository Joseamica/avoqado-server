-- AlterTable
ALTER TABLE "time_entries" ADD COLUMN     "checkOutPhotoUrl" TEXT,
ADD COLUMN     "clockInAccuracy" DOUBLE PRECISION,
ADD COLUMN     "clockInLatitude" DOUBLE PRECISION,
ADD COLUMN     "clockInLongitude" DOUBLE PRECISION,
ADD COLUMN     "clockOutAccuracy" DOUBLE PRECISION,
ADD COLUMN     "clockOutLatitude" DOUBLE PRECISION,
ADD COLUMN     "clockOutLongitude" DOUBLE PRECISION;
