BEGIN;

-- Validation is intentionally committed separately from the NOT VALID expand
-- migration. The operator aborts and replans if either budget is exceeded.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "CommercialQuote"
  VALIDATE CONSTRAINT "CommercialQuote_offer_pair_check_v3_pending";
ALTER TABLE "CommercialQuote"
  VALIDATE CONSTRAINT "CommercialQuote_authority_shape_v3_pending";
ALTER TABLE "CommercialQuote"
  VALIDATE CONSTRAINT "CommercialQuote_schema_version_v3_pending";
ALTER TABLE "CommercialQuote"
  VALIDATE CONSTRAINT "CommercialQuote_snapshot_schema_version_v3_pending";
ALTER TABLE "CommercialQuote"
  VALIDATE CONSTRAINT "CommercialQuote_legacy_totals_v3_pending";
ALTER TABLE "CommercialQuote"
  VALIDATE CONSTRAINT "CommercialQuote_snapshot_totals_v3_pending";
ALTER TABLE "CommercialQuote"
  VALIDATE CONSTRAINT "CommercialQuote_v3_totals_pending";
ALTER TABLE "CommercialQuote"
  VALIDATE CONSTRAINT "CommercialQuote_snapshot_size_v3_pending";
ALTER TABLE "CommercialQuote"
  VALIDATE CONSTRAINT "CommercialQuote_offerVersionId_offerSchemaVersion_fkey";

-- Every replacement is already valid before the short constraint-name swap.
ALTER TABLE "CommercialQuote"
  DROP CONSTRAINT "CommercialQuote_schema_version_check";
ALTER TABLE "CommercialQuote"
  RENAME CONSTRAINT "CommercialQuote_schema_version_v3_pending" TO "CommercialQuote_schema_version_check";

ALTER TABLE "CommercialQuote"
  DROP CONSTRAINT "CommercialQuote_snapshot_schema_version_check";
ALTER TABLE "CommercialQuote"
  RENAME CONSTRAINT "CommercialQuote_snapshot_schema_version_v3_pending" TO "CommercialQuote_snapshot_schema_version_check";

ALTER TABLE "CommercialQuote"
  DROP CONSTRAINT "CommercialQuote_totals_check";
ALTER TABLE "CommercialQuote"
  RENAME CONSTRAINT "CommercialQuote_legacy_totals_v3_pending" TO "CommercialQuote_totals_check";

ALTER TABLE "CommercialQuote"
  DROP CONSTRAINT "CommercialQuote_snapshot_totals_check";
ALTER TABLE "CommercialQuote"
  RENAME CONSTRAINT "CommercialQuote_snapshot_totals_v3_pending" TO "CommercialQuote_snapshot_totals_check";

ALTER TABLE "CommercialQuote"
  RENAME CONSTRAINT "CommercialQuote_offer_pair_check_v3_pending" TO "CommercialQuote_offer_pair_check";
ALTER TABLE "CommercialQuote"
  RENAME CONSTRAINT "CommercialQuote_authority_shape_v3_pending" TO "CommercialQuote_authority_shape_check";
ALTER TABLE "CommercialQuote"
  RENAME CONSTRAINT "CommercialQuote_v3_totals_pending" TO "CommercialQuote_v3_totals_check";
ALTER TABLE "CommercialQuote"
  RENAME CONSTRAINT "CommercialQuote_snapshot_size_v3_pending" TO "CommercialQuote_snapshot_size_v3_check";

COMMIT;
