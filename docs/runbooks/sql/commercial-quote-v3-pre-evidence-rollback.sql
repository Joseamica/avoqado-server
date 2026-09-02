-- Run only after the two zero-row preconditions in the parent runbook pass and
-- explicit rollback authorization exists. This script is destructive by design,
-- is forbidden after the first schema-3 Quote/control event, and uses only explicit drops.
BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, public;

-- Freeze both evidence sources before inspecting either one. Without these
-- locks a concurrent INSERT could commit after the guard's READ COMMITTED
-- snapshot and before the destructive DDL acquires its own table lock.
LOCK TABLE "CommercialQuote" IN ACCESS EXCLUSIVE MODE;
DO $lock_control_ledger$
BEGIN
  IF to_regclass('public."CommercialOfferControlEvent"') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE public."CommercialOfferControlEvent" IN ACCESS EXCLUSIVE MODE';
  END IF;
END
$lock_control_ledger$;

DO $evidence_guard$
DECLARE
  control_event_exists BOOLEAN := false;
BEGIN
  IF EXISTS (SELECT 1 FROM "CommercialQuote" WHERE "schemaVersion" = 3 LIMIT 1) THEN
    RAISE EXCEPTION 'Commercial Quote v3 evidence exists; recovery is forward-only'
      USING ERRCODE = '55000';
  END IF;

  IF to_regclass('public."CommercialOfferControlEvent"') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public."CommercialOfferControlEvent" LIMIT 1)'
      INTO control_event_exists;
  END IF;

  IF control_event_exists THEN
    RAISE EXCEPTION 'Commercial Offer control evidence exists; recovery is forward-only'
      USING ERRCODE = '55000';
  END IF;
END
$evidence_guard$;

DROP TRIGGER IF EXISTS commercial_quote_v3_sources ON "CommercialQuote";
ALTER TABLE "CommercialQuote" ENABLE TRIGGER commercial_quote_immutable;
DROP FUNCTION IF EXISTS public.enforce_commercial_quote_v3_sources();
DROP TRIGGER IF EXISTS commercial_offer_control_event_immutable ON "CommercialOfferControlEvent";
DROP TABLE IF EXISTS "CommercialOfferControlEvent";
DROP TYPE IF EXISTS "CommercialOfferControlAction";

ALTER TABLE "CommercialQuote"
  DROP CONSTRAINT IF EXISTS "CommercialQuote_offerVersionId_offerSchemaVersion_fkey",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_offer_pair_check",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_offer_pair_check_v3_pending",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_authority_shape_check",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_authority_shape_v3_pending",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_v3_totals_check",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_v3_totals_pending",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_snapshot_size_v3_check",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_snapshot_size_v3_pending",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_schema_version_check",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_schema_version_v3_pending",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_snapshot_schema_version_check",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_snapshot_schema_version_v3_pending",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_totals_check",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_legacy_totals_v3_pending",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_snapshot_totals_check",
  DROP CONSTRAINT IF EXISTS "CommercialQuote_snapshot_totals_v3_pending";

ALTER TABLE "CommercialQuote"
  ADD CONSTRAINT "CommercialQuote_schema_version_check" CHECK ("schemaVersion" IN (1, 2)),
  ADD CONSTRAINT "CommercialQuote_snapshot_schema_version_check" CHECK ((CASE
    WHEN jsonb_typeof("snapshot"->'schemaVersion') = 'number'
      AND ("snapshot"->>'schemaVersion')::NUMERIC = trunc(("snapshot"->>'schemaVersion')::NUMERIC)
      AND ("snapshot"->>'schemaVersion')::NUMERIC BETWEEN 1 AND 2
    THEN ("snapshot"->>'schemaVersion')::NUMERIC = "schemaVersion"
    ELSE false
  END) IS TRUE),
  ADD CONSTRAINT "CommercialQuote_totals_check" CHECK (
    "listSubtotalMinor" >= 0
    AND "discountMinor" >= 0
    AND "subtotalMinor" >= 0
    AND "taxMinor" >= 0
    AND "totalMinor" >= 0
    AND "renewalSubtotalMinor" >= 0
    AND "renewalTaxMinor" >= 0
    AND "renewalTotalMinor" >= 0
    AND "discountMinor" = "listSubtotalMinor" - "subtotalMinor"
    AND "totalMinor" = "subtotalMinor" + "taxMinor"
    AND "renewalTotalMinor" = "renewalSubtotalMinor" + "renewalTaxMinor"
    AND "renewalSubtotalMinor" >= "subtotalMinor"
    AND "renewalTotalMinor" >= "totalMinor"
  ),
  ADD CONSTRAINT "CommercialQuote_snapshot_totals_check" CHECK ((CASE
    WHEN "schemaVersion" = 1
      AND jsonb_typeof("snapshot"->'schemaVersion') = 'number'
      AND ("snapshot"->>'schemaVersion')::NUMERIC = 1 THEN
      commercial_quote_snapshot_is_consistent("snapshot")
      AND public.commercial_quote_snapshot_matches_v1_row(
        "snapshot", "id", "market", "currency", "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
        "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor"
      )
    WHEN "schemaVersion" = 2
      AND jsonb_typeof("snapshot"->'schemaVersion') = 'number'
      AND ("snapshot"->>'schemaVersion')::NUMERIC = 2 THEN
      public.commercial_quote_snapshot_matches_v2_row(
        "snapshot", "id", "catalogPublicationId", "campaignVersionId", "acquisitionContextId", "organizationId", "venueId", "createdById",
        "market", "currency", "quotedAt", "expiresAt", "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
        "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor"
      )
    ELSE false
  END) IS TRUE);

DROP INDEX IF EXISTS "CommercialQuote_offerVersionId_idx";
ALTER TABLE "CommercialQuote"
  DROP COLUMN IF EXISTS "offerVersionId",
  DROP COLUMN IF EXISTS "offerSchemaVersion";
DROP FUNCTION IF EXISTS public.commercial_quote_snapshot_matches_v3_row(
  JSONB, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TIMESTAMP(3), TIMESTAMP(3), BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT
);
DROP INDEX IF EXISTS "CommercialCampaignVersion_id_schemaVersion_key";

-- Prisma has no down-migration primitive for a successfully applied migration.
-- Preserve both ledger rows as evidence but mark them rolled back atomically with
-- the schema so a future `prisma migrate deploy` can reapply the exact files.
DO $migration_ledger$
BEGIN
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE "_prisma_migrations"
      SET rolled_back_at = COALESCE(rolled_back_at, CURRENT_TIMESTAMP)
      WHERE migration_name IN (
        '20260829100000_add_commercial_quote_v3_shape',
        '20260829110000_validate_commercial_quote_v3'
      )
        AND rolled_back_at IS NULL
    $sql$;
  END IF;
END
$migration_ledger$;
COMMIT;
