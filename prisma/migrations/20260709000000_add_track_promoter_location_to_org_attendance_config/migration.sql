-- Org-level default for promoter geolocation (cambaceo). Saving it cascades to
-- each venue's VenueSettings.trackPromoterLocation (see upsertOrgAttendanceConfig).
ALTER TABLE "OrganizationAttendanceConfig" ADD COLUMN "trackPromoterLocation" BOOLEAN NOT NULL DEFAULT false;
