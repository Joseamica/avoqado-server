BEGIN;

-- Every lock-bearing statement in this supervised expand migration must either
-- acquire its lock quickly or abort without leaving a partial schema.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- Reject an unknown historical immutable-trigger mode before taking the long-lived
-- CommercialQuote/Staff/CommercialCampaignVersion locks below.
DO $$
DECLARE
  legacy_trigger_mode "char";
BEGIN
  SELECT trigger_row.tgenabled
    INTO legacy_trigger_mode
    FROM pg_trigger AS trigger_row
    JOIN pg_class AS trigger_table ON trigger_table.oid = trigger_row.tgrelid
    JOIN pg_namespace AS trigger_schema ON trigger_schema.oid = trigger_table.relnamespace
   WHERE trigger_row.tgname = 'commercial_quote_immutable'
     AND trigger_table.relname = 'CommercialQuote'
     AND trigger_schema.nspname = 'public'
     AND NOT trigger_row.tgisinternal;

  IF legacy_trigger_mode IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'Commercial Quote v3 requires commercial_quote_immutable in origin mode'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE TYPE "CommercialOfferControlAction" AS ENUM (
  'SUSPEND_NEW_CLAIMS',
  'SUSPEND_ALL_PENDING',
  'RESUME'
);

CREATE UNIQUE INDEX "CommercialCampaignVersion_id_schemaVersion_key"
  ON "CommercialCampaignVersion"("id", "schemaVersion");

ALTER TABLE "CommercialQuote"
  ADD COLUMN "offerVersionId" TEXT,
  ADD COLUMN "offerSchemaVersion" INTEGER;

CREATE INDEX "CommercialQuote_offerVersionId_idx"
  ON "CommercialQuote"("offerVersionId");

CREATE TABLE "CommercialOfferControlEvent" (
  "id" TEXT NOT NULL,
  "offerVersionId" TEXT NOT NULL,
  "offerSchemaVersion" INTEGER NOT NULL DEFAULT 3,
  "revision" INTEGER NOT NULL,
  "action" "CommercialOfferControlAction" NOT NULL,
  "reason" TEXT NOT NULL,
  "confirmedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialOfferControlEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialOfferControlEvent_schema_v3_check" CHECK ("offerSchemaVersion" = 3),
  CONSTRAINT "CommercialOfferControlEvent_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "CommercialOfferControlEvent_reason_check" CHECK (length(btrim("reason")) BETWEEN 3 AND 500),
  CONSTRAINT "CommercialOfferControlEvent_offer_schema_fkey"
    FOREIGN KEY ("offerVersionId", "offerSchemaVersion")
    REFERENCES "CommercialCampaignVersion"("id", "schemaVersion")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialOfferControlEvent_confirmedById_fkey"
    FOREIGN KEY ("confirmedById") REFERENCES "Staff"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CommercialOfferControlEvent_offerVersionId_revision_key"
  ON "CommercialOfferControlEvent"("offerVersionId", "revision");
CREATE INDEX "CommercialOfferControlEvent_latest_idx"
  ON "CommercialOfferControlEvent"("offerVersionId", "revision" DESC);
CREATE INDEX "CommercialOfferControlEvent_confirmedBy_createdAt_idx"
  ON "CommercialOfferControlEvent"("confirmedById", "createdAt");

CREATE FUNCTION public.commercial_quote_snapshot_matches_v3_row(
  p_snapshot JSONB,
  p_quote_id TEXT,
  p_catalog_publication_id TEXT,
  p_offer_version_id TEXT,
  p_offer_schema_version INTEGER,
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
SET search_path = pg_catalog, public
AS $$
DECLARE
  max_int8 CONSTANT NUMERIC := 9223372036854775807;
  minor_pattern CONSTANT TEXT := '^(0|[1-9][0-9]{0,18})$';
  timestamp_pattern CONSTANT TEXT := '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$';
  line JSONB;
  step JSONB;
  benefit JSONB;
  root JSONB;
  line_index INTEGER;
  root_index INTEGER;
  step_index INTEGER;
  money_index INTEGER;
  quantity_value NUMERIC;
  benefited_quantity NUMERIC;
  list_price_quantity NUMERIC;
  tax_rate NUMERIC;
  values_numeric NUMERIC[];
  money_text TEXT;
  line_key TEXT;
  seen_line_keys TEXT[] := ARRAY[]::TEXT[];
  unit_amount NUMERIC;
  line_list NUMERIC;
  line_discount NUMERIC;
  line_subtotal NUMERIC;
  line_tax NUMERIC;
  line_total NUMERIC;
  line_renewal_subtotal NUMERIC;
  line_renewal_tax NUMERIC;
  line_renewal_total NUMERIC;
  step_input NUMERIC;
  step_discount NUMERIC;
  step_output NUMERIC;
  previous_step_output NUMERIC;
  shared_cycles INTEGER;
  step_cycles INTEGER;
  benefit_amount NUMERIC;
  benefit_basis_points NUMERIC;
  recurring_sums NUMERIC[] := ARRAY[0, 0, 0, 0, 0]::NUMERIC[];
  one_time_sums NUMERIC[] := ARRAY[0, 0, 0, 0, 0]::NUMERIC[];
  renewal_sums NUMERIC[] := ARRAY[0, 0, 0, 0, 0]::NUMERIC[];
  due_now_sums NUMERIC[];
  root_values NUMERIC[];
  expected_values NUMERIC[];
  saas_money_names TEXT[] := ARRAY[
    'listUnitAmountMinor', 'listSubtotalMinor', 'discountMinor', 'subtotalMinor', 'taxMinor',
    'totalMinor', 'renewalSubtotalMinor', 'renewalTaxMinor', 'renewalTotalMinor'
  ];
  hardware_money_names TEXT[] := ARRAY[
    'listSubtotalMinor', 'discountMinor', 'subtotalMinor', 'taxMinor', 'totalMinor'
  ];
  breakdown_names TEXT[] := ARRAY[
    'listSubtotalMinor', 'discountMinor', 'subtotalMinor', 'taxMinor', 'totalMinor'
  ];
BEGIN
  IF p_snapshot IS NULL
    OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_snapshot->'schemaVersion') IS DISTINCT FROM 'number'
    OR (p_snapshot->>'schemaVersion')::NUMERIC <> 3
    OR p_snapshot->>'contractVersion' IS DISTINCT FROM '3.0.0'
    OR p_snapshot->>'quoteId' IS DISTINCT FROM p_quote_id
    OR p_snapshot->>'catalogPublicationId' IS DISTINCT FROM p_catalog_publication_id
    OR p_snapshot->>'offerVersionId' IS DISTINCT FROM p_offer_version_id
    OR p_offer_schema_version IS DISTINCT FROM 3
    OR p_snapshot->>'market' IS DISTINCT FROM p_market
    OR p_snapshot->>'currency' IS DISTINCT FROM p_currency
    OR p_market IS DISTINCT FROM 'MX'
    OR p_currency IS DISTINCT FROM 'MXN'
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
    OR p_expires_at IS DISTINCT FROM p_quoted_at + interval '15 minutes'
    OR jsonb_typeof(p_snapshot->'subject') IS DISTINCT FROM 'object'
    OR p_snapshot #>> '{subject,kind}' IS DISTINCT FROM 'VENUE'
    OR p_snapshot #>> '{subject,organizationId}' IS DISTINCT FROM p_organization_id
    OR p_snapshot #>> '{subject,venueId}' IS DISTINCT FROM p_venue_id
    OR p_snapshot #>> '{subject,actorId}' IS DISTINCT FROM p_created_by_id
    OR p_organization_id IS NULL
    OR p_venue_id IS NULL
    OR p_created_by_id IS NULL
    OR p_acquisition_context_id IS NOT NULL
    OR jsonb_typeof(p_snapshot->'acquisitionContextId') IS DISTINCT FROM 'null'
    OR jsonb_typeof(p_snapshot->'derivedFromPreview') IS DISTINCT FROM 'null'
    OR jsonb_typeof(p_snapshot->'saasLines') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_snapshot->'hardwareLines') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_snapshot->'saasLines') + jsonb_array_length(p_snapshot->'hardwareLines') NOT BETWEEN 1 AND 50
    OR jsonb_typeof(p_snapshot->'entitlementGrants') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_snapshot->'entitlementGrants') > 128
    OR jsonb_typeof(p_snapshot->'resolution') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_snapshot #> '{resolution,schemaVersion}') IS DISTINCT FROM 'number'
    OR (p_snapshot #>> '{resolution,schemaVersion}')::NUMERIC <> 3
    OR jsonb_typeof(p_snapshot #> '{resolution,resolutionVersion}') IS DISTINCT FROM 'number'
    OR (p_snapshot #>> '{resolution,resolutionVersion}')::NUMERIC <> 2
    OR p_snapshot #>> '{resolution,campaignVersionId}' IS DISTINCT FROM p_offer_version_id
    OR p_snapshot #>> '{resolution,resolvedAt}' IS DISTINCT FROM p_snapshot->>'quotedAt'
    OR jsonb_typeof(p_snapshot->'totals') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_snapshot->'renewal') IS DISTINCT FROM 'object'
  THEN
    RETURN false;
  END IF;

  IF jsonb_array_length(p_snapshot->'saasLines') = 0 THEN
    IF jsonb_array_length(p_snapshot->'entitlementGrants') <> 0 THEN RETURN false; END IF;
  ELSIF jsonb_array_length(p_snapshot->'entitlementGrants') = 0 THEN
    RETURN false;
  END IF;

  FOR line, line_index IN
    SELECT element, ordinality::INTEGER
      FROM jsonb_array_elements(p_snapshot->'saasLines') WITH ORDINALITY AS elements(element, ordinality)
      ORDER BY ordinality
  LOOP
    IF jsonb_typeof(line) IS DISTINCT FROM 'object'
      OR jsonb_typeof(line->'quantity') IS DISTINCT FROM 'number'
      OR (line->>'quantity')::NUMERIC <> trunc((line->>'quantity')::NUMERIC)
      OR (line->>'quantity')::NUMERIC NOT BETWEEN 1 AND 1000
      OR jsonb_typeof(line->'taxRateBasisPoints') IS DISTINCT FROM 'number'
      OR (line->>'taxRateBasisPoints')::NUMERIC <> trunc((line->>'taxRateBasisPoints')::NUMERIC)
      OR (line->>'taxRateBasisPoints')::NUMERIC NOT IN (0, 1600)
      OR line->>'currency' IS DISTINCT FROM 'MXN'
      OR jsonb_typeof(line->'appliedOfferSteps') IS DISTINCT FROM 'array'
      OR jsonb_array_length(line->'appliedOfferSteps') > 10
    THEN
      RETURN false;
    END IF;

    line_key := line->>'lineKey';
    IF line_key IS NULL OR length(line_key) NOT BETWEEN 1 AND 128 OR line_key = ANY(seen_line_keys) THEN RETURN false; END IF;
    seen_line_keys := array_append(seen_line_keys, line_key);
    quantity_value := (line->>'quantity')::NUMERIC;
    tax_rate := (line->>'taxRateBasisPoints')::NUMERIC;
    values_numeric := ARRAY[]::NUMERIC[];
    FOR money_index IN 1..9 LOOP
      IF jsonb_typeof(line->saas_money_names[money_index]) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      money_text := line->>saas_money_names[money_index];
      IF money_text !~ minor_pattern THEN RETURN false; END IF;
      values_numeric := array_append(values_numeric, money_text::NUMERIC);
      IF values_numeric[money_index] > max_int8 THEN RETURN false; END IF;
    END LOOP;
    unit_amount := values_numeric[1];
    line_list := values_numeric[2];
    line_discount := values_numeric[3];
    line_subtotal := values_numeric[4];
    line_tax := values_numeric[5];
    line_total := values_numeric[6];
    line_renewal_subtotal := values_numeric[7];
    line_renewal_tax := values_numeric[8];
    line_renewal_total := values_numeric[9];

    previous_step_output := NULL;
    shared_cycles := NULL;
    IF jsonb_array_length(line->'appliedOfferSteps') = 0 THEN
      IF line_discount <> 0
        OR line_subtotal <> line_list
        OR jsonb_typeof(line->'promotionalCycles') IS DISTINCT FROM 'null'
      THEN
        RETURN false;
      END IF;
    ELSE
      FOR step, step_index IN
        SELECT element, ordinality::INTEGER
          FROM jsonb_array_elements(line->'appliedOfferSteps') WITH ORDINALITY AS elements(element, ordinality)
          ORDER BY ordinality
      LOOP
        IF jsonb_typeof(step) IS DISTINCT FROM 'object'
          OR jsonb_typeof(step->'position') IS DISTINCT FROM 'number'
          OR (step->>'position')::NUMERIC <> step_index
          OR jsonb_typeof(step->'cycles') IS DISTINCT FROM 'number'
          OR (step->>'cycles')::NUMERIC <> trunc((step->>'cycles')::NUMERIC)
          OR (step->>'cycles')::NUMERIC NOT BETWEEN 1 AND 120
          OR jsonb_typeof(step->'inputAmountMinor') IS DISTINCT FROM 'string'
          OR jsonb_typeof(step->'discountAmountMinor') IS DISTINCT FROM 'string'
          OR jsonb_typeof(step->'outputAmountMinor') IS DISTINCT FROM 'string'
          OR step->>'inputAmountMinor' !~ minor_pattern
          OR step->>'discountAmountMinor' !~ minor_pattern
          OR step->>'outputAmountMinor' !~ minor_pattern
        THEN
          RETURN false;
        END IF;
        step_input := (step->>'inputAmountMinor')::NUMERIC;
        step_discount := (step->>'discountAmountMinor')::NUMERIC;
        step_output := (step->>'outputAmountMinor')::NUMERIC;
        IF greatest(step_input, step_discount, step_output) > max_int8
          OR (step_index = 1 AND step_input <> line_list)
          OR (step_index > 1 AND step_input <> previous_step_output)
          OR step_input - step_discount <> step_output
        THEN
          RETURN false;
        END IF;
        step_cycles := (step->>'cycles')::INTEGER;
        IF shared_cycles IS NULL THEN shared_cycles := step_cycles;
        ELSIF shared_cycles <> step_cycles THEN RETURN false;
        END IF;
        previous_step_output := step_output;
      END LOOP;
      IF previous_step_output <> line_subtotal
        OR jsonb_typeof(line->'promotionalCycles') IS DISTINCT FROM 'number'
        OR (line->>'promotionalCycles')::NUMERIC <> shared_cycles
      THEN
        RETURN false;
      END IF;
    END IF;

    IF unit_amount * quantity_value > max_int8
      OR unit_amount * quantity_value <> line_list
      OR line_list - line_discount <> line_subtotal
      OR div(line_subtotal * tax_rate + 5000, 10000) <> line_tax
      OR line_subtotal + line_tax <> line_total
      OR line_renewal_subtotal <> line_list
      OR div(line_renewal_subtotal * tax_rate + 5000, 10000) <> line_renewal_tax
      OR line_renewal_subtotal + line_renewal_tax <> line_renewal_total
    THEN
      RETURN false;
    END IF;

    recurring_sums := ARRAY[
      recurring_sums[1] + line_list,
      recurring_sums[2] + line_discount,
      recurring_sums[3] + line_subtotal,
      recurring_sums[4] + line_tax,
      recurring_sums[5] + line_total
    ];
    renewal_sums := ARRAY[
      renewal_sums[1] + line_renewal_subtotal,
      renewal_sums[2],
      renewal_sums[3] + line_renewal_subtotal,
      renewal_sums[4] + line_renewal_tax,
      renewal_sums[5] + line_renewal_total
    ];
  END LOOP;

  FOR line, line_index IN
    SELECT element, ordinality::INTEGER
      FROM jsonb_array_elements(p_snapshot->'hardwareLines') WITH ORDINALITY AS elements(element, ordinality)
      ORDER BY ordinality
  LOOP
    IF jsonb_typeof(line) IS DISTINCT FROM 'object'
      OR jsonb_typeof(line->'skuSnapshot') IS DISTINCT FROM 'object'
      OR jsonb_typeof(line->'catalogKey') IS DISTINCT FROM 'string'
      OR jsonb_typeof(line #> '{skuSnapshot,catalogKey}') IS DISTINCT FROM 'string'
      OR line->>'catalogKey' IS DISTINCT FROM line #>> '{skuSnapshot,catalogKey}'
      OR line->>'currency' IS DISTINCT FROM 'MXN'
      OR line #>> '{skuSnapshot,currency}' IS DISTINCT FROM 'MXN'
      OR jsonb_typeof(line->'quantity') IS DISTINCT FROM 'number'
      OR (line->>'quantity')::NUMERIC <> trunc((line->>'quantity')::NUMERIC)
      OR (line->>'quantity')::NUMERIC NOT BETWEEN 1 AND 1000
      OR jsonb_typeof(line->'benefitedQuantity') IS DISTINCT FROM 'number'
      OR (line->>'benefitedQuantity')::NUMERIC <> trunc((line->>'benefitedQuantity')::NUMERIC)
      OR (line->>'benefitedQuantity')::NUMERIC NOT BETWEEN 0 AND 1000
      OR jsonb_typeof(line->'listPriceQuantity') IS DISTINCT FROM 'number'
      OR (line->>'listPriceQuantity')::NUMERIC <> trunc((line->>'listPriceQuantity')::NUMERIC)
      OR (line->>'listPriceQuantity')::NUMERIC NOT BETWEEN 0 AND 1000
      OR jsonb_typeof(line->'taxRateBasisPoints') IS DISTINCT FROM 'number'
      OR (line->>'taxRateBasisPoints')::NUMERIC <> 1600
      OR jsonb_typeof(line #> '{skuSnapshot,taxRateBasisPoints}') IS DISTINCT FROM 'number'
      OR (line #>> '{skuSnapshot,taxRateBasisPoints}')::NUMERIC <> 1600
      OR jsonb_typeof(line #> '{skuSnapshot,listUnitAmountMinor}') IS DISTINCT FROM 'string'
      OR line #>> '{skuSnapshot,listUnitAmountMinor}' !~ minor_pattern
    THEN
      RETURN false;
    END IF;

    line_key := line->>'lineKey';
    IF line_key IS NULL OR length(line_key) NOT BETWEEN 1 AND 128 OR line_key = ANY(seen_line_keys) THEN RETURN false; END IF;
    seen_line_keys := array_append(seen_line_keys, line_key);
    quantity_value := (line->>'quantity')::NUMERIC;
    benefited_quantity := (line->>'benefitedQuantity')::NUMERIC;
    list_price_quantity := (line->>'listPriceQuantity')::NUMERIC;
    IF benefited_quantity + list_price_quantity <> quantity_value THEN RETURN false; END IF;

    unit_amount := (line #>> '{skuSnapshot,listUnitAmountMinor}')::NUMERIC;
    IF unit_amount > max_int8 THEN RETURN false; END IF;
    values_numeric := ARRAY[]::NUMERIC[];
    FOR money_index IN 1..5 LOOP
      IF jsonb_typeof(line->hardware_money_names[money_index]) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      money_text := line->>hardware_money_names[money_index];
      IF money_text !~ minor_pattern THEN RETURN false; END IF;
      values_numeric := array_append(values_numeric, money_text::NUMERIC);
      IF values_numeric[money_index] > max_int8 THEN RETURN false; END IF;
    END LOOP;
    line_list := values_numeric[1];
    line_discount := values_numeric[2];
    line_subtotal := values_numeric[3];
    line_tax := values_numeric[4];
    line_total := values_numeric[5];
    benefit := line->'appliedBenefit';

    IF unit_amount * quantity_value > max_int8 OR unit_amount * quantity_value <> line_list THEN RETURN false; END IF;
    IF jsonb_typeof(benefit) = 'null' THEN
      IF benefited_quantity <> 0 OR list_price_quantity <> quantity_value OR line_subtotal <> line_list THEN RETURN false; END IF;
    ELSIF jsonb_typeof(benefit) IS DISTINCT FROM 'object'
      OR (benefit->>'appliedQuantity')::NUMERIC IS DISTINCT FROM benefited_quantity
    THEN
      RETURN false;
    ELSIF benefit->>'kind' = 'HARDWARE_PERCENT_OFF' THEN
      IF jsonb_typeof(benefit->'percentBasisPoints') IS DISTINCT FROM 'number'
        OR (benefit->>'percentBasisPoints')::NUMERIC NOT BETWEEN 1 AND 10000
      THEN
        RETURN false;
      END IF;
      benefit_basis_points := (benefit->>'percentBasisPoints')::NUMERIC;
      IF line_subtotal <> line_list - div(unit_amount * benefited_quantity * benefit_basis_points + 5000, 10000) THEN
        RETURN false;
      END IF;
    ELSIF benefit->>'kind' = 'HARDWARE_FIXED_PRICE' THEN
      IF jsonb_typeof(benefit->'unitAmountMinor') IS DISTINCT FROM 'string'
        OR benefit->>'unitAmountMinor' !~ minor_pattern
      THEN
        RETURN false;
      END IF;
      benefit_amount := (benefit->>'unitAmountMinor')::NUMERIC;
      IF benefit_amount > max_int8
        OR benefit_amount * benefited_quantity + unit_amount * list_price_quantity > max_int8
        OR line_subtotal <> benefit_amount * benefited_quantity + unit_amount * list_price_quantity
      THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;

    IF line_list - line_discount <> line_subtotal
      OR div(line_subtotal * 1600 + 5000, 10000) <> line_tax
      OR line_subtotal + line_tax <> line_total
    THEN
      RETURN false;
    END IF;
    one_time_sums := ARRAY[
      one_time_sums[1] + line_list,
      one_time_sums[2] + line_discount,
      one_time_sums[3] + line_subtotal,
      one_time_sums[4] + line_tax,
      one_time_sums[5] + line_total
    ];
  END LOOP;

  due_now_sums := ARRAY[
    recurring_sums[1] + one_time_sums[1],
    recurring_sums[2] + one_time_sums[2],
    recurring_sums[3] + one_time_sums[3],
    recurring_sums[4] + one_time_sums[4],
    recurring_sums[5] + one_time_sums[5]
  ];
  IF greatest(
    recurring_sums[1], recurring_sums[2], recurring_sums[3], recurring_sums[4], recurring_sums[5],
    one_time_sums[1], one_time_sums[2], one_time_sums[3], one_time_sums[4], one_time_sums[5],
    due_now_sums[1], due_now_sums[2], due_now_sums[3], due_now_sums[4], due_now_sums[5],
    renewal_sums[1], renewal_sums[2], renewal_sums[3], renewal_sums[4], renewal_sums[5]
  ) > max_int8 THEN
    RETURN false;
  END IF;

  FOR root, root_index IN
    SELECT element, ordinality::INTEGER FROM jsonb_array_elements(
      jsonb_build_array(
        p_snapshot #> '{totals,recurringCurrent}',
        p_snapshot #> '{totals,oneTime}',
        p_snapshot #> '{totals,dueNow}',
        p_snapshot->'renewal'
      )
    ) WITH ORDINALITY AS roots(element, ordinality)
    ORDER BY ordinality
  LOOP
    IF jsonb_typeof(root) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    root_values := ARRAY[]::NUMERIC[];
    FOR money_index IN 1..5 LOOP
      IF jsonb_typeof(root->breakdown_names[money_index]) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      money_text := root->>breakdown_names[money_index];
      IF money_text !~ minor_pattern THEN RETURN false; END IF;
      root_values := array_append(root_values, money_text::NUMERIC);
      IF root_values[money_index] > max_int8 THEN RETURN false; END IF;
    END LOOP;
    IF root_values[1] - root_values[2] <> root_values[3]
      OR root_values[3] + root_values[4] <> root_values[5]
    THEN
      RETURN false;
    END IF;
    expected_values := CASE root_index
      WHEN 1 THEN recurring_sums
      WHEN 2 THEN one_time_sums
      WHEN 3 THEN due_now_sums
      WHEN 4 THEN renewal_sums
    END;
    IF root_values <> expected_values THEN RETURN false; END IF;
  END LOOP;

  RETURN due_now_sums = ARRAY[
      p_list_subtotal::NUMERIC,
      p_discount::NUMERIC,
      p_subtotal::NUMERIC,
      p_tax::NUMERIC,
      p_total::NUMERIC
    ]
    AND renewal_sums = ARRAY[
      p_renewal_subtotal::NUMERIC,
      0::NUMERIC,
      p_renewal_subtotal::NUMERIC,
      p_renewal_tax::NUMERIC,
      p_renewal_total::NUMERIC
    ];
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

ALTER TABLE "CommercialQuote"
  ADD CONSTRAINT "CommercialQuote_offer_pair_check_v3_pending"
    CHECK (("offerVersionId" IS NULL) = ("offerSchemaVersion" IS NULL)) NOT VALID,
  ADD CONSTRAINT "CommercialQuote_authority_shape_v3_pending"
    CHECK ((
      "schemaVersion" IN (1, 2)
      AND "offerVersionId" IS NULL
      AND "offerSchemaVersion" IS NULL
    ) OR (
      "schemaVersion" = 3
      AND "campaignVersionId" IS NULL
      AND "offerVersionId" IS NOT NULL
      AND "offerSchemaVersion" = 3
      AND "acquisitionContextId" IS NULL
      AND "organizationId" IS NOT NULL
      AND "venueId" IS NOT NULL
      AND "createdById" IS NOT NULL
    )) NOT VALID,
  ADD CONSTRAINT "CommercialQuote_schema_version_v3_pending"
    CHECK ("schemaVersion" IN (1, 2, 3)) NOT VALID,
  ADD CONSTRAINT "CommercialQuote_snapshot_schema_version_v3_pending"
    CHECK ((CASE
      WHEN jsonb_typeof("snapshot"->'schemaVersion') = 'number'
        AND ("snapshot"->>'schemaVersion')::NUMERIC = trunc(("snapshot"->>'schemaVersion')::NUMERIC)
        AND ("snapshot"->>'schemaVersion')::NUMERIC BETWEEN 1 AND 3
      THEN ("snapshot"->>'schemaVersion')::NUMERIC = "schemaVersion"
      ELSE false
    END) IS TRUE) NOT VALID,
  ADD CONSTRAINT "CommercialQuote_legacy_totals_v3_pending"
    CHECK (("schemaVersion" = 3) OR (
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
    )) NOT VALID,
  ADD CONSTRAINT "CommercialQuote_snapshot_totals_v3_pending"
    CHECK ((CASE
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
      WHEN "schemaVersion" = 3 THEN true
      ELSE false
    END) IS TRUE) NOT VALID,
  ADD CONSTRAINT "CommercialQuote_v3_totals_pending"
    CHECK (("schemaVersion" <> 3) OR public.commercial_quote_snapshot_matches_v3_row(
      "snapshot", "id", "catalogPublicationId", "offerVersionId", "offerSchemaVersion", "acquisitionContextId",
      "organizationId", "venueId", "createdById", "market", "currency", "quotedAt", "expiresAt",
      "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
      "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor"
    )) NOT VALID,
  ADD CONSTRAINT "CommercialQuote_snapshot_size_v3_pending"
    CHECK (("schemaVersion" <> 3) OR octet_length("snapshot"::text) <= 4194304) NOT VALID,
  ADD CONSTRAINT "CommercialQuote_offerVersionId_offerSchemaVersion_fkey"
    FOREIGN KEY ("offerVersionId", "offerSchemaVersion")
    REFERENCES "CommercialCampaignVersion"("id", "schemaVersion")
    MATCH SIMPLE ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

CREATE FUNCTION public.enforce_commercial_quote_v3_sources() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  offer_row RECORD;
  catalog_row RECORD;
  venue_organization_id TEXT;
BEGIN
  IF NEW."schemaVersion" <> 3 THEN
    RETURN NEW;
  END IF;

  SELECT "id", "campaignCode", "schemaVersion", "checksum"
    INTO offer_row
    FROM "CommercialCampaignVersion"
    WHERE "id" = NEW."offerVersionId" AND "schemaVersion" = NEW."offerSchemaVersion"
    FOR KEY SHARE;

  IF NOT FOUND
    OR offer_row."schemaVersion" <> 3
    OR NEW."snapshot"->>'offerVersionId' IS DISTINCT FROM offer_row."id"
    OR NEW."snapshot"->>'offerCode' IS DISTINCT FROM offer_row."campaignCode"
    OR NEW."snapshot"->>'offerChecksum' IS DISTINCT FROM offer_row."checksum"
  THEN
    RAISE EXCEPTION 'Commercial Quote v3 Offer source mismatch' USING ERRCODE = '23514';
  END IF;

  SELECT "id", "schemaVersion", "checksum"
    INTO catalog_row
    FROM "CommercialPublication"
    WHERE "id" = NEW."catalogPublicationId"
    FOR KEY SHARE;

  IF NOT FOUND
    OR catalog_row."schemaVersion" <> 2
    OR NEW."snapshot"->>'catalogPublicationId' IS DISTINCT FROM catalog_row."id"
    OR NEW."snapshot"->>'catalogChecksum' IS DISTINCT FROM catalog_row."checksum"
  THEN
    RAISE EXCEPTION 'Commercial Quote v3 Catalog source mismatch' USING ERRCODE = '23514';
  END IF;

  SELECT "organizationId"
    INTO venue_organization_id
    FROM "Venue"
    WHERE "id" = NEW."venueId"
    FOR KEY SHARE;

  IF NOT FOUND OR venue_organization_id IS DISTINCT FROM NEW."organizationId" THEN
    RAISE EXCEPTION 'Commercial Quote v3 tenant lineage mismatch' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER commercial_quote_v3_sources
BEFORE INSERT OR UPDATE OF
  "schemaVersion", "catalogPublicationId", "offerVersionId", "offerSchemaVersion",
  "organizationId", "venueId", "snapshot"
ON "CommercialQuote"
FOR EACH ROW EXECUTE FUNCTION public.enforce_commercial_quote_v3_sources();
ALTER TABLE "CommercialQuote" ENABLE ALWAYS TRIGGER commercial_quote_v3_sources;

ALTER TABLE "CommercialQuote" ENABLE ALWAYS TRIGGER commercial_quote_immutable;

CREATE TRIGGER commercial_offer_control_event_immutable
BEFORE UPDATE OR DELETE ON "CommercialOfferControlEvent"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_immutable_mutation();
ALTER TABLE "CommercialOfferControlEvent" ENABLE ALWAYS TRIGGER commercial_offer_control_event_immutable;

CREATE TRIGGER commercial_offer_control_event_truncate_immutable
BEFORE TRUNCATE ON "CommercialOfferControlEvent"
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_immutable_mutation();
ALTER TABLE "CommercialOfferControlEvent" ENABLE ALWAYS TRIGGER commercial_offer_control_event_truncate_immutable;

COMMIT;
