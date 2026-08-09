-- Override's audit/new-table FKs stay in core; only live tenant/Venue/actor edges are phased.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogVenueOverride"
  ADD CONSTRAINT "CatalogVenueOverride_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogVenueOverride_venueId_organizationId_fkey" FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogVenueOverride_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogVenueOverride_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
