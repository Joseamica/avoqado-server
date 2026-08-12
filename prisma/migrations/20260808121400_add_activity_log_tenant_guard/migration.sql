-- Classified H1 rows cannot claim a Venue from another organization. Actor
-- classification remains optional for legacy writers, but any org attribution
-- they do write becomes durable audit provenance.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION "enforce_activity_log_tenant_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- organizationId is independently write-once once populated, including on
  -- actorType=NULL rows; otherwise a writer could null it before deleting org.
  IF TG_OP = 'UPDATE'
     AND OLD."organizationId" IS NOT NULL
     AND NEW."organizationId" IS DISTINCT FROM OLD."organizationId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'ActivityLog_organization_immutable_check',
      MESSAGE = 'populated ActivityLog organization attribution is immutable';
  END IF;

  -- Classified audit identity is immutable. This also prevents a writer from
  -- laundering durable H1 history back into the legacy-unclassified shape.
  IF TG_OP = 'UPDATE' AND OLD."actorType" IS NOT NULL AND (
    NEW."actorType" IS DISTINCT FROM OLD."actorType"
    OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."staffId" IS DISTINCT FROM OLD."staffId"
    OR NEW."actorStaffId" IS DISTINCT FROM OLD."actorStaffId"
    OR NEW."servicePrincipalId" IS DISTINCT FROM OLD."servicePrincipalId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'ActivityLog_classified_actor_immutable_check',
      MESSAGE = 'classified ActivityLog actor and organization are immutable';
  END IF;

  IF NEW."actorType" IS NOT NULL AND NEW."organizationId" IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'ActivityLog_classified_organization_check',
      MESSAGE = 'classified ActivityLog rows require organizationId';
  END IF;

  IF NEW."actorType" IS NOT NULL AND NEW."venueId" IS NOT NULL THEN
    -- KEY SHARE closes insert-log versus delete-venue: the audit write either
    -- observes a surviving tenant venue or rechecks after the delete commits.
    PERFORM 1
      FROM "Venue"
     WHERE "id" = NEW."venueId"
       AND "organizationId" = NEW."organizationId"
       FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'ActivityLog_venue_organization_check',
        MESSAGE = 'ActivityLog venueId must belong to organizationId';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ActivityLog_tenant_scope_trigger"
BEFORE INSERT OR UPDATE OF "actorType", "organizationId", "venueId", "staffId", "actorStaffId", "servicePrincipalId" ON "ActivityLog"
FOR EACH ROW EXECUTE FUNCTION "enforce_activity_log_tenant_scope"();

-- The legacy staffId FK performs SET NULL before PostgreSQL may report the
-- durable actorStaffId RESTRICT edge. A Staff guard makes the durable failure
-- deterministic while retaining both physical FKs and legacy delete behavior.
CREATE FUNCTION "guard_staff_durable_activity_actor_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ActivityLog" WHERE "actorStaffId" = OLD."id") THEN
    RAISE EXCEPTION 'Staff is retained by durable H1 ActivityLog provenance'
      USING ERRCODE = '23503', CONSTRAINT = 'ActivityLog_actorStaffId_fkey';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "Staff_durable_activity_actor_delete_trigger"
BEFORE DELETE ON "Staff"
FOR EACH ROW EXECUTE FUNCTION "guard_staff_durable_activity_actor_delete"();

COMMIT;
