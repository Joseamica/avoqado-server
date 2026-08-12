-- Hot parent FKs are phased per empty H1A child so Organization/Staff writers
-- encounter only one bounded metadata-lock window.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "OrganizationEntitlement"
  ADD CONSTRAINT "OrganizationEntitlement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "OrganizationEntitlement_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
COMMIT;
