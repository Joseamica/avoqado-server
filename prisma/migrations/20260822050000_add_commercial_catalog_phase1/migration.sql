-- Commercial Platform Phase 1 is expand-only and deliberately separate from
-- the venue-facing Master Catalog. Existing Feature/VenueFeature/Stripe rows
-- are neither read nor rewritten by this migration.

CREATE TYPE "CommercialDraftStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "CommercialProductKind" AS ENUM ('PLAN', 'POS', 'MODULE');
CREATE TYPE "CommercialSalesMode" AS ENUM ('SELF_SERVICE', 'CONTACT');
CREATE TYPE "CommercialBillingUnit" AS ENUM ('VENUE_MONTH', 'VENUE_YEAR');
CREATE TYPE "CommercialTaxBehavior" AS ENUM ('EXCLUSIVE', 'NOT_APPLICABLE');
CREATE TYPE "CommercialCapabilityKind" AS ENUM ('FEATURE', 'MODULE', 'CORE');
CREATE TYPE "CommercialPublicationEnvironment" AS ENUM ('PRODUCTION', 'PREVIEW');
CREATE TYPE "CommercialPublicationOutboxStatus" AS ENUM ('PENDING', 'CLAIMED', 'DELIVERED', 'FAILED');
CREATE TYPE "CommercialPublicationEventType" AS ENUM ('PUBLICATION_CREATED', 'PUBLICATION_ACTIVATED', 'PUBLICATION_ROLLED_BACK');

CREATE TABLE "CommercialDraft" (
  "id" TEXT NOT NULL,
  "sourceKey" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "CommercialDraftStatus" NOT NULL DEFAULT 'ACTIVE',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialDraft_revision_check" CHECK ("revision" >= 1)
);

CREATE TABLE "CommercialProductDraft" (
  "id" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "kind" "CommercialProductKind" NOT NULL,
  "salesMode" "CommercialSalesMode" NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "limits" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialProductDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialProductDraft_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT "CommercialProductDraft_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE TABLE "CommercialPricebookDraft" (
  "id" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "marketCountry" TEXT NOT NULL DEFAULT 'MX',
  "currency" TEXT NOT NULL DEFAULT 'MXN',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialPricebookDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialPricebookDraft_market_check" CHECK ("marketCountry" = 'MX' AND "currency" = 'MXN'),
  CONSTRAINT "CommercialPricebookDraft_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);

CREATE TABLE "CommercialBundleDraft" (
  "id" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialBundleDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialBundleDraft_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT "CommercialBundleDraft_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE TABLE "CommercialPriceDraft" (
  "id" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "pricebookId" TEXT NOT NULL,
  "productId" TEXT,
  "bundleId" TEXT,
  "code" TEXT NOT NULL,
  "billingUnit" "CommercialBillingUnit" NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'MXN',
  "taxBehavior" "CommercialTaxBehavior" NOT NULL DEFAULT 'EXCLUSIVE',
  "taxRateBasisPoints" INTEGER NOT NULL DEFAULT 1600,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialPriceDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialPriceDraft_target_xor_check" CHECK (("productId" IS NOT NULL) <> ("bundleId" IS NOT NULL)),
  CONSTRAINT "CommercialPriceDraft_amount_check" CHECK ("amount" >= 0),
  CONSTRAINT "CommercialPriceDraft_currency_check" CHECK ("currency" = 'MXN'),
  CONSTRAINT "CommercialPriceDraft_tax_check" CHECK (
    ("amount" > 0 AND "taxBehavior" = 'EXCLUSIVE' AND "taxRateBasisPoints" = 1600)
    OR ("amount" = 0 AND "taxBehavior" = 'NOT_APPLICABLE' AND "taxRateBasisPoints" = 0)
  ),
  CONSTRAINT "CommercialPriceDraft_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);

CREATE TABLE "CommercialBundleItemDraft" (
  "id" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "bundleId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialBundleItemDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialBundleItemDraft_quantity_check" CHECK ("quantity" = 1)
);

CREATE TABLE "CommercialFeatureBindingDraft" (
  "id" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "capabilityCode" TEXT NOT NULL,
  "capabilityKind" "CommercialCapabilityKind" NOT NULL DEFAULT 'FEATURE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialFeatureBindingDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialFeatureBindingDraft_code_check" CHECK ("capabilityCode" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);

CREATE TABLE "CommercialPublication" (
  "id" TEXT NOT NULL,
  "sourceDraftId" TEXT NOT NULL,
  "sourceRevision" INTEGER NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "snapshot" JSONB NOT NULL,
  "checksum" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "publishedById" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercialPublication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialPublication_source_revision_check" CHECK ("sourceRevision" >= 1),
  CONSTRAINT "CommercialPublication_schema_version_check" CHECK ("schemaVersion" = 1),
  CONSTRAINT "CommercialPublication_checksum_check" CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CommercialPublication_reason_check" CHECK (length(btrim("reason")) > 0)
);

CREATE TABLE "CommercialPublicationActivation" (
  "id" TEXT NOT NULL,
  "environment" "CommercialPublicationEnvironment" NOT NULL,
  "publicationId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "reason" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialPublicationActivation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialPublicationActivation_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "CommercialPublicationActivation_reason_check" CHECK (length(btrim("reason")) > 0)
);

CREATE TABLE "CommercialPublicationOutbox" (
  "id" TEXT NOT NULL,
  "eventType" "CommercialPublicationEventType" NOT NULL,
  "publicationId" TEXT NOT NULL,
  "previousPublicationId" TEXT,
  "payloadVersion" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "status" "CommercialPublicationOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedBy" TEXT,
  "claimedAt" TIMESTAMP(3),
  "claimExpiresAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialPublicationOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialPublicationOutbox_payload_version_check" CHECK ("payloadVersion" = 1),
  CONSTRAINT "CommercialPublicationOutbox_attempts_check" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "CommercialDraft_sourceKey_key" ON "CommercialDraft"("sourceKey");
CREATE INDEX "CommercialDraft_status_updatedAt_idx" ON "CommercialDraft"("status", "updatedAt");
CREATE UNIQUE INDEX "CommercialProductDraft_draftId_code_key" ON "CommercialProductDraft"("draftId", "code");
CREATE UNIQUE INDEX "CommercialProductDraft_draftId_slug_key" ON "CommercialProductDraft"("draftId", "slug");
CREATE UNIQUE INDEX "CommercialProductDraft_id_draftId_key" ON "CommercialProductDraft"("id", "draftId");
CREATE INDEX "CommercialProductDraft_draftId_active_sortOrder_idx" ON "CommercialProductDraft"("draftId", "active", "sortOrder");
CREATE UNIQUE INDEX "CommercialPricebookDraft_draftId_code_key" ON "CommercialPricebookDraft"("draftId", "code");
CREATE UNIQUE INDEX "CommercialPricebookDraft_id_draftId_key" ON "CommercialPricebookDraft"("id", "draftId");
CREATE INDEX "CommercialPricebookDraft_draftId_active_idx" ON "CommercialPricebookDraft"("draftId", "active");
CREATE UNIQUE INDEX "CommercialBundleDraft_draftId_code_key" ON "CommercialBundleDraft"("draftId", "code");
CREATE UNIQUE INDEX "CommercialBundleDraft_draftId_slug_key" ON "CommercialBundleDraft"("draftId", "slug");
CREATE UNIQUE INDEX "CommercialBundleDraft_id_draftId_key" ON "CommercialBundleDraft"("id", "draftId");
CREATE INDEX "CommercialBundleDraft_draftId_active_sortOrder_idx" ON "CommercialBundleDraft"("draftId", "active", "sortOrder");
CREATE UNIQUE INDEX "CommercialPriceDraft_draftId_code_key" ON "CommercialPriceDraft"("draftId", "code");
CREATE UNIQUE INDEX "CommercialPriceDraft_pricebookId_productId_billingUnit_key" ON "CommercialPriceDraft"("pricebookId", "productId", "billingUnit");
CREATE UNIQUE INDEX "CommercialPriceDraft_pricebookId_bundleId_billingUnit_key" ON "CommercialPriceDraft"("pricebookId", "bundleId", "billingUnit");
CREATE INDEX "CommercialPriceDraft_draftId_active_idx" ON "CommercialPriceDraft"("draftId", "active");
CREATE INDEX "CommercialPriceDraft_productId_draftId_idx" ON "CommercialPriceDraft"("productId", "draftId");
CREATE INDEX "CommercialPriceDraft_bundleId_draftId_idx" ON "CommercialPriceDraft"("bundleId", "draftId");
CREATE UNIQUE INDEX "CommercialBundleItemDraft_bundleId_productId_key" ON "CommercialBundleItemDraft"("bundleId", "productId");
CREATE INDEX "CommercialBundleItemDraft_draftId_bundleId_sortOrder_idx" ON "CommercialBundleItemDraft"("draftId", "bundleId", "sortOrder");
CREATE INDEX "CommercialBundleItemDraft_productId_draftId_idx" ON "CommercialBundleItemDraft"("productId", "draftId");
CREATE UNIQUE INDEX "CommercialFeatureBindingDraft_productId_capabilityCode_key" ON "CommercialFeatureBindingDraft"("productId", "capabilityCode");
CREATE INDEX "CommercialFeatureBindingDraft_draftId_capabilityCode_idx" ON "CommercialFeatureBindingDraft"("draftId", "capabilityCode");
CREATE UNIQUE INDEX "CommercialPublication_checksum_key" ON "CommercialPublication"("checksum");
CREATE UNIQUE INDEX "CommercialPublication_sourceDraftId_sourceRevision_checksum_key" ON "CommercialPublication"("sourceDraftId", "sourceRevision", "checksum");
CREATE INDEX "CommercialPublication_publishedAt_id_idx" ON "CommercialPublication"("publishedAt", "id");
CREATE UNIQUE INDEX "CommercialPublicationActivation_environment_key" ON "CommercialPublicationActivation"("environment");
CREATE INDEX "CommercialPublicationActivation_publicationId_idx" ON "CommercialPublicationActivation"("publicationId");
CREATE UNIQUE INDEX "CommercialPublicationOutbox_dedupeKey_key" ON "CommercialPublicationOutbox"("dedupeKey");
CREATE INDEX "CommercialPublicationOutbox_status_nextAttemptAt_createdAt_idx" ON "CommercialPublicationOutbox"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "CommercialPublicationOutbox_status_claimExpiresAt_idx" ON "CommercialPublicationOutbox"("status", "claimExpiresAt");
CREATE INDEX "CommercialPublicationOutbox_publicationId_idx" ON "CommercialPublicationOutbox"("publicationId");

ALTER TABLE "CommercialDraft" ADD CONSTRAINT "CommercialDraft_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialDraft" ADD CONSTRAINT "CommercialDraft_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialProductDraft" ADD CONSTRAINT "CommercialProductDraft_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "CommercialDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialPricebookDraft" ADD CONSTRAINT "CommercialPricebookDraft_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "CommercialDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialBundleDraft" ADD CONSTRAINT "CommercialBundleDraft_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "CommercialDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialPriceDraft" ADD CONSTRAINT "CommercialPriceDraft_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "CommercialDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialPriceDraft" ADD CONSTRAINT "CommercialPriceDraft_pricebookId_draftId_fkey" FOREIGN KEY ("pricebookId", "draftId") REFERENCES "CommercialPricebookDraft"("id", "draftId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialPriceDraft" ADD CONSTRAINT "CommercialPriceDraft_productId_draftId_fkey" FOREIGN KEY ("productId", "draftId") REFERENCES "CommercialProductDraft"("id", "draftId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialPriceDraft" ADD CONSTRAINT "CommercialPriceDraft_bundleId_draftId_fkey" FOREIGN KEY ("bundleId", "draftId") REFERENCES "CommercialBundleDraft"("id", "draftId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialBundleItemDraft" ADD CONSTRAINT "CommercialBundleItemDraft_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "CommercialDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialBundleItemDraft" ADD CONSTRAINT "CommercialBundleItemDraft_bundleId_draftId_fkey" FOREIGN KEY ("bundleId", "draftId") REFERENCES "CommercialBundleDraft"("id", "draftId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialBundleItemDraft" ADD CONSTRAINT "CommercialBundleItemDraft_productId_draftId_fkey" FOREIGN KEY ("productId", "draftId") REFERENCES "CommercialProductDraft"("id", "draftId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialFeatureBindingDraft" ADD CONSTRAINT "CommercialFeatureBindingDraft_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "CommercialDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialFeatureBindingDraft" ADD CONSTRAINT "CommercialFeatureBindingDraft_productId_draftId_fkey" FOREIGN KEY ("productId", "draftId") REFERENCES "CommercialProductDraft"("id", "draftId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialPublication" ADD CONSTRAINT "CommercialPublication_sourceDraftId_fkey" FOREIGN KEY ("sourceDraftId") REFERENCES "CommercialDraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialPublication" ADD CONSTRAINT "CommercialPublication_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialPublicationActivation" ADD CONSTRAINT "CommercialPublicationActivation_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "CommercialPublication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialPublicationActivation" ADD CONSTRAINT "CommercialPublicationActivation_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialPublicationOutbox" ADD CONSTRAINT "CommercialPublicationOutbox_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "CommercialPublication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialPublicationOutbox" ADD CONSTRAINT "CommercialPublicationOutbox_previousPublicationId_fkey" FOREIGN KEY ("previousPublicationId") REFERENCES "CommercialPublication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_commercial_publication_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CommercialPublication is immutable; activate an older publication to roll back'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER commercial_publication_immutable_update
BEFORE UPDATE ON "CommercialPublication"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_publication_mutation();

CREATE TRIGGER commercial_publication_immutable_delete
BEFORE DELETE ON "CommercialPublication"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_publication_mutation();
