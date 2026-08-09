-- Event-sequence rows are absent at expand time; hot tenant/Venue locks remain short.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogVenueEventSequence"
  ADD CONSTRAINT "CatalogVenueEventSequence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogVenueEventSequence_venueId_organizationId_fkey" FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
COMMIT;
