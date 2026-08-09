-- The governance fence records the first successful enforcement event. Exact
-- replay is idempotent; clearing or replacing that evidence is forbidden.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE FUNCTION "enforce_catalog_governance_timestamp_write_once"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."catalogGovernanceEnforcedAt" IS NOT NULL
     AND NEW."catalogGovernanceEnforcedAt" IS DISTINCT FROM OLD."catalogGovernanceEnforcedAt" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'Venue_catalogGovernanceEnforcedAt_write_once_check',
      MESSAGE = 'catalogGovernanceEnforcedAt is write-once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Venue_catalogGovernanceEnforcedAt_write_once_trigger"
BEFORE UPDATE OF "catalogGovernanceEnforcedAt" ON "Venue"
FOR EACH ROW EXECUTE FUNCTION "enforce_catalog_governance_timestamp_write_once"();
COMMIT;
