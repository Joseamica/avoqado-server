BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE UNIQUE INDEX "CommercialPublication_id_schemaVersion_key"
  ON "CommercialPublication"("id", "schemaVersion");

CREATE TYPE "CommercialAcquisitionBindingPurpose" AS ENUM ('NEW_ACCOUNT');

ALTER TABLE "Staff"
  ADD COLUMN "commercialCreatedAt" TIMESTAMP(3);

ALTER TABLE "Staff"
  ALTER COLUMN "commercialCreatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CommercialCampaignClaim"
  ALTER COLUMN "campaignVersionId" DROP NOT NULL,
  ALTER COLUMN "campaignCode" DROP NOT NULL,
  ADD COLUMN "offerVersionId" TEXT,
  ADD COLUMN "offerSchemaVersion" INTEGER;

CREATE INDEX "CommercialCampaignClaim_offerVersionId_expiresAt_idx"
  ON "CommercialCampaignClaim"("offerVersionId", "expiresAt");

ALTER TABLE "CommercialCampaignClaim"
  ADD CONSTRAINT "CommercialCampaignClaim_authority_shape_v3_pending"
  CHECK (
    (
      "campaignVersionId" IS NOT NULL
      AND "campaignCode" IS NOT NULL
      AND "offerVersionId" IS NULL
      AND "offerSchemaVersion" IS NULL
    )
    OR
    (
      "campaignVersionId" IS NULL
      AND "campaignCode" IS NULL
      AND "offerVersionId" IS NOT NULL
      AND "offerSchemaVersion" = 3
    )
  ) NOT VALID,
  ADD CONSTRAINT "CommercialCampaignClaim_offerVersionId_offerSchemaVersion_fkey"
  FOREIGN KEY ("offerVersionId", "offerSchemaVersion")
  REFERENCES "CommercialCampaignVersion"("id", "schemaVersion")
  MATCH SIMPLE ON DELETE RESTRICT ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "CommercialAcquisitionContext"
  ADD COLUMN "offerVersionId" TEXT,
  ADD COLUMN "offerSchemaVersion" INTEGER,
  ADD COLUMN "reservedCatalogPublicationId" TEXT,
  ADD COLUMN "reservedCatalogSchemaVersion" INTEGER;

CREATE INDEX "CommercialAcquisitionContext_offerVersionId_idx"
  ON "CommercialAcquisitionContext"("offerVersionId");
CREATE INDEX "CommercialAcquisitionContext_reservedCatalogPublicationId_idx"
  ON "CommercialAcquisitionContext"("reservedCatalogPublicationId");

ALTER TABLE "CommercialAcquisitionContext"
  ADD CONSTRAINT "CommercialAcquisitionContext_authority_shape_v3_pending"
  CHECK (
    (
      "offerVersionId" IS NULL
      AND "offerSchemaVersion" IS NULL
      AND "reservedCatalogPublicationId" IS NULL
      AND "reservedCatalogSchemaVersion" IS NULL
    )
    OR
    (
      "campaignVersionId" IS NULL
      AND "offerVersionId" IS NOT NULL
      AND "offerSchemaVersion" = 3
      AND "reservedCatalogPublicationId" IS NOT NULL
      AND "reservedCatalogSchemaVersion" = 2
    )
  ) NOT VALID,
  ADD CONSTRAINT "CommercialAcqContext_offerVersion_schemaVersion_fkey"
  FOREIGN KEY ("offerVersionId", "offerSchemaVersion")
  REFERENCES "CommercialCampaignVersion"("id", "schemaVersion")
  MATCH SIMPLE ON DELETE RESTRICT ON UPDATE CASCADE
  NOT VALID,
  ADD CONSTRAINT "CommercialAcqContext_reservedCatalog_schemaVersion_fkey"
  FOREIGN KEY ("reservedCatalogPublicationId", "reservedCatalogSchemaVersion")
  REFERENCES "CommercialPublication"("id", "schemaVersion")
  MATCH SIMPLE ON DELETE RESTRICT ON UPDATE CASCADE
  NOT VALID;

CREATE TABLE "CommercialAcquisitionContextBinding" (
  "id" TEXT NOT NULL,
  "acquisitionContextId" TEXT NOT NULL,
  "staffId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "purpose" "CommercialAcquisitionBindingPurpose" NOT NULL DEFAULT 'NEW_ACCOUNT',
  "staffCreatedAt" TIMESTAMP(3) NOT NULL,
  "organizationCreatedAt" TIMESTAMP(3) NOT NULL,
  "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialAcquisitionContextBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialAcquisitionContextBinding_acquisitionContextId_fkey"
    FOREIGN KEY ("acquisitionContextId") REFERENCES "CommercialAcquisitionContext"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CommercialAcquisitionContextBinding_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "Staff"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialAcquisitionContextBinding_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CommercialAcquisitionContextBinding_acquisitionContextId_key"
  ON "CommercialAcquisitionContextBinding"("acquisitionContextId");
CREATE UNIQUE INDEX "CommercialAcquisitionContextBinding_staffId_purpose_key"
  ON "CommercialAcquisitionContextBinding"("staffId", "purpose");
CREATE UNIQUE INDEX "CommercialAcquisitionContextBinding_organizationId_purpose_key"
  ON "CommercialAcquisitionContextBinding"("organizationId", "purpose");
CREATE INDEX "CommercialAcquisitionContextBinding_boundAt_idx"
  ON "CommercialAcquisitionContextBinding"("boundAt");

CREATE TABLE "CommercialAcquisitionRedemption" (
  "id" TEXT NOT NULL,
  "acquisitionContextId" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "acceptanceId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "staffId" TEXT NOT NULL,
  "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialAcquisitionRedemption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialAcquisitionRedemption_acquisitionContextId_fkey"
    FOREIGN KEY ("acquisitionContextId") REFERENCES "CommercialAcquisitionContext"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialAcquisitionRedemption_quoteId_fkey"
    FOREIGN KEY ("quoteId") REFERENCES "CommercialQuote"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialAcquisitionRedemption_acceptanceId_fkey"
    FOREIGN KEY ("acceptanceId") REFERENCES "CommercialQuoteAcceptance"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialAcquisitionRedemption_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialAcquisitionRedemption_venueId_organizationId_fkey"
    FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialAcquisitionRedemption_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "Staff"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CommercialAcquisitionRedemption_acquisitionContextId_key"
  ON "CommercialAcquisitionRedemption"("acquisitionContextId");
CREATE UNIQUE INDEX "CommercialAcquisitionRedemption_quoteId_key"
  ON "CommercialAcquisitionRedemption"("quoteId");
CREATE UNIQUE INDEX "CommercialAcquisitionRedemption_acceptanceId_key"
  ON "CommercialAcquisitionRedemption"("acceptanceId");
CREATE INDEX "CommercialAcqRedemption_org_venue_redeemed_idx"
  ON "CommercialAcquisitionRedemption"("organizationId", "venueId", "redeemedAt");
CREATE INDEX "CommercialAcquisitionRedemption_staffId_redeemedAt_idx"
  ON "CommercialAcquisitionRedemption"("staffId", "redeemedAt");

CREATE FUNCTION reject_commercial_acquisition_context_binding_unsafe_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_context_exists BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'CommercialAcquisitionContextBinding is immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "CommercialAcquisitionContext" AS context
    WHERE context."id" = OLD."acquisitionContextId"
  ) INTO parent_context_exists;

  IF parent_context_exists AND EXISTS (
    SELECT 1
    FROM "CommercialAcquisitionContext" AS context
    WHERE context."id" = OLD."acquisitionContextId"
      AND context."expiresAt" >
        (pg_catalog.now() AT TIME ZONE 'UTC') - interval '20 minutes'
  ) THEN
    RAISE EXCEPTION 'CommercialAcquisitionContextBinding is immutable until parent expiry'
      USING ERRCODE = '55000';
  END IF;

  RETURN OLD;
END;
$$;

CREATE FUNCTION reject_commercial_acquisition_context_binding_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CommercialAcquisitionContextBinding cannot be truncated'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER commercial_acquisition_context_binding_immutable
BEFORE UPDATE OR DELETE ON "CommercialAcquisitionContextBinding"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_acquisition_context_binding_unsafe_mutation();

CREATE TRIGGER commercial_acquisition_context_binding_truncate_immutable
BEFORE TRUNCATE ON "CommercialAcquisitionContextBinding"
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_acquisition_context_binding_truncate();

ALTER TABLE "CommercialAcquisitionContextBinding"
  ENABLE ALWAYS TRIGGER commercial_acquisition_context_binding_immutable;
ALTER TABLE "CommercialAcquisitionContextBinding"
  ENABLE ALWAYS TRIGGER commercial_acquisition_context_binding_truncate_immutable;

CREATE FUNCTION reject_commercial_acquisition_redemption_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CommercialAcquisitionRedemption is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER commercial_acquisition_redemption_immutable
BEFORE UPDATE OR DELETE ON "CommercialAcquisitionRedemption"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_acquisition_redemption_mutation();

CREATE TRIGGER commercial_acquisition_redemption_truncate_immutable
BEFORE TRUNCATE ON "CommercialAcquisitionRedemption"
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_acquisition_redemption_mutation();

ALTER TABLE "CommercialAcquisitionRedemption"
  ENABLE ALWAYS TRIGGER commercial_acquisition_redemption_immutable;
ALTER TABLE "CommercialAcquisitionRedemption"
  ENABLE ALWAYS TRIGGER commercial_acquisition_redemption_truncate_immutable;

CREATE TRIGGER commercial_quote_preview_bridge_immutable
BEFORE UPDATE OR DELETE ON "CommercialQuotePreviewBridge"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_immutable_mutation();

CREATE TRIGGER commercial_quote_preview_bridge_truncate_immutable
BEFORE TRUNCATE ON "CommercialQuotePreviewBridge"
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_immutable_mutation();

ALTER TABLE "CommercialQuotePreviewBridge"
  ENABLE ALWAYS TRIGGER commercial_quote_preview_bridge_immutable;
ALTER TABLE "CommercialQuotePreviewBridge"
  ENABLE ALWAYS TRIGGER commercial_quote_preview_bridge_truncate_immutable;

-- Q3-A deliberately accepted direct Venue quotes only. Q3-B keeps that
-- validator immutable and wraps it with the exact additional preview lineage.
CREATE FUNCTION public.commercial_quote_snapshot_matches_v3_row_q3b(
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
  sanitized_snapshot JSONB;
  derived_key_count INTEGER;
BEGIN
  IF p_acquisition_context_id IS NULL THEN
    RETURN public.commercial_quote_snapshot_matches_v3_row(
      p_snapshot, p_quote_id, p_catalog_publication_id, p_offer_version_id,
      p_offer_schema_version, NULL, p_organization_id, p_venue_id, p_created_by_id,
      p_market, p_currency, p_quoted_at, p_expires_at, p_list_subtotal, p_discount,
      p_subtotal, p_tax, p_total, p_renewal_subtotal, p_renewal_tax, p_renewal_total
    );
  END IF;

  IF p_snapshot->>'acquisitionContextId' IS DISTINCT FROM p_acquisition_context_id
    OR jsonb_typeof(p_snapshot->'derivedFromPreview') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_snapshot #> '{derivedFromPreview,previewQuoteId}') IS DISTINCT FROM 'string'
    OR length(p_snapshot #>> '{derivedFromPreview,previewQuoteId}') NOT BETWEEN 1 AND 128
    OR p_snapshot #>> '{derivedFromPreview,previewChecksum}' !~ '^[0-9a-f]{64}$'
    OR p_snapshot #>> '{derivedFromPreview,selectionFingerprint}' !~ '^[0-9a-f]{64}$'
  THEN
    RETURN false;
  END IF;

  SELECT count(*)::INTEGER
    INTO derived_key_count
    FROM jsonb_object_keys(p_snapshot->'derivedFromPreview');
  IF derived_key_count <> 3 THEN
    RETURN false;
  END IF;

  sanitized_snapshot := jsonb_set(
    jsonb_set(
      jsonb_set(p_snapshot, '{acquisitionContextId}', 'null'::jsonb, false),
      '{derivedFromPreview}', 'null'::jsonb, false
    ),
    '{resolution,resolvedAt}', to_jsonb(p_snapshot->>'quotedAt'), false
  );

  RETURN public.commercial_quote_snapshot_matches_v3_row(
    sanitized_snapshot, p_quote_id, p_catalog_publication_id, p_offer_version_id,
    p_offer_schema_version, NULL, p_organization_id, p_venue_id, p_created_by_id,
    p_market, p_currency, p_quoted_at, p_expires_at, p_list_subtotal, p_discount,
    p_subtotal, p_tax, p_total, p_renewal_subtotal, p_renewal_tax, p_renewal_total
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

ALTER TABLE "CommercialQuote"
  ADD CONSTRAINT "CommercialQuote_authority_shape_q3b_pending"
    CHECK ((
      "schemaVersion" IN (1, 2)
      AND "offerVersionId" IS NULL
      AND "offerSchemaVersion" IS NULL
    ) OR (
      "schemaVersion" = 3
      AND "campaignVersionId" IS NULL
      AND "offerVersionId" IS NOT NULL
      AND "offerSchemaVersion" = 3
      AND "organizationId" IS NOT NULL
      AND "venueId" IS NOT NULL
      AND "createdById" IS NOT NULL
    )) NOT VALID,
  ADD CONSTRAINT "CommercialQuote_v3_totals_q3b_pending"
    CHECK (("schemaVersion" <> 3) OR public.commercial_quote_snapshot_matches_v3_row_q3b(
      "snapshot", "id", "catalogPublicationId", "offerVersionId", "offerSchemaVersion", "acquisitionContextId",
      "organizationId", "venueId", "createdById", "market", "currency", "quotedAt", "expiresAt",
      "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
      "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor"
    )) NOT VALID;

-- Preserve the trigger name and replace only its function body. Direct Quote
-- checks remain byte-for-byte equivalent; bridged rows additionally pin the
-- dedicated context, Offer, Catalog and resolved-at timestamp.
CREATE OR REPLACE FUNCTION public.enforce_commercial_quote_v3_sources() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  offer_row RECORD;
  catalog_row RECORD;
  context_row RECORD;
  context_created_at TEXT;
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

  IF NEW."acquisitionContextId" IS NOT NULL THEN
    SELECT "id", "campaignVersionId", "offerVersionId", "offerSchemaVersion",
           "reservedCatalogPublicationId", "reservedCatalogSchemaVersion", "createdAt"
      INTO context_row
      FROM "CommercialAcquisitionContext"
      WHERE "id" = NEW."acquisitionContextId"
      FOR KEY SHARE;

    context_created_at := to_char(context_row."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

    IF NOT FOUND
      OR context_row."campaignVersionId" IS NOT NULL
      OR context_row."offerVersionId" IS DISTINCT FROM NEW."offerVersionId"
      OR context_row."offerSchemaVersion" IS DISTINCT FROM 3
      OR context_row."reservedCatalogPublicationId" IS DISTINCT FROM NEW."catalogPublicationId"
      OR context_row."reservedCatalogSchemaVersion" IS DISTINCT FROM 2
      OR NEW."snapshot"->>'acquisitionContextId' IS DISTINCT FROM context_row."id"
      OR NEW."snapshot" #>> '{resolution,resolvedAt}' IS DISTINCT FROM context_created_at
    THEN
      RAISE EXCEPTION 'Commercial Quote v3 acquisition source mismatch' USING ERRCODE = '23514';
    END IF;
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

COMMIT;
