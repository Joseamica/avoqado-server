BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE "CommercialCampaignDraft" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "CommercialCampaignVersion" IN ACCESS EXCLUSIVE MODE;

CREATE TYPE "CommercialOfferBenefitDraftKind" AS ENUM (
  'HARDWARE_PERCENT_OFF',
  'HARDWARE_FIXED_PRICE',
  'PAYMENTS_RATE_SCHEDULE'
);

ALTER TABLE "CommercialCampaignDraft"
  ADD COLUMN "offerSchemaVersion" INTEGER NOT NULL DEFAULT 2,
  ADD CONSTRAINT "CommercialCampaignDraft_offer_schema_version_check"
    CHECK ("offerSchemaVersion" IN (2, 3));

CREATE UNIQUE INDEX "CommercialCampaignDraft_id_offerSchemaVersion_key"
  ON "CommercialCampaignDraft"("id", "offerSchemaVersion");

CREATE TABLE "CommercialOfferBenefitDraft" (
  "id" TEXT NOT NULL,
  "campaignDraftId" TEXT NOT NULL,
  "offerSchemaVersion" INTEGER NOT NULL DEFAULT 3,
  "benefitCode" TEXT NOT NULL,
  "kind" "CommercialOfferBenefitDraftKind" NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "hardwareCatalogKey" TEXT,
  "percentBasisPoints" INTEGER,
  "unitAmountMinor" BIGINT,
  "quantityLimit" INTEGER,
  "benefitStartsAt" TIMESTAMP(3),
  "benefitEndsAt" TIMESTAMP(3),
  "paymentsRateScheduleVersionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CommercialOfferBenefitDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialOfferBenefitDraft_schema_v3_check" CHECK ("offerSchemaVersion" = 3),
  CONSTRAINT "CommercialOfferBenefitDraft_code_check" CHECK ("benefitCode" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT "CommercialOfferBenefitDraft_priority_check" CHECK ("priority" BETWEEN -10000 AND 10000),
  CONSTRAINT "CommercialOfferBenefitDraft_shape_check" CHECK (
    (
      "kind" = 'HARDWARE_PERCENT_OFF'
      AND "hardwareCatalogKey" ~ '^[A-Z][A-Z0-9_]{1,63}$'
      AND "percentBasisPoints" BETWEEN 1 AND 10000
      AND "unitAmountMinor" IS NULL
      AND "quantityLimit" BETWEEN 1 AND 1000
      AND "benefitStartsAt" < "benefitEndsAt"
      AND "paymentsRateScheduleVersionId" IS NULL
    )
    OR
    (
      "kind" = 'HARDWARE_FIXED_PRICE'
      AND "hardwareCatalogKey" ~ '^[A-Z][A-Z0-9_]{1,63}$'
      AND "percentBasisPoints" IS NULL
      AND "unitAmountMinor" BETWEEN 0 AND 999999999999
      AND "quantityLimit" BETWEEN 1 AND 1000
      AND "benefitStartsAt" < "benefitEndsAt"
      AND "paymentsRateScheduleVersionId" IS NULL
    )
    OR
    (
      "kind" = 'PAYMENTS_RATE_SCHEDULE'
      AND "hardwareCatalogKey" IS NULL
      AND "percentBasisPoints" IS NULL
      AND "unitAmountMinor" IS NULL
      AND "quantityLimit" IS NULL
      AND "benefitStartsAt" IS NULL
      AND "benefitEndsAt" IS NULL
      AND "paymentsRateScheduleVersionId" ~ '^payments-rate-schedule-version-[A-Za-z0-9][A-Za-z0-9._:-]{0,95}-v[1-9][0-9]{0,8}$'
    )
  )
);

CREATE UNIQUE INDEX "CommercialOfferBenefitDraft_campaignDraftId_benefitCode_key"
  ON "CommercialOfferBenefitDraft"("campaignDraftId", "benefitCode");
CREATE INDEX "CommercialOfferBenefitDraft_parent_priority_idx"
  ON "CommercialOfferBenefitDraft"("campaignDraftId", "priority", "benefitCode");
CREATE INDEX "CommercialOfferBenefitDraft_sku_window_idx"
  ON "CommercialOfferBenefitDraft"("hardwareCatalogKey", "benefitStartsAt", "benefitEndsAt");

ALTER TABLE "CommercialOfferBenefitDraft"
  ADD CONSTRAINT "CommercialOfferBenefitDraft_parent_schema_fkey"
  FOREIGN KEY ("campaignDraftId", "offerSchemaVersion")
  REFERENCES "CommercialCampaignDraft"("id", "offerSchemaVersion")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommercialCampaignVersion"
  DROP CONSTRAINT "CommercialCampaignVersion_schema_version_check",
  DROP CONSTRAINT "CommercialCampaignVersion_snapshot_schema_version_check";

ALTER TABLE "CommercialCampaignVersion"
  ADD CONSTRAINT "CommercialCampaignVersion_schema_version_check" CHECK ("schemaVersion" IN (1, 2, 3)),
  ADD CONSTRAINT "CommercialCampaignVersion_snapshot_schema_version_check" CHECK ((CASE
    WHEN jsonb_typeof("snapshot"->'schemaVersion') = 'number'
      AND ("snapshot"->>'schemaVersion')::NUMERIC = trunc(("snapshot"->>'schemaVersion')::NUMERIC)
      AND ("snapshot"->>'schemaVersion')::NUMERIC BETWEEN 1 AND 3
    THEN ("snapshot"->>'schemaVersion')::NUMERIC = "schemaVersion"
    ELSE false
  END) IS TRUE);

CREATE FUNCTION reject_commercial_offer_v3_operational_reference() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  referenced_schema_version INTEGER;
BEGIN
  IF NEW."campaignVersionId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "schemaVersion"
    INTO referenced_schema_version
    FROM "CommercialCampaignVersion"
    WHERE "id" = NEW."campaignVersionId"
    FOR KEY SHARE;

  IF referenced_schema_version = 3 THEN
    RAISE EXCEPTION 'Commercial Offer v3 cannot be an operational campaign authority yet'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER commercial_campaign_activation_reject_offer_v3
BEFORE INSERT OR UPDATE OF "campaignVersionId" ON "CommercialCampaignActivation"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_offer_v3_operational_reference();

CREATE TRIGGER commercial_campaign_claim_reject_offer_v3
BEFORE INSERT OR UPDATE OF "campaignVersionId" ON "CommercialCampaignClaim"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_offer_v3_operational_reference();

CREATE TRIGGER commercial_acquisition_context_reject_offer_v3
BEFORE INSERT OR UPDATE OF "campaignVersionId" ON "CommercialAcquisitionContext"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_offer_v3_operational_reference();

CREATE TRIGGER commercial_quote_reject_offer_v3
BEFORE INSERT OR UPDATE OF "campaignVersionId" ON "CommercialQuote"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_offer_v3_operational_reference();

COMMIT;
