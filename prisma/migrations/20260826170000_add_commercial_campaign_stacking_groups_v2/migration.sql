BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE "CommercialCampaignDraft" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "CommercialCampaignRuleDraft" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  invalid_legacy_group_count BIGINT;
  invalid_rule_amount_count BIGINT;
BEGIN
  SELECT COUNT(*)
  INTO invalid_legacy_group_count
  FROM "CommercialCampaignDraft"
  WHERE jsonb_typeof("allowedRuleCodeGroups") IS DISTINCT FROM 'array';

  SELECT COUNT(*)
  INTO invalid_rule_amount_count
  FROM "CommercialCampaignRuleDraft"
  WHERE "amountMinor" IS NOT NULL
    AND "amountMinor" NOT BETWEEN 0 AND 999999999999;

  IF invalid_legacy_group_count <> 0 OR invalid_rule_amount_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'COMMERCIAL_CAMPAIGN_C2_LEGACY_PREFLIGHT_FAILED';
  END IF;
END
$$;

ALTER TABLE "CommercialCampaignDraft"
  ADD COLUMN "stackingGroups" JSONB,
  ALTER COLUMN "allowedRuleCodeGroups" DROP NOT NULL;

ALTER TABLE "CommercialCampaignRuleDraft"
  DROP CONSTRAINT "CommercialCampaignRuleDraft_v1_amount_int4_check",
  ADD CONSTRAINT "CommercialCampaignRuleDraft_amount_unit_check"
  CHECK ("amountMinor" IS NULL OR "amountMinor" BETWEEN 0 AND 999999999999);

ALTER TABLE "CommercialCampaignDraft"
  ADD CONSTRAINT "CommercialCampaignDraft_stacking_storage_check"
  CHECK ((
    "stackingGroups" IS NULL
    AND "allowedRuleCodeGroups" IS NOT NULL
    AND jsonb_typeof("allowedRuleCodeGroups") = 'array'
  ) OR (
    "allowedRuleCodeGroups" IS NULL
    AND "stackingGroups" IS NOT NULL
    AND jsonb_typeof("stackingGroups") = 'array'
  ));

COMMIT;
