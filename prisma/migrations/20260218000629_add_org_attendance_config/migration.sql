-- AlterTable
ALTER TABLE "public"."VenueSettings" ALTER COLUMN "expectedCheckInTime" DROP NOT NULL,
ALTER COLUMN "expectedCheckInTime" DROP DEFAULT,
ALTER COLUMN "latenessThresholdMinutes" DROP NOT NULL,
ALTER COLUMN "latenessThresholdMinutes" DROP DEFAULT,
ALTER COLUMN "geofenceRadiusMeters" DROP NOT NULL,
ALTER COLUMN "geofenceRadiusMeters" DROP DEFAULT;

-- CreateTable
CREATE TABLE "public"."OrganizationAttendanceConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "expectedCheckInTime" TEXT NOT NULL DEFAULT '09:00',
    "latenessThresholdMinutes" INTEGER NOT NULL DEFAULT 30,
    "geofenceRadiusMeters" INTEGER NOT NULL DEFAULT 500,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationAttendanceConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationAttendanceConfig_organizationId_key" ON "public"."OrganizationAttendanceConfig"("organizationId");

-- AddForeignKey
ALTER TABLE "public"."OrganizationAttendanceConfig" ADD CONSTRAINT "OrganizationAttendanceConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data migration: Set to NULL for venues that have the default values (never explicitly configured)
-- This allows them to inherit from the org config instead
UPDATE "public"."VenueSettings" SET
  "expectedCheckInTime" = NULL,
  "latenessThresholdMinutes" = NULL,
  "geofenceRadiusMeters" = NULL
WHERE "expectedCheckInTime" = '09:00'
  AND "latenessThresholdMinutes" = 30
  AND "geofenceRadiusMeters" = 500;
