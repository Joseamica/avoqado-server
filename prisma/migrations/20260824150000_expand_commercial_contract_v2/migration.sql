BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE "CommercialPublication" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "CommercialCampaignVersion" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "CommercialCampaignRuleDraft" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "CommercialQuote" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "CommercialPublication"
  DROP CONSTRAINT "CommercialPublication_schema_version_check";
ALTER TABLE "CommercialCampaignVersion"
  DROP CONSTRAINT "CommercialCampaignVersion_schema_version_check";
ALTER TABLE "CommercialQuote"
  DROP CONSTRAINT "CommercialQuote_schema_version_check",
  DROP CONSTRAINT "CommercialQuote_snapshot_totals_check";
DROP INDEX "CommercialCampaignVersion_sourceDraftId_sourceRevision_key";

ALTER TABLE "CommercialCampaignRuleDraft"
  ALTER COLUMN "amountMinor" TYPE BIGINT USING "amountMinor"::BIGINT;
ALTER TABLE "CommercialQuote"
  ALTER COLUMN "listSubtotalMinor" TYPE BIGINT USING "listSubtotalMinor"::BIGINT,
  ALTER COLUMN "discountMinor" TYPE BIGINT USING "discountMinor"::BIGINT,
  ALTER COLUMN "subtotalMinor" TYPE BIGINT USING "subtotalMinor"::BIGINT,
  ALTER COLUMN "taxMinor" TYPE BIGINT USING "taxMinor"::BIGINT,
  ALTER COLUMN "totalMinor" TYPE BIGINT USING "totalMinor"::BIGINT,
  ALTER COLUMN "renewalSubtotalMinor" TYPE BIGINT USING "renewalSubtotalMinor"::BIGINT,
  ALTER COLUMN "renewalTaxMinor" TYPE BIGINT USING "renewalTaxMinor"::BIGINT,
  ALTER COLUMN "renewalTotalMinor" TYPE BIGINT USING "renewalTotalMinor"::BIGINT;

ALTER TABLE "CommercialPublication" ALTER COLUMN "schemaVersion" SET DEFAULT 2;
ALTER TABLE "CommercialCampaignVersion" ALTER COLUMN "schemaVersion" SET DEFAULT 2;
ALTER TABLE "CommercialQuote" ALTER COLUMN "schemaVersion" SET DEFAULT 2;

CREATE FUNCTION public.commercial_quote_snapshot_matches_v1_row(
  p_snapshot JSONB,
  p_quote_id TEXT,
  p_market TEXT,
  p_currency TEXT,
  p_list_subtotal BIGINT,
  p_discount BIGINT,
  p_subtotal BIGINT,
  p_tax BIGINT,
  p_total BIGINT,
  p_renewal_subtotal BIGINT,
  p_renewal_tax BIGINT,
  p_renewal_total BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  row_amounts BIGINT[] := ARRAY[
    p_list_subtotal, p_discount, p_subtotal, p_tax, p_total,
    p_renewal_subtotal, p_renewal_tax, p_renewal_total
  ];
  snapshot_amounts TEXT[] := ARRAY[
    p_snapshot #>> '{totals,listSubtotalMinor}',
    p_snapshot #>> '{totals,discountMinor}',
    p_snapshot #>> '{totals,subtotalMinor}',
    p_snapshot #>> '{totals,taxMinor}',
    p_snapshot #>> '{totals,totalMinor}',
    p_snapshot #>> '{renewal,subtotalMinor}',
    p_snapshot #>> '{renewal,taxMinor}',
    p_snapshot #>> '{renewal,totalMinor}'
  ];
  amount_index INTEGER;
BEGIN
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_snapshot->'schemaVersion') IS DISTINCT FROM 'number'
    OR (p_snapshot->>'schemaVersion')::NUMERIC <> 1
    OR p_snapshot->>'quoteId' IS DISTINCT FROM p_quote_id
    OR p_snapshot->>'market' IS DISTINCT FROM p_market
    OR p_snapshot->>'currency' IS DISTINCT FROM p_currency
  THEN
    RETURN false;
  END IF;

  FOR amount_index IN 1..8 LOOP
    IF row_amounts[amount_index] < 0
      OR row_amounts[amount_index] > 2147483647
      OR snapshot_amounts[amount_index] IS NULL
      OR snapshot_amounts[amount_index]::NUMERIC <> trunc(snapshot_amounts[amount_index]::NUMERIC)
      OR snapshot_amounts[amount_index]::NUMERIC < 0
      OR snapshot_amounts[amount_index]::NUMERIC > 2147483647
      OR snapshot_amounts[amount_index]::BIGINT <> row_amounts[amount_index]
    THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE FUNCTION public.commercial_quote_snapshot_matches_v2_row(
  p_snapshot JSONB,
  p_quote_id TEXT,
  p_catalog_publication_id TEXT,
  p_campaign_version_id TEXT,
  p_acquisition_context_id TEXT,
  p_organization_id TEXT,
  p_venue_id TEXT,
  p_created_by_id TEXT,
  p_market TEXT,
  p_currency TEXT,
  p_quoted_at TIMESTAMP(3),
  p_expires_at TIMESTAMP(3),
  p_list_subtotal BIGINT,
  p_discount BIGINT,
  p_subtotal BIGINT,
  p_tax BIGINT,
  p_total BIGINT,
  p_renewal_subtotal BIGINT,
  p_renewal_tax BIGINT,
  p_renewal_total BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  max_int8 CONSTANT NUMERIC := 9223372036854775807;
  money_pattern CONSTANT TEXT := '^(0|[1-9][0-9]{0,16})\.[0-9]{2}$';
  timestamp_pattern CONSTANT TEXT := '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$';
  line JSONB;
  step JSONB;
  line_index INTEGER;
  step_index INTEGER;
  money_index INTEGER;
  money_names TEXT[] := ARRAY[
    'unitAmount', 'listSubtotal', 'discount', 'subtotal', 'tax', 'total',
    'renewalSubtotal', 'renewalTax', 'renewalTotal'
  ];
  money_values NUMERIC[];
  money_text TEXT;
  unit_amount NUMERIC;
  line_list NUMERIC;
  line_discount NUMERIC;
  line_subtotal NUMERIC;
  line_tax NUMERIC;
  line_total NUMERIC;
  line_renewal_subtotal NUMERIC;
  line_renewal_tax NUMERIC;
  line_renewal_total NUMERIC;
  quantity_value NUMERIC;
  tax_rate NUMERIC;
  step_input NUMERIC;
  step_discount NUMERIC;
  step_output NUMERIC;
  previous_step_output NUMERIC;
  shared_cycles INTEGER;
  step_cycles INTEGER;
  applied_count INTEGER;
  sum_list NUMERIC := 0;
  sum_discount NUMERIC := 0;
  sum_subtotal NUMERIC := 0;
  sum_tax NUMERIC := 0;
  sum_total NUMERIC := 0;
  sum_renewal_subtotal NUMERIC := 0;
  sum_renewal_tax NUMERIC := 0;
  sum_renewal_total NUMERIC := 0;
  root_names TEXT[] := ARRAY['listSubtotal', 'discount', 'subtotal', 'tax', 'total', 'subtotal', 'tax', 'total'];
  root_values NUMERIC[];
  root JSONB;
BEGIN
  IF p_snapshot IS NULL
    OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_snapshot->'schemaVersion') IS DISTINCT FROM 'number'
    OR (p_snapshot->>'schemaVersion')::NUMERIC <> 2
    OR p_snapshot->>'quoteId' IS DISTINCT FROM p_quote_id
    OR p_snapshot->>'catalogPublicationId' IS DISTINCT FROM p_catalog_publication_id
    OR p_snapshot->>'market' IS DISTINCT FROM p_market
    OR p_snapshot->>'currency' IS DISTINCT FROM p_currency
    OR p_snapshot->>'quotedAt' !~ timestamp_pattern
    OR p_snapshot->>'expiresAt' !~ timestamp_pattern
    OR make_timestamp(
      substring(p_snapshot->>'quotedAt' FROM 1 FOR 4)::INTEGER,
      substring(p_snapshot->>'quotedAt' FROM 6 FOR 2)::INTEGER,
      substring(p_snapshot->>'quotedAt' FROM 9 FOR 2)::INTEGER,
      substring(p_snapshot->>'quotedAt' FROM 12 FOR 2)::INTEGER,
      substring(p_snapshot->>'quotedAt' FROM 15 FOR 2)::INTEGER,
      substring(p_snapshot->>'quotedAt' FROM 18 FOR 2)::INTEGER
        + substring(p_snapshot->>'quotedAt' FROM 21 FOR 3)::NUMERIC / 1000
    ) IS DISTINCT FROM p_quoted_at
    OR make_timestamp(
      substring(p_snapshot->>'expiresAt' FROM 1 FOR 4)::INTEGER,
      substring(p_snapshot->>'expiresAt' FROM 6 FOR 2)::INTEGER,
      substring(p_snapshot->>'expiresAt' FROM 9 FOR 2)::INTEGER,
      substring(p_snapshot->>'expiresAt' FROM 12 FOR 2)::INTEGER,
      substring(p_snapshot->>'expiresAt' FROM 15 FOR 2)::INTEGER,
      substring(p_snapshot->>'expiresAt' FROM 18 FOR 2)::INTEGER
        + substring(p_snapshot->>'expiresAt' FROM 21 FOR 3)::NUMERIC / 1000
    ) IS DISTINCT FROM p_expires_at
    OR p_quoted_at >= p_expires_at
    OR jsonb_typeof(p_snapshot->'lines') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_snapshot->'lines') = 0
    OR jsonb_typeof(p_snapshot->'totals') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_snapshot->'renewal') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_snapshot->'subject') IS DISTINCT FROM 'object'
  THEN
    RETURN false;
  END IF;

  IF p_campaign_version_id IS NULL THEN
    IF jsonb_typeof(p_snapshot->'campaignVersionId') IS DISTINCT FROM 'null'
      OR jsonb_typeof(p_snapshot->'campaignCode') IS DISTINCT FROM 'null'
    THEN
      RETURN false;
    END IF;
  ELSIF p_snapshot->>'campaignVersionId' IS DISTINCT FROM p_campaign_version_id
    OR jsonb_typeof(p_snapshot->'campaignCode') IS DISTINCT FROM 'string'
  THEN
    RETURN false;
  END IF;

  IF p_snapshot #>> '{subject,kind}' = 'ACQUISITION_CONTEXT' THEN
    IF p_acquisition_context_id IS NULL
      OR p_snapshot #>> '{subject,acquisitionContextId}' IS DISTINCT FROM p_acquisition_context_id
      OR p_snapshot->>'acquisitionContextId' IS DISTINCT FROM p_acquisition_context_id
      OR p_snapshot->'subject' ? 'organizationId'
      OR p_snapshot->'subject' ? 'venueId'
      OR p_snapshot->'subject' ? 'actorId'
      OR p_organization_id IS NOT NULL OR p_venue_id IS NOT NULL OR p_created_by_id IS NOT NULL
      OR jsonb_typeof(p_snapshot->'derivedFromPreview') IS DISTINCT FROM 'null'
    THEN
      RETURN false;
    END IF;
  ELSIF p_snapshot #>> '{subject,kind}' = 'VENUE' THEN
    IF p_organization_id IS NULL OR p_venue_id IS NULL OR p_created_by_id IS NULL
      OR p_snapshot #>> '{subject,organizationId}' IS DISTINCT FROM p_organization_id
      OR p_snapshot #>> '{subject,venueId}' IS DISTINCT FROM p_venue_id
      OR p_snapshot #>> '{subject,actorId}' IS DISTINCT FROM p_created_by_id
    THEN
      RETURN false;
    END IF;
    IF p_acquisition_context_id IS NULL THEN
      IF jsonb_typeof(p_snapshot->'acquisitionContextId') IS DISTINCT FROM 'null'
        OR jsonb_typeof(p_snapshot->'derivedFromPreview') IS DISTINCT FROM 'null'
      THEN
        RETURN false;
      END IF;
    ELSIF p_snapshot->>'acquisitionContextId' IS DISTINCT FROM p_acquisition_context_id
      OR jsonb_typeof(p_snapshot->'derivedFromPreview') IS DISTINCT FROM 'object'
    THEN
      RETURN false;
    END IF;
  ELSE
    RETURN false;
  END IF;

  FOR line, line_index IN
    SELECT element, ordinality::INTEGER
      FROM jsonb_array_elements(p_snapshot->'lines') WITH ORDINALITY AS elements(element, ordinality)
  LOOP
    IF jsonb_typeof(line) IS DISTINCT FROM 'object'
      OR jsonb_typeof(line->'quantity') IS DISTINCT FROM 'number'
      OR (line->>'quantity')::NUMERIC <> trunc((line->>'quantity')::NUMERIC)
      OR (line->>'quantity')::NUMERIC NOT BETWEEN 1 AND 1000
      OR jsonb_typeof(line->'taxRateBasisPoints') IS DISTINCT FROM 'number'
      OR (line->>'taxRateBasisPoints')::NUMERIC <> trunc((line->>'taxRateBasisPoints')::NUMERIC)
      OR (line->>'taxRateBasisPoints')::NUMERIC NOT IN (0, 1600)
      OR jsonb_typeof(line->'appliedCampaigns') IS DISTINCT FROM 'array'
    THEN
      RETURN false;
    END IF;
    quantity_value := (line->>'quantity')::NUMERIC;
    tax_rate := (line->>'taxRateBasisPoints')::NUMERIC;
    money_values := ARRAY[]::NUMERIC[];
    FOR money_index IN 1..9 LOOP
      IF jsonb_typeof(line->money_names[money_index]) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      money_text := line->>money_names[money_index];
      IF money_text !~ money_pattern THEN RETURN false; END IF;
      money_values := array_append(money_values, replace(money_text, '.', '')::NUMERIC);
      IF money_values[money_index] < 0 OR money_values[money_index] > max_int8 THEN RETURN false; END IF;
    END LOOP;
    unit_amount := money_values[1];
    line_list := money_values[2];
    line_discount := money_values[3];
    line_subtotal := money_values[4];
    line_tax := money_values[5];
    line_total := money_values[6];
    line_renewal_subtotal := money_values[7];
    line_renewal_tax := money_values[8];
    line_renewal_total := money_values[9];

    applied_count := jsonb_array_length(line->'appliedCampaigns');
    previous_step_output := NULL;
    shared_cycles := NULL;
    IF applied_count = 0 THEN
      IF line_discount <> 0 OR line_subtotal <> line_list OR jsonb_typeof(line->'promotionalCycles') IS DISTINCT FROM 'null' THEN RETURN false; END IF;
    ELSE
      FOR step, step_index IN
        SELECT element, ordinality::INTEGER
          FROM jsonb_array_elements(line->'appliedCampaigns') WITH ORDINALITY AS elements(element, ordinality)
      LOOP
        IF jsonb_typeof(step) IS DISTINCT FROM 'object'
          OR jsonb_typeof(step->'position') IS DISTINCT FROM 'number'
          OR (step->>'position')::NUMERIC <> trunc((step->>'position')::NUMERIC)
          OR (step->>'position')::NUMERIC <> step_index
          OR step_index NOT BETWEEN 1 AND 10
          OR jsonb_typeof(step->'cycles') IS DISTINCT FROM 'number'
          OR (step->>'cycles')::NUMERIC <> trunc((step->>'cycles')::NUMERIC)
          OR (step->>'cycles')::NUMERIC NOT BETWEEN 1 AND 120
        THEN
          RETURN false;
        END IF;
        step_cycles := (step->>'cycles')::INTEGER;
        IF shared_cycles IS NULL THEN shared_cycles := step_cycles;
        ELSIF shared_cycles <> step_cycles THEN RETURN false;
        END IF;
        IF p_campaign_version_id IS NULL
          OR step->>'campaignVersionId' IS DISTINCT FROM p_campaign_version_id
          OR step->>'campaignCode' IS DISTINCT FROM p_snapshot->>'campaignCode'
        THEN
          RETURN false;
        END IF;
        IF jsonb_typeof(step->'inputAmount') IS DISTINCT FROM 'string'
          OR jsonb_typeof(step->'discountAmount') IS DISTINCT FROM 'string'
          OR jsonb_typeof(step->'outputAmount') IS DISTINCT FROM 'string'
          OR step->>'inputAmount' !~ money_pattern
          OR step->>'discountAmount' !~ money_pattern
          OR step->>'outputAmount' !~ money_pattern
        THEN
          RETURN false;
        END IF;
        step_input := replace(step->>'inputAmount', '.', '')::NUMERIC;
        step_discount := replace(step->>'discountAmount', '.', '')::NUMERIC;
        step_output := replace(step->>'outputAmount', '.', '')::NUMERIC;
        IF step_input > max_int8 OR step_discount > max_int8 OR step_output > max_int8
          OR (step_index = 1 AND step_input <> line_list)
          OR (step_index > 1 AND step_input <> previous_step_output)
          OR step_input - step_discount <> step_output
        THEN
          RETURN false;
        END IF;
        previous_step_output := step_output;
      END LOOP;
      IF previous_step_output <> line_subtotal
        OR jsonb_typeof(line->'promotionalCycles') IS DISTINCT FROM 'number'
        OR (line->>'promotionalCycles')::NUMERIC <> trunc((line->>'promotionalCycles')::NUMERIC)
        OR (line->>'promotionalCycles')::NUMERIC NOT BETWEEN 1 AND 120
        OR (line->>'promotionalCycles')::NUMERIC <> shared_cycles
      THEN
        RETURN false;
      END IF;
    END IF;

    IF unit_amount * quantity_value > max_int8
      OR unit_amount * quantity_value <> line_list
      OR line_list - line_discount <> line_subtotal
      OR floor((line_subtotal * tax_rate + 5000) / 10000) <> line_tax
      OR line_subtotal + line_tax <> line_total
      OR line_renewal_subtotal <> line_list
      OR floor((line_renewal_subtotal * tax_rate + 5000) / 10000) <> line_renewal_tax
      OR line_renewal_subtotal + line_renewal_tax <> line_renewal_total
    THEN
      RETURN false;
    END IF;

    sum_list := sum_list + line_list;
    sum_discount := sum_discount + line_discount;
    sum_subtotal := sum_subtotal + line_subtotal;
    sum_tax := sum_tax + line_tax;
    sum_total := sum_total + line_total;
    sum_renewal_subtotal := sum_renewal_subtotal + line_renewal_subtotal;
    sum_renewal_tax := sum_renewal_tax + line_renewal_tax;
    sum_renewal_total := sum_renewal_total + line_renewal_total;
    IF greatest(sum_list, sum_discount, sum_subtotal, sum_tax, sum_total, sum_renewal_subtotal, sum_renewal_tax, sum_renewal_total) > max_int8 THEN
      RETURN false;
    END IF;
  END LOOP;

  root_values := ARRAY[]::NUMERIC[];
  FOR money_index IN 1..8 LOOP
    root := CASE WHEN money_index <= 5 THEN p_snapshot->'totals' ELSE p_snapshot->'renewal' END;
    IF jsonb_typeof(root->root_names[money_index]) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    money_text := root->>root_names[money_index];
    IF money_text !~ money_pattern THEN RETURN false; END IF;
    root_values := array_append(root_values, replace(money_text, '.', '')::NUMERIC);
    IF root_values[money_index] > max_int8 THEN RETURN false; END IF;
  END LOOP;

  RETURN root_values = ARRAY[sum_list, sum_discount, sum_subtotal, sum_tax, sum_total, sum_renewal_subtotal, sum_renewal_tax, sum_renewal_total]
    AND root_values[1] - root_values[2] = root_values[3]
    AND root_values[3] + root_values[4] = root_values[5]
    AND root_values[6] + root_values[7] = root_values[8]
    AND root_values = ARRAY[
      p_list_subtotal::NUMERIC, p_discount::NUMERIC, p_subtotal::NUMERIC, p_tax::NUMERIC, p_total::NUMERIC,
      p_renewal_subtotal::NUMERIC, p_renewal_tax::NUMERIC, p_renewal_total::NUMERIC
    ];
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

ALTER TABLE "CommercialPublication"
  ADD CONSTRAINT "CommercialPublication_schema_version_check" CHECK ("schemaVersion" IN (1, 2)),
  ADD CONSTRAINT "CommercialPublication_snapshot_schema_version_check" CHECK ((CASE
    WHEN jsonb_typeof("snapshot"->'schemaVersion') = 'number'
      AND ("snapshot"->>'schemaVersion')::NUMERIC = trunc(("snapshot"->>'schemaVersion')::NUMERIC)
      AND ("snapshot"->>'schemaVersion')::NUMERIC BETWEEN 1 AND 2
    THEN ("snapshot"->>'schemaVersion')::NUMERIC = "schemaVersion"
    ELSE false
  END) IS TRUE);

ALTER TABLE "CommercialCampaignVersion"
  ADD CONSTRAINT "CommercialCampaignVersion_schema_version_check" CHECK ("schemaVersion" IN (1, 2)),
  ADD CONSTRAINT "CommercialCampaignVersion_snapshot_schema_version_check" CHECK ((CASE
    WHEN jsonb_typeof("snapshot"->'schemaVersion') = 'number'
      AND ("snapshot"->>'schemaVersion')::NUMERIC = trunc(("snapshot"->>'schemaVersion')::NUMERIC)
      AND ("snapshot"->>'schemaVersion')::NUMERIC BETWEEN 1 AND 2
    THEN ("snapshot"->>'schemaVersion')::NUMERIC = "schemaVersion"
    ELSE false
  END) IS TRUE);

ALTER TABLE "CommercialCampaignRuleDraft"
  ADD CONSTRAINT "CommercialCampaignRuleDraft_v1_amount_int4_check"
  CHECK ("amountMinor" IS NULL OR "amountMinor" <= 2147483647);

ALTER TABLE "CommercialQuote"
  ADD CONSTRAINT "CommercialQuote_schema_version_check" CHECK ("schemaVersion" IN (1, 2)),
  ADD CONSTRAINT "CommercialQuote_snapshot_schema_version_check" CHECK ((CASE
    WHEN jsonb_typeof("snapshot"->'schemaVersion') = 'number'
      AND ("snapshot"->>'schemaVersion')::NUMERIC = trunc(("snapshot"->>'schemaVersion')::NUMERIC)
      AND ("snapshot"->>'schemaVersion')::NUMERIC BETWEEN 1 AND 2
    THEN ("snapshot"->>'schemaVersion')::NUMERIC = "schemaVersion"
    ELSE false
  END) IS TRUE),
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

CREATE UNIQUE INDEX "CommercialCampaignVersion_sourceDraft_revision_schema_key"
  ON "CommercialCampaignVersion"("sourceDraftId", "sourceRevision", "schemaVersion");

COMMIT;
