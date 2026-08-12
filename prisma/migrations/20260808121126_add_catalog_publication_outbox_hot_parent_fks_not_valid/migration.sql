-- Outbox's batch edge stays in core; hot tenant/Venue parents are phased independently.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogPublicationOutbox"
  ADD CONSTRAINT "CatalogPublicationOutbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogPublicationOutbox_venueId_organizationId_fkey" FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
COMMIT;
