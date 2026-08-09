-- Requirement rows are new; hot parent locks are isolated from the core migration.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogVenueClientRequirement"
  ADD CONSTRAINT "CatalogVenueClientRequirement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogVenueClientRequirement_venueId_organizationId_fkey" FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogVenueClientRequirement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogVenueClientRequirement_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
