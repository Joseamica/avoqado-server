-- Decision's line/override edges stay in core; its hot Organization edge is isolated.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CatalogPublicationFieldDecision"
  ADD CONSTRAINT "CatalogPublicationFieldDecision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
COMMIT;
