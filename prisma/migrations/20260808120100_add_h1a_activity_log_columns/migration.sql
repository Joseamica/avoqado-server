-- Nullable audit columns preserve every legacy writer while H1 writers opt in
-- to classified actors. The lock timeout makes a busy-table retry explicit.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "ActivityLog"
  ADD COLUMN "actorType" "ActivityActorType",
  ADD COLUMN "actorStaffId" TEXT,
  ADD COLUMN "organizationId" TEXT,
  ADD COLUMN "servicePrincipalId" TEXT;
COMMIT;
