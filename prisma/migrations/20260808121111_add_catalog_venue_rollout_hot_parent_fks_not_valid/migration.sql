-- Rollout remains empty/default-off while Organization, Venue, and Staff FKs are added briefly.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogVenueRollout"
  ADD CONSTRAINT "CatalogVenueRollout_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogVenueRollout_venueId_organizationId_fkey" FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogVenueRollout_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogVenueRollout_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
