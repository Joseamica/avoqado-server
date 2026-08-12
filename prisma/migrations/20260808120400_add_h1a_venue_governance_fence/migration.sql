-- Legacy venues stay NULL/default-off. A separate trigger later makes the
-- first non-null fence immutable without lengthening this table alteration.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Venue" ADD COLUMN "catalogGovernanceEnforcedAt" TIMESTAMP(3);
COMMIT;
