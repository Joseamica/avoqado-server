-- Publication lineage/new-table edges stay in core; live tenant/Venue/Product locks are bounded here.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogPublicationLine"
  ADD CONSTRAINT "CatalogPublicationLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogPublicationLine_venueId_organizationId_fkey" FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogPublicationLine_productId_venueId_fkey" FOREIGN KEY ("productId", "venueId") REFERENCES "Product"("id", "venueId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID;
COMMIT;
