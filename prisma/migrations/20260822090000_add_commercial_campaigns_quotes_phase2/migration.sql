-- Commercial Platform Phase 2 is expand-only. Campaign drafts are mutable,
-- while campaign versions and quotes are append-only financial evidence.

CREATE TYPE "CommercialCampaignRuleType" AS ENUM ('FIXED_PRICE', 'PERCENT_OFF', 'AMOUNT_OFF', 'FREE_PERIOD', 'BUNDLE_PRICE');
CREATE TYPE "CommercialAcquisitionChannel" AS ENUM ('PAID_META', 'PAID_GOOGLE', 'SELLER', 'DISTRIBUTOR', 'ORGANIC', 'PARTNER', 'DIRECT');
CREATE TYPE "CommercialQuoteAcceptanceStatus" AS ENUM ('ACCEPTED', 'STRIPE_PENDING', 'ACTIVE', 'FAILED', 'CANCELED', 'REFUNDED', 'DISPUTED');
CREATE TYPE "CommercialStripeOperationType" AS ENUM ('CHECKOUT_SESSION', 'SUBSCRIPTION_UPDATE');
CREATE TYPE "CommercialStripeOperationStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'OUTCOME_UNKNOWN', 'FAILED');
CREATE TYPE "CommercialSubscriptionEventType" AS ENUM ('CHECKOUT_COMPLETED', 'INVOICE_PAID', 'INVOICE_FAILED', 'SUBSCRIPTION_CANCELED', 'REFUND_SUCCEEDED', 'PARTIAL_REFUND', 'DISPUTE_OPENED', 'DISPUTE_WON', 'DISPUTE_LOST');

CREATE FUNCTION commercial_quote_snapshot_is_consistent(value JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  line JSONB;
  totals JSONB;
  renewal JSONB;
  line_list BIGINT;
  line_discount BIGINT;
  line_subtotal BIGINT;
  line_tax BIGINT;
  line_total BIGINT;
  line_renewal_subtotal BIGINT;
  line_renewal_tax BIGINT;
  line_renewal_total BIGINT;
  line_tax_rate INTEGER;
  sum_list BIGINT := 0;
  sum_discount BIGINT := 0;
  sum_subtotal BIGINT := 0;
  sum_tax BIGINT := 0;
  sum_total BIGINT := 0;
  sum_renewal_subtotal BIGINT := 0;
  sum_renewal_tax BIGINT := 0;
  sum_renewal_total BIGINT := 0;
BEGIN
  IF jsonb_typeof(value) <> 'object'
    OR jsonb_typeof(value->'lines') <> 'array'
    OR jsonb_array_length(value->'lines') = 0
    OR jsonb_typeof(value->'totals') <> 'object'
    OR jsonb_typeof(value->'renewal') <> 'object'
  THEN
    RETURN false;
  END IF;

  FOR line IN SELECT element FROM jsonb_array_elements(value->'lines') AS elements(element)
  LOOP
    IF jsonb_typeof(line) <> 'object'
      OR jsonb_typeof(line->'listSubtotalMinor') <> 'number'
      OR jsonb_typeof(line->'discountMinor') <> 'number'
      OR jsonb_typeof(line->'subtotalMinor') <> 'number'
      OR jsonb_typeof(line->'taxMinor') <> 'number'
      OR jsonb_typeof(line->'totalMinor') <> 'number'
      OR jsonb_typeof(line->'renewalSubtotalMinor') <> 'number'
      OR jsonb_typeof(line->'renewalTaxMinor') <> 'number'
      OR jsonb_typeof(line->'renewalTotalMinor') <> 'number'
      OR jsonb_typeof(line->'taxRateBasisPoints') <> 'number'
    THEN
      RETURN false;
    END IF;

    line_list := (line->>'listSubtotalMinor')::BIGINT;
    line_discount := (line->>'discountMinor')::BIGINT;
    line_subtotal := (line->>'subtotalMinor')::BIGINT;
    line_tax := (line->>'taxMinor')::BIGINT;
    line_total := (line->>'totalMinor')::BIGINT;
    line_renewal_subtotal := (line->>'renewalSubtotalMinor')::BIGINT;
    line_renewal_tax := (line->>'renewalTaxMinor')::BIGINT;
    line_renewal_total := (line->>'renewalTotalMinor')::BIGINT;
    line_tax_rate := (line->>'taxRateBasisPoints')::INTEGER;

    IF line_tax_rate NOT IN (0, 1600)
      OR line_list < 0 OR line_discount < 0 OR line_subtotal < 0 OR line_tax < 0 OR line_total < 0
      OR line_renewal_subtotal < 0 OR line_renewal_tax < 0 OR line_renewal_total < 0
      OR line_discount <> line_list - line_subtotal
      OR line_total <> line_subtotal + line_tax
      OR line_renewal_total <> line_renewal_subtotal + line_renewal_tax
      OR line_tax <> floor(((line_subtotal * line_tax_rate) + 5000)::NUMERIC / 10000)::BIGINT
      OR line_renewal_tax <> floor(((line_renewal_subtotal * line_tax_rate) + 5000)::NUMERIC / 10000)::BIGINT
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
  END LOOP;

  totals := value->'totals';
  renewal := value->'renewal';
  RETURN (
    jsonb_typeof(totals->'listSubtotalMinor') = 'number'
    AND jsonb_typeof(totals->'discountMinor') = 'number'
    AND jsonb_typeof(totals->'subtotalMinor') = 'number'
    AND jsonb_typeof(totals->'taxMinor') = 'number'
    AND jsonb_typeof(totals->'totalMinor') = 'number'
    AND jsonb_typeof(renewal->'subtotalMinor') = 'number'
    AND jsonb_typeof(renewal->'taxMinor') = 'number'
    AND jsonb_typeof(renewal->'totalMinor') = 'number'
    AND (totals->>'listSubtotalMinor')::BIGINT = sum_list
    AND (totals->>'discountMinor')::BIGINT = sum_discount
    AND (totals->>'subtotalMinor')::BIGINT = sum_subtotal
    AND (totals->>'taxMinor')::BIGINT = sum_tax
    AND (totals->>'totalMinor')::BIGINT = sum_total
    AND (renewal->>'subtotalMinor')::BIGINT = sum_renewal_subtotal
    AND (renewal->>'taxMinor')::BIGINT = sum_renewal_tax
    AND (renewal->>'totalMinor')::BIGINT = sum_renewal_total
  ) IS TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE TABLE "CommercialCampaignDraft" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "CommercialDraftStatus" NOT NULL DEFAULT 'ACTIVE',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "allowedRuleCodeGroups" JSONB NOT NULL,
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialCampaignDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialCampaignDraft_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT "CommercialCampaignDraft_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "CommercialCampaignDraft_window_check" CHECK ("startsAt" < "endsAt")
);

CREATE TABLE "CommercialCampaignRuleDraft" (
  "id" TEXT NOT NULL,
  "campaignDraftId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "type" "CommercialCampaignRuleType" NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "target" JSONB NOT NULL,
  "amountMinor" INTEGER,
  "percentBasisPoints" INTEGER,
  "cycles" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialCampaignRuleDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialCampaignRuleDraft_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT "CommercialCampaignRuleDraft_adjustment_check" CHECK (
    ("type" IN ('FIXED_PRICE', 'AMOUNT_OFF', 'BUNDLE_PRICE') AND "amountMinor" IS NOT NULL AND "amountMinor" >= 0 AND "percentBasisPoints" IS NULL)
    OR ("type" = 'PERCENT_OFF' AND "amountMinor" IS NULL AND "percentBasisPoints" BETWEEN 1 AND 10000)
    OR ("type" = 'FREE_PERIOD' AND "amountMinor" IS NULL AND "percentBasisPoints" IS NULL)
  ),
  CONSTRAINT "CommercialCampaignRuleDraft_cycles_check" CHECK ("cycles" BETWEEN 1 AND 120)
);

CREATE TABLE "CommercialCampaignVersion" (
  "id" TEXT NOT NULL,
  "campaignCode" TEXT NOT NULL,
  "sourceDraftId" TEXT NOT NULL,
  "sourceRevision" INTEGER NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "snapshot" JSONB NOT NULL,
  "checksum" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "publishedById" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercialCampaignVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialCampaignVersion_code_check" CHECK ("campaignCode" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT "CommercialCampaignVersion_source_revision_check" CHECK ("sourceRevision" >= 1),
  CONSTRAINT "CommercialCampaignVersion_schema_version_check" CHECK ("schemaVersion" = 1),
  CONSTRAINT "CommercialCampaignVersion_checksum_check" CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CommercialCampaignVersion_reason_check" CHECK (length(btrim("reason")) > 0)
);

CREATE TABLE "CommercialCampaignActivation" (
  "id" TEXT NOT NULL,
  "environment" "CommercialPublicationEnvironment" NOT NULL,
  "campaignCode" TEXT NOT NULL,
  "campaignVersionId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "reason" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialCampaignActivation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialCampaignActivation_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "CommercialCampaignActivation_reason_check" CHECK (length(btrim("reason")) > 0)
);

CREATE TABLE "CommercialCampaignClaim" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "campaignVersionId" TEXT NOT NULL,
  "campaignCode" TEXT NOT NULL,
  "channel" "CommercialAcquisitionChannel" NOT NULL,
  "sourceRef" TEXT NOT NULL,
  "issuedById" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialCampaignClaim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialCampaignClaim_token_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CommercialCampaignClaim_channel_check" CHECK ("channel" IN ('PAID_META', 'PAID_GOOGLE', 'SELLER', 'DISTRIBUTOR', 'PARTNER')),
  CONSTRAINT "CommercialCampaignClaim_source_ref_check" CHECK ("sourceRef" ~ '^[A-Za-z0-9._:@/+\-=]{1,255}$'),
  CONSTRAINT "CommercialCampaignClaim_reason_check" CHECK (length(btrim("reason")) BETWEEN 3 AND 500),
  CONSTRAINT "CommercialCampaignClaim_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE TABLE "CommercialAcquisitionContext" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "campaignVersionId" TEXT,
  "channel" "CommercialAcquisitionChannel" NOT NULL,
  "attribution" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialAcquisitionContext_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialAcquisitionContext_token_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CommercialAcquisitionContext_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE TABLE "CommercialQuote" (
  "id" TEXT NOT NULL,
  "catalogPublicationId" TEXT NOT NULL,
  "campaignVersionId" TEXT,
  "acquisitionContextId" TEXT,
  "organizationId" TEXT,
  "venueId" TEXT,
  "createdById" TEXT,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "market" TEXT NOT NULL DEFAULT 'MX',
  "currency" TEXT NOT NULL DEFAULT 'MXN',
  "snapshot" JSONB NOT NULL,
  "checksum" TEXT NOT NULL,
  "listSubtotalMinor" INTEGER NOT NULL,
  "discountMinor" INTEGER NOT NULL,
  "subtotalMinor" INTEGER NOT NULL,
  "taxMinor" INTEGER NOT NULL,
  "totalMinor" INTEGER NOT NULL,
  "renewalSubtotalMinor" INTEGER NOT NULL,
  "renewalTaxMinor" INTEGER NOT NULL,
  "renewalTotalMinor" INTEGER NOT NULL,
  "quotedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercialQuote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialQuote_schema_version_check" CHECK ("schemaVersion" = 1),
  CONSTRAINT "CommercialQuote_market_check" CHECK ("market" = 'MX' AND "currency" = 'MXN'),
  CONSTRAINT "CommercialQuote_checksum_check" CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CommercialQuote_window_check" CHECK ("expiresAt" > "quotedAt"),
  CONSTRAINT "CommercialQuote_totals_check" CHECK (
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
  CONSTRAINT "CommercialQuote_snapshot_totals_check" CHECK ((
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
  ) IS TRUE)
);

CREATE TABLE "CommercialQuoteAcceptance" (
  "id" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "acceptedById" TEXT NOT NULL,
  "status" "CommercialQuoteAcceptanceStatus" NOT NULL DEFAULT 'ACCEPTED',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastStripeEventId" TEXT,
  "lastStripeEventCreatedAt" TIMESTAMP(3),
  CONSTRAINT "CommercialQuoteAcceptance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialQuoteAcceptance_revision_check" CHECK ("revision" >= 1)
);

CREATE TABLE "CommercialStripeOperation" (
  "id" TEXT NOT NULL,
  "acceptanceId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "type" "CommercialStripeOperationType" NOT NULL,
  "status" "CommercialStripeOperationStatus" NOT NULL DEFAULT 'PENDING',
  "requestFingerprint" TEXT NOT NULL,
  "stripeCheckoutSessionId" TEXT,
  "stripeCheckoutUrl" TEXT,
  "stripeSubscriptionId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialStripeOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialStripeOperation_fingerprint_check" CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "CommercialSubscriptionEvent" (
  "id" TEXT NOT NULL,
  "acceptanceId" TEXT NOT NULL,
  "stripeEventId" TEXT NOT NULL,
  "type" "CommercialSubscriptionEventType" NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "fromStatus" "CommercialQuoteAcceptanceStatus" NOT NULL,
  "toStatus" "CommercialQuoteAcceptanceStatus" NOT NULL,
  "applied" BOOLEAN NOT NULL DEFAULT true,
  "stripeCheckoutSessionId" TEXT,
  "stripeSubscriptionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercialSubscriptionEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommercialCampaignDraft_code_key" ON "CommercialCampaignDraft"("code");
CREATE INDEX "CommercialCampaignDraft_status_startsAt_endsAt_idx" ON "CommercialCampaignDraft"("status", "startsAt", "endsAt");
CREATE UNIQUE INDEX "CommercialCampaignRuleDraft_campaignDraftId_code_key" ON "CommercialCampaignRuleDraft"("campaignDraftId", "code");
CREATE INDEX "CommercialCampaignRuleDraft_campaignDraftId_priority_idx" ON "CommercialCampaignRuleDraft"("campaignDraftId", "priority");
CREATE UNIQUE INDEX "CommercialCampaignVersion_checksum_key" ON "CommercialCampaignVersion"("checksum");
CREATE UNIQUE INDEX "CommercialCampaignVersion_sourceDraftId_sourceRevision_key" ON "CommercialCampaignVersion"("sourceDraftId", "sourceRevision");
CREATE UNIQUE INDEX "CommercialCampaignVersion_id_campaignCode_key" ON "CommercialCampaignVersion"("id", "campaignCode");
CREATE INDEX "CommercialCampaignVersion_campaignCode_publishedAt_idx" ON "CommercialCampaignVersion"("campaignCode", "publishedAt");
CREATE UNIQUE INDEX "CommercialCampaignActivation_environment_campaignCode_key" ON "CommercialCampaignActivation"("environment", "campaignCode");
CREATE INDEX "CommercialCampaignActivation_campaignVersionId_idx" ON "CommercialCampaignActivation"("campaignVersionId");
CREATE UNIQUE INDEX "CommercialCampaignClaim_tokenHash_key" ON "CommercialCampaignClaim"("tokenHash");
CREATE INDEX "CommercialCampaignClaim_campaignVersionId_expiresAt_idx" ON "CommercialCampaignClaim"("campaignVersionId", "expiresAt");
CREATE INDEX "CommercialCampaignClaim_channel_sourceRef_createdAt_idx" ON "CommercialCampaignClaim"("channel", "sourceRef", "createdAt");
CREATE INDEX "CommercialCampaignClaim_expiresAt_idx" ON "CommercialCampaignClaim"("expiresAt");
CREATE UNIQUE INDEX "CommercialAcquisitionContext_tokenHash_key" ON "CommercialAcquisitionContext"("tokenHash");
CREATE INDEX "CommercialAcquisitionContext_expiresAt_idx" ON "CommercialAcquisitionContext"("expiresAt");
CREATE INDEX "CommercialAcquisitionContext_campaignVersionId_idx" ON "CommercialAcquisitionContext"("campaignVersionId");
CREATE UNIQUE INDEX "CommercialQuote_checksum_key" ON "CommercialQuote"("checksum");
CREATE INDEX "CommercialQuote_expiresAt_idx" ON "CommercialQuote"("expiresAt");
CREATE INDEX "CommercialQuote_organizationId_createdAt_idx" ON "CommercialQuote"("organizationId", "createdAt");
CREATE INDEX "CommercialQuote_venueId_createdAt_idx" ON "CommercialQuote"("venueId", "createdAt");
CREATE INDEX "CommercialQuote_createdById_createdAt_idx" ON "CommercialQuote"("createdById", "createdAt");
CREATE INDEX "CommercialQuote_catalogPublicationId_idx" ON "CommercialQuote"("catalogPublicationId");
CREATE INDEX "CommercialQuote_campaignVersionId_idx" ON "CommercialQuote"("campaignVersionId");
CREATE INDEX "CommercialQuote_acquisitionContextId_idx" ON "CommercialQuote"("acquisitionContextId");
CREATE UNIQUE INDEX "CommercialQuoteAcceptance_quoteId_key" ON "CommercialQuoteAcceptance"("quoteId");
CREATE UNIQUE INDEX "CommercialQuoteAcceptance_idempotencyKey_key" ON "CommercialQuoteAcceptance"("idempotencyKey");
CREATE INDEX "CommercialQuoteAcceptance_organizationId_status_updatedAt_idx" ON "CommercialQuoteAcceptance"("organizationId", "status", "updatedAt");
CREATE INDEX "CommercialQuoteAcceptance_venueId_status_updatedAt_idx" ON "CommercialQuoteAcceptance"("venueId", "status", "updatedAt");
CREATE UNIQUE INDEX "CommercialStripeOperation_idempotencyKey_key" ON "CommercialStripeOperation"("idempotencyKey");
CREATE UNIQUE INDEX "CommercialStripeOperation_acceptanceId_type_key" ON "CommercialStripeOperation"("acceptanceId", "type");
CREATE UNIQUE INDEX "CommercialStripeOperation_stripeCheckoutSessionId_key" ON "CommercialStripeOperation"("stripeCheckoutSessionId");
CREATE INDEX "CommercialStripeOperation_acceptanceId_createdAt_idx" ON "CommercialStripeOperation"("acceptanceId", "createdAt");
CREATE INDEX "CommercialStripeOperation_status_updatedAt_idx" ON "CommercialStripeOperation"("status", "updatedAt");
CREATE INDEX "CommercialStripeOperation_stripeSubscriptionId_idx" ON "CommercialStripeOperation"("stripeSubscriptionId");
CREATE UNIQUE INDEX "CommercialSubscriptionEvent_stripeEventId_key" ON "CommercialSubscriptionEvent"("stripeEventId");
CREATE INDEX "CommercialSubscriptionEvent_acceptanceId_effectiveAt_idx" ON "CommercialSubscriptionEvent"("acceptanceId", "effectiveAt");
CREATE INDEX "CommercialSubscriptionEvent_stripeSubscriptionId_effectiveAt_idx" ON "CommercialSubscriptionEvent"("stripeSubscriptionId", "effectiveAt");

ALTER TABLE "CommercialCampaignDraft" ADD CONSTRAINT "CommercialCampaignDraft_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialCampaignDraft" ADD CONSTRAINT "CommercialCampaignDraft_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialCampaignRuleDraft" ADD CONSTRAINT "CommercialCampaignRuleDraft_campaignDraftId_fkey" FOREIGN KEY ("campaignDraftId") REFERENCES "CommercialCampaignDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialCampaignVersion" ADD CONSTRAINT "CommercialCampaignVersion_sourceDraftId_fkey" FOREIGN KEY ("sourceDraftId") REFERENCES "CommercialCampaignDraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialCampaignVersion" ADD CONSTRAINT "CommercialCampaignVersion_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialCampaignActivation" ADD CONSTRAINT "CommercialCampaignActivation_campaignVersionId_campaignCode_fkey" FOREIGN KEY ("campaignVersionId", "campaignCode") REFERENCES "CommercialCampaignVersion"("id", "campaignCode") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialCampaignActivation" ADD CONSTRAINT "CommercialCampaignActivation_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialCampaignClaim" ADD CONSTRAINT "CommercialCampaignClaim_campaignVersionId_campaignCode_fkey" FOREIGN KEY ("campaignVersionId", "campaignCode") REFERENCES "CommercialCampaignVersion"("id", "campaignCode") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialCampaignClaim" ADD CONSTRAINT "CommercialCampaignClaim_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialAcquisitionContext" ADD CONSTRAINT "CommercialAcquisitionContext_campaignVersionId_fkey" FOREIGN KEY ("campaignVersionId") REFERENCES "CommercialCampaignVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialQuote" ADD CONSTRAINT "CommercialQuote_catalogPublicationId_fkey" FOREIGN KEY ("catalogPublicationId") REFERENCES "CommercialPublication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialQuote" ADD CONSTRAINT "CommercialQuote_campaignVersionId_fkey" FOREIGN KEY ("campaignVersionId") REFERENCES "CommercialCampaignVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialQuote" ADD CONSTRAINT "CommercialQuote_acquisitionContextId_fkey" FOREIGN KEY ("acquisitionContextId") REFERENCES "CommercialAcquisitionContext"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialQuote" ADD CONSTRAINT "CommercialQuote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialQuote" ADD CONSTRAINT "CommercialQuote_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialQuote" ADD CONSTRAINT "CommercialQuote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialQuoteAcceptance" ADD CONSTRAINT "CommercialQuoteAcceptance_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "CommercialQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialQuoteAcceptance" ADD CONSTRAINT "CommercialQuoteAcceptance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialQuoteAcceptance" ADD CONSTRAINT "CommercialQuoteAcceptance_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialQuoteAcceptance" ADD CONSTRAINT "CommercialQuoteAcceptance_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialStripeOperation" ADD CONSTRAINT "CommercialStripeOperation_acceptanceId_fkey" FOREIGN KEY ("acceptanceId") REFERENCES "CommercialQuoteAcceptance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialSubscriptionEvent" ADD CONSTRAINT "CommercialSubscriptionEvent_acceptanceId_fkey" FOREIGN KEY ("acceptanceId") REFERENCES "CommercialQuoteAcceptance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_commercial_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; create a new version or lifecycle record', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER commercial_campaign_version_immutable
BEFORE UPDATE OR DELETE ON "CommercialCampaignVersion"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_immutable_mutation();

CREATE TRIGGER commercial_campaign_claim_immutable
BEFORE UPDATE OR DELETE ON "CommercialCampaignClaim"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_immutable_mutation();

CREATE TRIGGER commercial_acquisition_context_immutable
BEFORE UPDATE OR DELETE ON "CommercialAcquisitionContext"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_immutable_mutation();

CREATE TRIGGER commercial_quote_immutable
BEFORE UPDATE OR DELETE ON "CommercialQuote"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_immutable_mutation();

CREATE TRIGGER commercial_subscription_event_immutable
BEFORE UPDATE OR DELETE ON "CommercialSubscriptionEvent"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_immutable_mutation();
