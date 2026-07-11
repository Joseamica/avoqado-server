-- Configurable capture window for promoter geolocation (cambaceo).
-- Venue-local hours; start inclusive, end exclusive; 0/24 = 24h. Defaults match
-- the window previously hardcoded in the TPV (11:00-18:00).
ALTER TABLE "VenueSettings" ADD COLUMN "promoterLocationStartHour" INTEGER NOT NULL DEFAULT 11;
ALTER TABLE "VenueSettings" ADD COLUMN "promoterLocationEndHour" INTEGER NOT NULL DEFAULT 18;
ALTER TABLE "OrganizationAttendanceConfig" ADD COLUMN "promoterLocationStartHour" INTEGER NOT NULL DEFAULT 11;
ALTER TABLE "OrganizationAttendanceConfig" ADD COLUMN "promoterLocationEndHour" INTEGER NOT NULL DEFAULT 18;
