-- Binding's CatalogItem edge stays in core; live tenant/Venue/Product/actor parents are phased here.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogVenueBinding"
  ADD CONSTRAINT "CatalogVenueBinding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogVenueBinding_venue_tenant_fkey" FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogVenueBinding_product_venue_fkey" FOREIGN KEY ("productId", "venueId") REFERENCES "Product"("id", "venueId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID,
  ADD CONSTRAINT "CatalogVenueBinding_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogVenueBinding_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
