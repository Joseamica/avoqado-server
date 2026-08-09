-- Observation is empty at expand time; tenant/Venue metadata locks stay bounded.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogClientObservation"
  ADD CONSTRAINT "CatalogClientObservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogClientObservation_venueId_organizationId_fkey" FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
COMMIT;
