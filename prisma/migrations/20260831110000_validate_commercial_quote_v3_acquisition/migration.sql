BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "CommercialCampaignClaim"
  VALIDATE CONSTRAINT "CommercialCampaignClaim_authority_shape_v3_pending";

ALTER TABLE "CommercialCampaignClaim"
  VALIDATE CONSTRAINT "CommercialCampaignClaim_offerVersionId_offerSchemaVersion_fkey";

ALTER TABLE "CommercialAcquisitionContext"
  VALIDATE CONSTRAINT "CommercialAcquisitionContext_authority_shape_v3_pending";

ALTER TABLE "CommercialAcquisitionContext"
  VALIDATE CONSTRAINT "CommercialAcqContext_offerVersion_schemaVersion_fkey";

ALTER TABLE "CommercialAcquisitionContext"
  VALIDATE CONSTRAINT "CommercialAcqContext_reservedCatalog_schemaVersion_fkey";

ALTER TABLE "CommercialQuote"
  VALIDATE CONSTRAINT "CommercialQuote_authority_shape_q3b_pending";

ALTER TABLE "CommercialQuote"
  VALIDATE CONSTRAINT "CommercialQuote_v3_totals_q3b_pending";

ALTER TABLE "CommercialQuote"
  DROP CONSTRAINT "CommercialQuote_authority_shape_check";
ALTER TABLE "CommercialQuote"
  RENAME CONSTRAINT "CommercialQuote_authority_shape_q3b_pending"
  TO "CommercialQuote_authority_shape_check";

ALTER TABLE "CommercialQuote"
  DROP CONSTRAINT "CommercialQuote_v3_totals_check";
ALTER TABLE "CommercialQuote"
  RENAME CONSTRAINT "CommercialQuote_v3_totals_q3b_pending"
  TO "CommercialQuote_v3_totals_check";

COMMIT;
