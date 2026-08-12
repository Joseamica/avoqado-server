-- Readiness overrides stay default-off; hot tenant, Venue, and actor locks are short.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogClientReadinessOverride"
  ADD CONSTRAINT "CatalogClientReadinessOverride_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogClientReadinessOverride_venueId_organizationId_fkey" FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogClientReadinessOverride_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CatalogClientReadinessOverride_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
