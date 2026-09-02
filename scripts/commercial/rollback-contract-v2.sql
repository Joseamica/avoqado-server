ALTER TABLE "CommercialQuote"
  DROP CONSTRAINT "CommercialQuote_snapshot_totals_check";
ALTER TABLE "CommercialPublication"
  DROP CONSTRAINT "CommercialPublication_snapshot_schema_version_check";
ALTER TABLE "CommercialCampaignVersion"
  DROP CONSTRAINT "CommercialCampaignVersion_snapshot_schema_version_check";
ALTER TABLE "CommercialQuote"
  DROP CONSTRAINT "CommercialQuote_snapshot_schema_version_check";

DROP INDEX "CommercialCampaignVersion_sourceDraft_revision_schema_key";

ALTER TABLE "CommercialCampaignRuleDraft"
  DROP CONSTRAINT "CommercialCampaignRuleDraft_v1_amount_int4_check";

ALTER TABLE "CommercialPublication"
  DROP CONSTRAINT "CommercialPublication_schema_version_check",
  ADD CONSTRAINT "CommercialPublication_schema_version_check" CHECK ("schemaVersion" = 1),
  ALTER COLUMN "schemaVersion" SET DEFAULT 1;

ALTER TABLE "CommercialCampaignVersion"
  DROP CONSTRAINT "CommercialCampaignVersion_schema_version_check",
  ADD CONSTRAINT "CommercialCampaignVersion_schema_version_check" CHECK ("schemaVersion" = 1),
  ALTER COLUMN "schemaVersion" SET DEFAULT 1;

ALTER TABLE "CommercialQuote"
  DROP CONSTRAINT "CommercialQuote_schema_version_check",
  ADD CONSTRAINT "CommercialQuote_schema_version_check" CHECK ("schemaVersion" = 1),
  ALTER COLUMN "schemaVersion" SET DEFAULT 1;

ALTER TABLE "CommercialCampaignRuleDraft"
  ALTER COLUMN "amountMinor" TYPE INTEGER USING "amountMinor"::INTEGER;

ALTER TABLE "CommercialQuote"
  ALTER COLUMN "listSubtotalMinor" TYPE INTEGER USING "listSubtotalMinor"::INTEGER,
  ALTER COLUMN "discountMinor" TYPE INTEGER USING "discountMinor"::INTEGER,
  ALTER COLUMN "subtotalMinor" TYPE INTEGER USING "subtotalMinor"::INTEGER,
  ALTER COLUMN "taxMinor" TYPE INTEGER USING "taxMinor"::INTEGER,
  ALTER COLUMN "totalMinor" TYPE INTEGER USING "totalMinor"::INTEGER,
  ALTER COLUMN "renewalSubtotalMinor" TYPE INTEGER USING "renewalSubtotalMinor"::INTEGER,
  ALTER COLUMN "renewalTaxMinor" TYPE INTEGER USING "renewalTaxMinor"::INTEGER,
  ALTER COLUMN "renewalTotalMinor" TYPE INTEGER USING "renewalTotalMinor"::INTEGER;

ALTER TABLE "CommercialQuote"
  ADD CONSTRAINT "CommercialQuote_snapshot_totals_check" CHECK ((
    commercial_quote_snapshot_is_consistent("snapshot")
    AND ("snapshot" #>> '{schemaVersion}')::INTEGER = 1
    AND "snapshot" #>> '{quoteId}' = "id"
    AND "snapshot" #>> '{market}' = "market"
    AND "snapshot" #>> '{currency}' = "currency"
    AND ("snapshot" #>> '{totals,listSubtotalMinor}')::INTEGER = "listSubtotalMinor"
    AND ("snapshot" #>> '{totals,discountMinor}')::INTEGER = "discountMinor"
    AND ("snapshot" #>> '{totals,subtotalMinor}')::INTEGER = "subtotalMinor"
    AND ("snapshot" #>> '{totals,taxMinor}')::INTEGER = "taxMinor"
    AND ("snapshot" #>> '{totals,totalMinor}')::INTEGER = "totalMinor"
    AND ("snapshot" #>> '{renewal,subtotalMinor}')::INTEGER = "renewalSubtotalMinor"
    AND ("snapshot" #>> '{renewal,taxMinor}')::INTEGER = "renewalTaxMinor"
    AND ("snapshot" #>> '{renewal,totalMinor}')::INTEGER = "renewalTotalMinor"
  ) IS TRUE);

CREATE UNIQUE INDEX "CommercialCampaignVersion_sourceDraftId_sourceRevision_key"
  ON "CommercialCampaignVersion"("sourceDraftId", "sourceRevision");

DROP FUNCTION public.commercial_quote_snapshot_matches_v1_row(
  JSONB, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT
);
DROP FUNCTION public.commercial_quote_snapshot_matches_v2_row(
  JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TIMESTAMP(3), TIMESTAMP(3), BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT
);
