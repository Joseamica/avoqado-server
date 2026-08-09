-- BOTH preserves existing module behavior; Task 3 explicitly registers the
-- organization-only master-catalog module after this inert schema expansion.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Module" ADD COLUMN "scope" "ModuleScope" NOT NULL DEFAULT 'BOTH';
COMMIT;
