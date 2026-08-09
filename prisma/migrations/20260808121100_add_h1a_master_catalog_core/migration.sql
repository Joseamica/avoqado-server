-- H1A MASTER CATALOG CORE — EXPAND ONLY
--
-- This migration creates only new, empty organization/catalog tables after
-- lock-safe legacy keys exist. It performs no backfill, grants, rollout rows,
-- publication, Product re-identification, or runtime enablement.
--
-- Production rollback is operational (disable writers/gates), not destructive:
-- dropping these durable audit and publication tables is intentionally unsupported.

-- CreateTable
CREATE TABLE "OrganizationEntitlement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "featureCode" TEXT NOT NULL,
    "status" "OrganizationEntitlementStatus" NOT NULL DEFAULT 'REVOKED',
    "source" "OrganizationEntitlementSource" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "grantedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogBrand" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "status" "CatalogReferenceStatus" NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogBrand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogManufacturer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "status" "CatalogReferenceStatus" NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogManufacturer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogFamily" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "status" "CatalogReferenceStatus" NOT NULL,
    "parentId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "normalizedSku" TEXT NOT NULL,
    "kind" "CatalogItemKind" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "manufacturerId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "presentationLabel" TEXT NOT NULL,
    "unit" "Unit" NOT NULL,
    "taxRate" DECIMAL(5,4) NOT NULL,
    "satProductKey" TEXT NOT NULL,
    "satUnitKey" TEXT NOT NULL,
    "objetoImp" TEXT NOT NULL,
    "productType" "ProductType" NOT NULL,
    "iepsMode" "CatalogIepsMode" NOT NULL,
    "iepsRate" DECIMAL(7,6),
    "iepsQuota" DECIMAL(12,4),
    "iepsQuotaUnit" "Unit",
    "status" "CatalogItemStatus" NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "invariantVersion" BIGINT NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogItemBusinessType" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "catalogItemId" TEXT NOT NULL,
    "businessType" "BusinessType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogItemBusinessType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogProductTypeMapping" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "catalogProductType" TEXT NOT NULL,
    "productType" "ProductType" NOT NULL,
    "mappingVersion" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogProductTypeMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogIdentifier" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "catalogItemId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "normalizedCode" TEXT NOT NULL,
    "type" "CatalogIdentifierType" NOT NULL,
    "status" "CatalogIdentifierStatus" NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogValidationProfile" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "profileVersion" INTEGER NOT NULL DEFAULT 1,
    "rulesSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "businessType" "BusinessType",
    "operationalRole" "VenueOperationalRole",
    "requiredFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "additionalRules" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogValidationProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogItemPrice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "catalogItemId" TEXT NOT NULL,
    "kind" "CatalogItemPriceKind" NOT NULL,
    "scope" "CatalogItemPriceScope" NOT NULL DEFAULT 'ORGANIZATION',
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogItemPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogVenueRollout" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "registryState" "CatalogRegistryState" NOT NULL DEFAULT 'NOT_STARTED',
    "aliasPublicationState" "CatalogAliasPublicationState" NOT NULL DEFAULT 'DISABLED',
    "governanceState" "CatalogGovernanceState" NOT NULL DEFAULT 'NOT_STARTED',
    "identifierRevision" BIGINT NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogVenueRollout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogVenueClientRequirement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "family" "CatalogClientFamily" NOT NULL,
    "mode" "CatalogClientRequirementMode" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "minimumVersion" TEXT,
    "maxObservationAgeDays" INTEGER NOT NULL DEFAULT 30,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogVenueClientRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogClientObservation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "family" "CatalogClientFamily" NOT NULL,
    "appVersion" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogClientObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogClientReadinessOverride" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "family" "CatalogClientFamily",
    "status" "CatalogReadinessOverrideStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revocationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogClientReadinessOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogVenueBinding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "catalogItemId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "productId" TEXT,
    "status" "CatalogVenueBindingStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "lastPublishedCatalogRevision" INTEGER,
    "lastPublishedManagedSnapshot" JSONB,
    "managedFieldMask" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "managedHashVersion" INTEGER,
    "lastPublishedManagedHash" TEXT,
    "productUpdatedAtObserved" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogVenueBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogVenueOverride" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "localValue" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "CatalogVenueOverrideStatus" NOT NULL,
    "requestBatchId" TEXT,
    "requestedById" TEXT,
    "decidedById" TEXT,
    "requestedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "supersededByOverrideId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogVenueOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogIdempotencyRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "requestHashVersion" INTEGER NOT NULL DEFAULT 1,
    "state" "CatalogOperationState" NOT NULL DEFAULT 'NOT_STARTED',
    "resourceType" TEXT,
    "resourceId" TEXT,
    "targetHash" TEXT,
    "previewTokenHash" TEXT,
    "previewExpiresAt" TIMESTAMP(3),
    "dependencies" JSONB,
    "result" JSONB,
    "actorType" "ActivityActorType" NOT NULL,
    "staffId" TEXT,
    "servicePrincipalId" TEXT,
    "attemptId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogImportBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "state" "CatalogOperationState" NOT NULL DEFAULT 'NOT_STARTED',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "fileSha256" TEXT,
    "requestHash" TEXT NOT NULL,
    "requestHashVersion" INTEGER NOT NULL DEFAULT 1,
    "targetHash" TEXT NOT NULL,
    "previewTokenHash" TEXT NOT NULL,
    "previewExpiresAt" TIMESTAMP(3) NOT NULL,
    "dependencies" JSONB NOT NULL,
    "actorType" "ActivityActorType" NOT NULL,
    "staffId" TEXT,
    "servicePrincipalId" TEXT,
    "attemptId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "result" JSONB,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "appliedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogImportLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sourceSheet" TEXT NOT NULL,
    "sourceRow" INTEGER NOT NULL,
    "status" "CatalogImportLineStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "payload" JSONB NOT NULL,
    "errors" JSONB,
    "catalogItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogImportLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogBindingBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "state" "CatalogOperationState" NOT NULL DEFAULT 'NOT_STARTED',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "requestHash" TEXT NOT NULL,
    "requestHashVersion" INTEGER NOT NULL DEFAULT 1,
    "targetHash" TEXT NOT NULL,
    "previewTokenHash" TEXT NOT NULL,
    "previewExpiresAt" TIMESTAMP(3) NOT NULL,
    "dependencies" JSONB NOT NULL,
    "actorType" "ActivityActorType" NOT NULL,
    "staffId" TEXT,
    "servicePrincipalId" TEXT,
    "attemptId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "result" JSONB,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "appliedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogBindingBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogBindingLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "catalogItemId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "productId" TEXT,
    "status" "CatalogBindingLineStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "proposal" "CatalogBindingProposal" NOT NULL,
    "decision" "CatalogBindingProposal",
    "before" JSONB,
    "after" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogBindingLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogPublicationBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "state" "CatalogOperationState" NOT NULL DEFAULT 'NOT_STARTED',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "requestHash" TEXT NOT NULL,
    "requestHashVersion" INTEGER NOT NULL DEFAULT 1,
    "targetHash" TEXT NOT NULL,
    "previewTokenHash" TEXT NOT NULL,
    "previewExpiresAt" TIMESTAMP(3) NOT NULL,
    "dependencies" JSONB NOT NULL,
    "actorType" "ActivityActorType" NOT NULL,
    "staffId" TEXT,
    "servicePrincipalId" TEXT,
    "attemptId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "result" JSONB,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "appliedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogPublicationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogPublicationLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "catalogItemId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "CatalogPublicationLineStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "fieldMask" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "decisionSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "decisionInvariantVersion" BIGINT NOT NULL DEFAULT 0,
    "changeKind" "CatalogPublicationChangeKind" NOT NULL,
    "hashVersion" INTEGER NOT NULL,
    "canonicalTargetHash" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "sourceCatalogRevision" INTEGER NOT NULL,
    "bindingRevision" INTEGER,
    "supersedesLineId" TEXT,
    "reversesLineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogPublicationLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogPublicationFieldDecision" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "decision" "CatalogPublicationFieldDecisionKind" NOT NULL,
    "before" JSONB NOT NULL,
    "proposed" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "overrideId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogPublicationFieldDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogVenueEventSequence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "lastIssuedSequence" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogVenueEventSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogPublicationOutbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "venueSequence" BIGINT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "CatalogPublicationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimExpiresAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogPublicationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationEntitlement_organizationId_status_idx" ON "OrganizationEntitlement"("organizationId", "status");

-- CreateIndex
CREATE INDEX "OrganizationEntitlement_featureCode_status_idx" ON "OrganizationEntitlement"("featureCode", "status");

-- CreateIndex
CREATE INDEX "OrganizationEntitlement_endsAt_idx" ON "OrganizationEntitlement"("endsAt");

-- CreateIndex
CREATE INDEX "OrganizationEntitlement_grantedById_idx" ON "OrganizationEntitlement"("grantedById");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationEntitlement_organizationId_featureCode_key" ON "OrganizationEntitlement"("organizationId", "featureCode");

-- CreateIndex
CREATE INDEX "CatalogBrand_organizationId_status_idx" ON "CatalogBrand"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CatalogBrand_createdById_idx" ON "CatalogBrand"("createdById");

-- CreateIndex
CREATE INDEX "CatalogBrand_updatedById_idx" ON "CatalogBrand"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogBrand_organizationId_normalizedName_key" ON "CatalogBrand"("organizationId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogBrand_id_organizationId_key" ON "CatalogBrand"("id", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogManufacturer_organizationId_status_idx" ON "CatalogManufacturer"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CatalogManufacturer_createdById_idx" ON "CatalogManufacturer"("createdById");

-- CreateIndex
CREATE INDEX "CatalogManufacturer_updatedById_idx" ON "CatalogManufacturer"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogManufacturer_organizationId_normalizedName_key" ON "CatalogManufacturer"("organizationId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogManufacturer_id_organizationId_key" ON "CatalogManufacturer"("id", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogFamily_organizationId_status_idx" ON "CatalogFamily"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CatalogFamily_parentId_organizationId_idx" ON "CatalogFamily"("parentId", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogFamily_createdById_idx" ON "CatalogFamily"("createdById");

-- CreateIndex
CREATE INDEX "CatalogFamily_updatedById_idx" ON "CatalogFamily"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogFamily_organizationId_normalizedName_key" ON "CatalogFamily"("organizationId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogFamily_id_organizationId_key" ON "CatalogFamily"("id", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogItem_organizationId_status_idx" ON "CatalogItem"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CatalogItem_brandId_organizationId_idx" ON "CatalogItem"("brandId", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogItem_manufacturerId_organizationId_idx" ON "CatalogItem"("manufacturerId", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogItem_familyId_organizationId_idx" ON "CatalogItem"("familyId", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogItem_createdById_idx" ON "CatalogItem"("createdById");

-- CreateIndex
CREATE INDEX "CatalogItem_updatedById_idx" ON "CatalogItem"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogItem_organizationId_normalizedSku_key" ON "CatalogItem"("organizationId", "normalizedSku");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogItem_id_organizationId_key" ON "CatalogItem"("id", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogItemBusinessType_organizationId_businessType_idx" ON "CatalogItemBusinessType"("organizationId", "businessType");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogItemBusinessType_catalogItemId_businessType_key" ON "CatalogItemBusinessType"("catalogItemId", "businessType");

-- CreateIndex
CREATE INDEX "CatalogProductTypeMapping_organizationId_active_idx" ON "CatalogProductTypeMapping"("organizationId", "active");

-- CreateIndex
CREATE INDEX "CatalogProductTypeMapping_createdById_idx" ON "CatalogProductTypeMapping"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogProductTypeMapping_organizationId_catalogProductType_key" ON "CatalogProductTypeMapping"("organizationId", "catalogProductType", "mappingVersion");

-- Version history stays append-only/inactive while import resolution remains
-- deterministic: at most one alias version can be active in an organization.
CREATE UNIQUE INDEX "CatalogProductTypeMapping_one_active_alias_key"
ON "CatalogProductTypeMapping"("organizationId", "catalogProductType")
WHERE "active";

-- CreateIndex
CREATE INDEX "CatalogIdentifier_catalogItemId_type_idx" ON "CatalogIdentifier"("catalogItemId", "type");

-- CreateIndex
CREATE INDEX "CatalogIdentifier_organizationId_status_idx" ON "CatalogIdentifier"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CatalogIdentifier_createdById_idx" ON "CatalogIdentifier"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogIdentifier_organizationId_normalizedCode_key" ON "CatalogIdentifier"("organizationId", "normalizedCode");

-- CORPORATE_SKU is an exact-one projection. This index provides the at-most-one
-- half immediately; the deferred triggers below provide presence and equality.
CREATE UNIQUE INDEX "CatalogIdentifier_one_corporate_sku_per_item_key"
ON "CatalogIdentifier"("catalogItemId")
WHERE "type" = 'CORPORATE_SKU';

-- CreateIndex
CREATE INDEX "CatalogValidationProfile_organizationId_active_idx" ON "CatalogValidationProfile"("organizationId", "active");

-- CreateIndex
CREATE INDEX "CatalogValidationProfile_businessType_operationalRole_idx" ON "CatalogValidationProfile"("businessType", "operationalRole");

-- CreateIndex
CREATE INDEX "CatalogValidationProfile_createdById_idx" ON "CatalogValidationProfile"("createdById");

-- CreateIndex
CREATE INDEX "CatalogValidationProfile_updatedById_idx" ON "CatalogValidationProfile"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogValidationProfile_organizationId_name_profileVersion_key" ON "CatalogValidationProfile"("organizationId", "name", "profileVersion");

-- NULL scope members mean "all". PostgreSQL 14 has no NULLS NOT DISTINCT, so
-- each nullable enum contributes both an IS NULL discriminator and a native
-- enum COALESCE. This is immutable and keeps NULL distinct from the sentinel's
-- real enum value while enforcing one active row per exact scope.
CREATE UNIQUE INDEX "CatalogValidationProfile_one_active_scope_key"
ON "CatalogValidationProfile"(
  "organizationId",
  "name",
  (("businessType" IS NULL)),
  (COALESCE("businessType", 'RESTAURANT'::"BusinessType")),
  (("operationalRole" IS NULL)),
  (COALESCE("operationalRole", 'STORE'::"VenueOperationalRole"))
)
WHERE "active";

-- CreateIndex
CREATE INDEX "CatalogItemPrice_organizationId_kind_active_idx" ON "CatalogItemPrice"("organizationId", "kind", "active");

-- The deferred baseline lookup always begins with the aggregate ID; keeping it
-- first avoids a per-trigger scan across every item in the organization.
CREATE INDEX "CatalogItemPrice_item_org_active_kind_currency_idx"
ON "CatalogItemPrice"("catalogItemId", "organizationId", "active", "kind", "currency");

-- CreateIndex
CREATE INDEX "CatalogItemPrice_createdById_idx" ON "CatalogItemPrice"("createdById");

-- CreateIndex
CREATE INDEX "CatalogItemPrice_updatedById_idx" ON "CatalogItemPrice"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogItemPrice_org_item_kind_scope_currency_key" ON "CatalogItemPrice"("organizationId", "catalogItemId", "kind", "scope", "currency");

-- CreateIndex
CREATE INDEX "CatalogVenueRollout_organizationId_governanceState_idx" ON "CatalogVenueRollout"("organizationId", "governanceState");

-- CreateIndex
CREATE INDEX "CatalogVenueRollout_venueId_aliasPublicationState_idx" ON "CatalogVenueRollout"("venueId", "aliasPublicationState");

-- CreateIndex
CREATE INDEX "CatalogVenueRollout_createdById_idx" ON "CatalogVenueRollout"("createdById");

-- CreateIndex
CREATE INDEX "CatalogVenueRollout_updatedById_idx" ON "CatalogVenueRollout"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogVenueRollout_organizationId_venueId_key" ON "CatalogVenueRollout"("organizationId", "venueId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogVenueRollout_id_organizationId_key" ON "CatalogVenueRollout"("id", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogVenueClientRequirement_venueId_mode_idx" ON "CatalogVenueClientRequirement"("venueId", "mode");

-- CreateIndex
CREATE INDEX "CatalogVenueClientRequirement_createdById_idx" ON "CatalogVenueClientRequirement"("createdById");

-- CreateIndex
CREATE INDEX "CatalogVenueClientRequirement_updatedById_idx" ON "CatalogVenueClientRequirement"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogVenueClientRequirement_organizationId_venueId_family_key" ON "CatalogVenueClientRequirement"("organizationId", "venueId", "family");

-- CreateIndex
CREATE INDEX "CatalogClientObservation_venueId_family_lastSeenAt_idx" ON "CatalogClientObservation"("venueId", "family", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogClientObservation_organizationId_venueId_deviceId_fa_key" ON "CatalogClientObservation"("organizationId", "venueId", "deviceId", "family");

-- CreateIndex
CREATE INDEX "CatalogClientReadinessOverride_organizationId_venueId_statu_idx" ON "CatalogClientReadinessOverride"("organizationId", "venueId", "status");

-- CreateIndex
CREATE INDEX "CatalogClientReadinessOverride_expiresAt_idx" ON "CatalogClientReadinessOverride"("expiresAt");

-- CreateIndex
CREATE INDEX "CatalogClientReadinessOverride_createdById_idx" ON "CatalogClientReadinessOverride"("createdById");

-- CreateIndex
CREATE INDEX "CatalogClientReadinessOverride_revokedById_idx" ON "CatalogClientReadinessOverride"("revokedById");

-- CreateIndex
CREATE INDEX "CatalogVenueBinding_organizationId_status_idx" ON "CatalogVenueBinding"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CatalogVenueBinding_catalogItemId_organizationId_idx" ON "CatalogVenueBinding"("catalogItemId", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogVenueBinding_venueId_organizationId_idx" ON "CatalogVenueBinding"("venueId", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogVenueBinding_createdById_idx" ON "CatalogVenueBinding"("createdById");

-- CreateIndex
CREATE INDEX "CatalogVenueBinding_updatedById_idx" ON "CatalogVenueBinding"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogVenueBinding_organizationId_catalogItemId_venueId_key" ON "CatalogVenueBinding"("organizationId", "catalogItemId", "venueId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogVenueBinding_productId_venueId_key" ON "CatalogVenueBinding"("productId", "venueId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogVenueBinding_id_organizationId_key" ON "CatalogVenueBinding"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogVenueBinding_id_organizationId_venueId_key" ON "CatalogVenueBinding"("id", "organizationId", "venueId");

-- A publication line must name the exact CatalogItem/Product pair owned by
-- its binding; independent tenant-safe FKs cannot prove that provenance.
CREATE UNIQUE INDEX "CatalogVenueBinding_publication_target_key"
  ON "CatalogVenueBinding"("id", "organizationId", "venueId", "catalogItemId", "productId");

-- CreateIndex
CREATE INDEX "CatalogVenueOverride_organizationId_status_idx" ON "CatalogVenueOverride"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CatalogVenueOverride_bindingId_field_idx" ON "CatalogVenueOverride"("bindingId", "field");

-- CreateIndex
CREATE INDEX "CatalogVenueOverride_venueId_organizationId_idx" ON "CatalogVenueOverride"("venueId", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogVenueOverride_requestBatchId_organizationId_idx" ON "CatalogVenueOverride"("requestBatchId", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogVenueOverride_supersededByOverrideId_tenant_field_idx" ON "CatalogVenueOverride"("supersededByOverrideId", "organizationId", "bindingId", "field");

-- CreateIndex
CREATE INDEX "CatalogVenueOverride_requestedById_idx" ON "CatalogVenueOverride"("requestedById");

-- CreateIndex
CREATE INDEX "CatalogVenueOverride_decidedById_idx" ON "CatalogVenueOverride"("decidedById");

-- Composite support lets deferred self/decision provenance FKs prove the same
-- tenant, binding, and field without trusting application-supplied IDs.
CREATE UNIQUE INDEX "CatalogVenueOverride_id_organizationId_bindingId_field_key" ON "CatalogVenueOverride"("id", "organizationId", "bindingId", "field");
CREATE UNIQUE INDEX "CatalogVenueOverride_one_requested_field_key"
  ON "CatalogVenueOverride"("organizationId", "bindingId", "field")
  WHERE "status" = 'REQUESTED';
CREATE UNIQUE INDEX "CatalogVenueOverride_one_approved_field_key"
  ON "CatalogVenueOverride"("organizationId", "bindingId", "field")
  WHERE "status" = 'APPROVED';

-- CreateIndex
CREATE INDEX "CatalogIdempotencyRecord_organizationId_state_idx" ON "CatalogIdempotencyRecord"("organizationId", "state");

-- CreateIndex
CREATE INDEX "CatalogIdempotencyRecord_state_leaseExpiresAt_idx" ON "CatalogIdempotencyRecord"("state", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "CatalogIdempotencyRecord_previewExpiresAt_idx" ON "CatalogIdempotencyRecord"("previewExpiresAt");

-- CreateIndex
CREATE INDEX "CatalogIdempotencyRecord_resourceType_resourceId_idx" ON "CatalogIdempotencyRecord"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "CatalogIdempotencyRecord_staffId_idx" ON "CatalogIdempotencyRecord"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogIdempotencyRecord_organizationId_operation_idemp_key" ON "CatalogIdempotencyRecord"("organizationId", "operation", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogIdempotencyRecord_id_organizationId_key" ON "CatalogIdempotencyRecord"("id", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogImportBatch_organizationId_state_idx" ON "CatalogImportBatch"("organizationId", "state");

-- CreateIndex
CREATE INDEX "CatalogImportBatch_state_leaseExpiresAt_idx" ON "CatalogImportBatch"("state", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "CatalogImportBatch_previewExpiresAt_idx" ON "CatalogImportBatch"("previewExpiresAt");

-- CreateIndex
CREATE INDEX "CatalogImportBatch_staffId_idx" ON "CatalogImportBatch"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogImportBatch_id_organizationId_key" ON "CatalogImportBatch"("id", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogImportLine_organizationId_status_idx" ON "CatalogImportLine"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CatalogImportLine_catalogItemId_organizationId_idx" ON "CatalogImportLine"("catalogItemId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogImportLine_batchId_sourceSheet_sourceRow_key" ON "CatalogImportLine"("batchId", "sourceSheet", "sourceRow");

-- CreateIndex
CREATE INDEX "CatalogBindingBatch_organizationId_state_idx" ON "CatalogBindingBatch"("organizationId", "state");

-- CreateIndex
CREATE INDEX "CatalogBindingBatch_state_leaseExpiresAt_idx" ON "CatalogBindingBatch"("state", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "CatalogBindingBatch_previewExpiresAt_idx" ON "CatalogBindingBatch"("previewExpiresAt");

-- CreateIndex
CREATE INDEX "CatalogBindingBatch_staffId_idx" ON "CatalogBindingBatch"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogBindingBatch_id_organizationId_key" ON "CatalogBindingBatch"("id", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogBindingLine_organizationId_status_idx" ON "CatalogBindingLine"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CatalogBindingLine_catalogItemId_organizationId_idx" ON "CatalogBindingLine"("catalogItemId", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogBindingLine_venueId_organizationId_idx" ON "CatalogBindingLine"("venueId", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogBindingLine_productId_venueId_idx" ON "CatalogBindingLine"("productId", "venueId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogBindingLine_batchId_catalogItemId_venueId_key" ON "CatalogBindingLine"("batchId", "catalogItemId", "venueId");

-- CreateIndex
CREATE INDEX "CatalogPublicationBatch_organizationId_operation_state_idx" ON "CatalogPublicationBatch"("organizationId", "operation", "state");

-- CreateIndex
CREATE INDEX "CatalogPublicationBatch_state_leaseExpiresAt_idx" ON "CatalogPublicationBatch"("state", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "CatalogPublicationBatch_previewExpiresAt_idx" ON "CatalogPublicationBatch"("previewExpiresAt");

-- CreateIndex
CREATE INDEX "CatalogPublicationBatch_staffId_idx" ON "CatalogPublicationBatch"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogPublicationBatch_id_organizationId_key" ON "CatalogPublicationBatch"("id", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogPublicationLine_organizationId_status_idx" ON "CatalogPublicationLine"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CatalogPublicationLine_catalogItemId_organizationId_idx" ON "CatalogPublicationLine"("catalogItemId", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogPublicationLine_bindingId_organizationId_idx" ON "CatalogPublicationLine"("bindingId", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogPublicationLine_venueId_organizationId_idx" ON "CatalogPublicationLine"("venueId", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogPublicationLine_productId_venueId_idx" ON "CatalogPublicationLine"("productId", "venueId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogPublicationLine_batchId_catalogItemId_venueId_produc_key" ON "CatalogPublicationLine"("batchId", "catalogItemId", "venueId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogPublicationLine_id_organizationId_key" ON "CatalogPublicationLine"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogPublicationLine_id_organizationId_bindingId_key" ON "CatalogPublicationLine"("id", "organizationId", "bindingId");

-- RI triggers must find READY and APPLIED self-lineage alike. These full
-- child-side indexes prevent per-row global scans during target delete/update.
CREATE INDEX "CatalogPublicationLine_supersedes_tenant_binding_idx"
  ON "CatalogPublicationLine"("supersedesLineId", "organizationId", "bindingId");
CREATE INDEX "CatalogPublicationLine_reverses_tenant_binding_idx"
  ON "CatalogPublicationLine"("reversesLineId", "organizationId", "bindingId");

-- Only applied history claims the durable successor/reversal slot. Failed or
-- abandoned previews can be retried without consuming it.
CREATE UNIQUE INDEX "CatalogPublicationLine_one_applied_successor_key"
  ON "CatalogPublicationLine"("organizationId", "supersedesLineId")
  WHERE "status" = 'APPLIED' AND "supersedesLineId" IS NOT NULL;
CREATE UNIQUE INDEX "CatalogPublicationLine_one_applied_reversal_key"
  ON "CatalogPublicationLine"("organizationId", "reversesLineId")
  WHERE "status" = 'APPLIED' AND "reversesLineId" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "CatalogPublicationFieldDecision_lineId_field_key" ON "CatalogPublicationFieldDecision"("lineId", "field");

-- CreateIndex
CREATE INDEX "CatalogPublicationFieldDecision_organizationId_lineId_idx" ON "CatalogPublicationFieldDecision"("organizationId", "lineId");

-- CreateIndex
CREATE INDEX "CatalogPublicationFieldDecision_bindingId_field_idx" ON "CatalogPublicationFieldDecision"("bindingId", "field");

-- CreateIndex
CREATE INDEX "CatalogPublicationFieldDecision_override_tenant_field_idx" ON "CatalogPublicationFieldDecision"("overrideId", "organizationId", "bindingId", "field");

-- CreateIndex
CREATE INDEX "CatalogVenueEventSequence_venueId_idx" ON "CatalogVenueEventSequence"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogVenueEventSequence_organizationId_venueId_key" ON "CatalogVenueEventSequence"("organizationId", "venueId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogPublicationOutbox_dedupeKey_key" ON "CatalogPublicationOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "CatalogPublicationOutbox_dequeue_idx" ON "CatalogPublicationOutbox"("status", "nextAttemptAt", "venueId", "venueSequence");

-- CreateIndex
CREATE INDEX "CatalogPublicationOutbox_status_claimExpiresAt_idx" ON "CatalogPublicationOutbox"("status", "claimExpiresAt");

-- CreateIndex
CREATE INDEX "CatalogPublicationOutbox_batchId_organizationId_idx" ON "CatalogPublicationOutbox"("batchId", "organizationId");

-- CreateIndex
CREATE INDEX "CatalogPublicationOutbox_venueId_venueSequence_idx" ON "CatalogPublicationOutbox"("venueId", "venueSequence");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogPublicationOutbox_organizationId_venueId_venueSequen_key" ON "CatalogPublicationOutbox"("organizationId", "venueId", "venueSequence");

-- Only new-table-to-new-table FKs belong in the core Simple Query. Edges to
-- hot legacy parents are added NOT VALID in the bounded per-child migrations.

ALTER TABLE "CatalogFamily" ADD CONSTRAINT "CatalogFamily_parentId_organizationId_fkey" FOREIGN KEY ("parentId", "organizationId") REFERENCES "CatalogFamily"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_brandId_organizationId_fkey" FOREIGN KEY ("brandId", "organizationId") REFERENCES "CatalogBrand"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_manufacturerId_organizationId_fkey" FOREIGN KEY ("manufacturerId", "organizationId") REFERENCES "CatalogManufacturer"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_familyId_organizationId_fkey" FOREIGN KEY ("familyId", "organizationId") REFERENCES "CatalogFamily"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CatalogItemBusinessType" ADD CONSTRAINT "CatalogItemBusinessType_catalogItemId_organizationId_fkey" FOREIGN KEY ("catalogItemId", "organizationId") REFERENCES "CatalogItem"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CatalogIdentifier" ADD CONSTRAINT "CatalogIdentifier_catalogItem_tenant_fkey" FOREIGN KEY ("catalogItemId", "organizationId") REFERENCES "CatalogItem"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CatalogItemPrice" ADD CONSTRAINT "CatalogItemPrice_catalogItem_tenant_fkey" FOREIGN KEY ("catalogItemId", "organizationId") REFERENCES "CatalogItem"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CatalogVenueBinding" ADD CONSTRAINT "CatalogVenueBinding_catalogItem_tenant_fkey" FOREIGN KEY ("catalogItemId", "organizationId") REFERENCES "CatalogItem"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CatalogVenueOverride" ADD CONSTRAINT "CatalogVenueOverride_bindingId_organizationId_fkey" FOREIGN KEY ("bindingId", "organizationId", "venueId") REFERENCES "CatalogVenueBinding"("id", "organizationId", "venueId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Request lineage is tenant-safe; the companion trigger below freezes the
-- referenced idempotency operation as CATALOG_OVERRIDE_REQUEST.
ALTER TABLE "CatalogVenueOverride" ADD CONSTRAINT "CatalogVenueOverride_request_batch_tenant_fkey" FOREIGN KEY ("requestBatchId", "organizationId") REFERENCES "CatalogIdempotencyRecord"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CatalogVenueOverride" ADD CONSTRAINT "CatalogVenueOverride_superseded_by_tenant_field_fkey" FOREIGN KEY ("supersededByOverrideId", "organizationId", "bindingId", "field") REFERENCES "CatalogVenueOverride"("id", "organizationId", "bindingId", "field") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "CatalogImportLine" ADD CONSTRAINT "CatalogImportLine_batch_tenant_fkey" FOREIGN KEY ("batchId", "organizationId") REFERENCES "CatalogImportBatch"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CatalogImportLine" ADD CONSTRAINT "CatalogImportLine_catalogItemId_organizationId_fkey" FOREIGN KEY ("catalogItemId", "organizationId") REFERENCES "CatalogItem"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CatalogBindingLine" ADD CONSTRAINT "CatalogBindingLine_batch_tenant_fkey" FOREIGN KEY ("batchId", "organizationId") REFERENCES "CatalogBindingBatch"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CatalogBindingLine" ADD CONSTRAINT "CatalogBindingLine_catalogItemId_organizationId_fkey" FOREIGN KEY ("catalogItemId", "organizationId") REFERENCES "CatalogItem"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CatalogPublicationLine" ADD CONSTRAINT "CatalogPublicationLine_batch_tenant_fkey" FOREIGN KEY ("batchId", "organizationId") REFERENCES "CatalogPublicationBatch"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Individual binding unlink cannot erase publication history. Full Venue/org
-- deletion removes both sides and is accepted when this deferred FK checks.
ALTER TABLE "CatalogPublicationLine" ADD CONSTRAINT "CatalogPublicationLine_binding_tenant_fkey"
  FOREIGN KEY ("bindingId", "organizationId", "venueId", "catalogItemId", "productId")
  REFERENCES "CatalogVenueBinding"("id", "organizationId", "venueId", "catalogItemId", "productId")
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "CatalogPublicationLine" ADD CONSTRAINT "CatalogPublicationLine_catalogItemId_organizationId_fkey" FOREIGN KEY ("catalogItemId", "organizationId") REFERENCES "CatalogItem"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CatalogPublicationLine" ADD CONSTRAINT "CatalogPublicationLine_supersedes_tenant_binding_fkey" FOREIGN KEY ("supersedesLineId", "organizationId", "bindingId") REFERENCES "CatalogPublicationLine"("id", "organizationId", "bindingId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "CatalogPublicationLine" ADD CONSTRAINT "CatalogPublicationLine_reverses_tenant_binding_fkey" FOREIGN KEY ("reversesLineId", "organizationId", "bindingId") REFERENCES "CatalogPublicationLine"("id", "organizationId", "bindingId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Field decisions inherit tenant/binding identity from their line, and any
-- override provenance must match that exact tenant, binding, and field.

ALTER TABLE "CatalogPublicationFieldDecision" ADD CONSTRAINT "CatalogPublicationFieldDecision_line_tenant_binding_fkey" FOREIGN KEY ("lineId", "organizationId", "bindingId") REFERENCES "CatalogPublicationLine"("id", "organizationId", "bindingId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CatalogPublicationFieldDecision" ADD CONSTRAINT "CatalogPublicationFieldDecision_override_tenant_field_fkey" FOREIGN KEY ("overrideId", "organizationId", "bindingId", "field") REFERENCES "CatalogVenueOverride"("id", "organizationId", "bindingId", "field") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "CatalogPublicationOutbox" ADD CONSTRAINT "CatalogPublicationOutbox_batchId_organizationId_fkey" FOREIGN KEY ("batchId", "organizationId") REFERENCES "CatalogPublicationBatch"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Cross-column invariants Prisma cannot express
-- ---------------------------------------------------------------------------

-- Entitlements and catalog values are append-safe, versioned, and bounded;
-- these checks reject impossible intervals and invalid revision counters.
ALTER TABLE "OrganizationEntitlement"
  ADD CONSTRAINT "OrganizationEntitlement_validity_window_check"
  CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt");

ALTER TABLE "CatalogBrand"
  ADD CONSTRAINT "CatalogBrand_revision_check" CHECK ("revision" >= 1);
ALTER TABLE "CatalogManufacturer"
  ADD CONSTRAINT "CatalogManufacturer_revision_check" CHECK ("revision" >= 1);
ALTER TABLE "CatalogFamily"
  ADD CONSTRAINT "CatalogFamily_revision_check" CHECK ("revision" >= 1);

ALTER TABLE "CatalogItem"
  ADD CONSTRAINT "CatalogItem_revision_check" CHECK ("revision" >= 1),
  ADD CONSTRAINT "CatalogItem_invariant_version_check" CHECK ("invariantVersion" >= 0),
  ADD CONSTRAINT "CatalogItem_tax_rate_check" CHECK ("taxRate" IS NULL OR ("taxRate" >= 0 AND "taxRate" <= 1)),
  ADD CONSTRAINT "CatalogItem_ieps_shape_check" CHECK (
    ("iepsMode" = 'NONE' AND "iepsRate" IS NULL AND "iepsQuota" IS NULL AND "iepsQuotaUnit" IS NULL)
    OR ("iepsMode" = 'RATE' AND "iepsRate" IS NOT NULL AND "iepsRate" >= 0 AND "iepsRate" <= 1 AND "iepsQuota" IS NULL AND "iepsQuotaUnit" IS NULL)
    OR ("iepsMode" = 'QUOTA' AND "iepsRate" IS NULL AND "iepsQuota" IS NOT NULL AND "iepsQuota" >= 0 AND "iepsQuotaUnit" IS NOT NULL)
    OR ("iepsMode" = 'BOTH' AND "iepsRate" IS NOT NULL AND "iepsRate" >= 0 AND "iepsRate" <= 1 AND "iepsQuota" IS NOT NULL AND "iepsQuota" >= 0 AND "iepsQuotaUnit" IS NOT NULL)
  );

ALTER TABLE "CatalogProductTypeMapping"
  ADD CONSTRAINT "CatalogProductTypeMapping_version_check" CHECK ("mappingVersion" >= 1);
ALTER TABLE "CatalogValidationProfile"
  ADD CONSTRAINT "CatalogValidationProfile_version_check" CHECK ("profileVersion" >= 1 AND "rulesSchemaVersion" >= 1);
ALTER TABLE "CatalogItemPrice"
  ADD CONSTRAINT "CatalogItemPrice_amount_check" CHECK ("amount" >= 0 AND "amount" <= 99999999.99),
  ADD CONSTRAINT "CatalogItemPrice_revision_check" CHECK ("revision" >= 1);

-- Rollout and readiness remain inert by default. Counters cannot regress below
-- their initial values, and classified overrides retain revocation evidence.
ALTER TABLE "CatalogVenueRollout"
  ADD CONSTRAINT "CatalogVenueRollout_identifier_revision_check" CHECK ("identifierRevision" >= 0);
ALTER TABLE "CatalogVenueClientRequirement"
  ADD CONSTRAINT "CatalogVenueClientRequirement_age_check" CHECK ("maxObservationAgeDays" > 0),
  ADD CONSTRAINT "CatalogVenueClientRequirement_mode_check" CHECK (
    ("mode" = 'REQUIRED' AND ("minimumVersion" ~ '[^[:space:]]') IS TRUE)
    OR ("mode" = 'NOT_APPLICABLE' AND "minimumVersion" IS NULL)
  );
ALTER TABLE "CatalogClientReadinessOverride"
  ADD CONSTRAINT "CatalogClientReadinessOverride_revocation_check" CHECK (
    ("status" = 'REVOKED' AND "revokedById" IS NOT NULL AND "revokedAt" IS NOT NULL AND ("revocationReason" ~ '[^[:space:]]') IS TRUE)
    OR ("status" <> 'REVOKED' AND "revokedById" IS NULL AND "revokedAt" IS NULL AND "revocationReason" IS NULL)
  );

ALTER TABLE "CatalogVenueBinding"
  ADD CONSTRAINT "CatalogVenueBinding_revision_check" CHECK ("revision" >= 1),
  ADD CONSTRAINT "CatalogVenueBinding_linked_product_check" CHECK ("status" <> 'LINKED' OR "productId" IS NOT NULL),
  ADD CONSTRAINT "CatalogVenueBinding_managed_hash_shape_check" CHECK (
    "lastPublishedManagedHash" IS NULL OR "lastPublishedManagedHash" ~ '^[0-9a-f]{64}$'
  );

-- Overrides retain every maker/checker and supersession edge. DETECTED is the
-- only pre-request state; all later states preserve the originating request.
ALTER TABLE "CatalogVenueOverride"
  ADD CONSTRAINT "CatalogVenueOverride_nonempty_field_reason_check" CHECK (
    ("field" ~ '[^[:space:]]') IS TRUE AND ("reason" ~ '[^[:space:]]') IS TRUE
  ),
  ADD CONSTRAINT "CatalogVenueOverride_lifecycle_check" CHECK (
    (
      "status" = 'DETECTED'
      AND "requestBatchId" IS NULL AND "requestedById" IS NULL AND "requestedAt" IS NULL
      AND "decidedById" IS NULL AND "decidedAt" IS NULL
      AND "supersededByOverrideId" IS NULL AND "supersededAt" IS NULL
    )
    OR (
      "status" = 'REQUESTED'
      AND "requestBatchId" IS NOT NULL AND "requestedById" IS NOT NULL AND "requestedAt" IS NOT NULL
      AND "decidedById" IS NULL AND "decidedAt" IS NULL
      AND "supersededByOverrideId" IS NULL AND "supersededAt" IS NULL
    )
    OR (
      "status" IN ('APPROVED', 'REJECTED')
      AND "requestBatchId" IS NOT NULL AND "requestedById" IS NOT NULL AND "requestedAt" IS NOT NULL
      AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL
      AND "requestedById" <> "decidedById"
      AND "supersededByOverrideId" IS NULL AND "supersededAt" IS NULL
    )
    OR (
      "status" = 'SUPERSEDED'
      AND "requestBatchId" IS NOT NULL AND "requestedById" IS NOT NULL AND "requestedAt" IS NOT NULL
      AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL
      AND "requestedById" <> "decidedById"
      AND "supersededByOverrideId" IS NOT NULL AND "supersededAt" IS NOT NULL
      AND "supersededByOverrideId" <> "id"
    )
  );

CREATE FUNCTION "assert_catalog_override_request_operation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  request_operation TEXT;
BEGIN
  IF NEW."requestBatchId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "operation"
    INTO request_operation
    FROM "CatalogIdempotencyRecord"
   WHERE "id" = NEW."requestBatchId"
     AND "organizationId" = NEW."organizationId"
   FOR KEY SHARE;

  -- A missing/cross-tenant row is reported by the tenant FK. This trigger owns
  -- only the operation discriminator and takes a stable key-share lock.
  IF FOUND AND request_operation <> 'CATALOG_OVERRIDE_REQUEST' THEN
    RAISE EXCEPTION 'override request batch must use CATALOG_OVERRIDE_REQUEST'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogVenueOverride_request_operation_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CatalogVenueOverride_request_operation_trigger"
BEFORE INSERT OR UPDATE OF "requestBatchId", "organizationId" ON "CatalogVenueOverride"
FOR EACH ROW EXECUTE FUNCTION "assert_catalog_override_request_operation"();

-- Shape checks are not a state machine by themselves. This guard prevents
-- terminal history from being rewritten and freezes captured request identity.
CREATE FUNCTION "guard_catalog_override_transition"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('DETECTED', 'REQUESTED') THEN
      RAISE EXCEPTION 'override must enter as DETECTED or REQUESTED'
        USING ERRCODE = '23514', CONSTRAINT = 'CatalogVenueOverride_transition_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."bindingId" IS DISTINCT FROM OLD."bindingId"
     OR NEW."venueId" IS DISTINCT FROM OLD."venueId"
     OR NEW."field" IS DISTINCT FROM OLD."field"
     OR NEW."localValue" IS DISTINCT FROM OLD."localValue"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" THEN
    RAISE EXCEPTION 'override captured identity and value are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogVenueOverride_transition_check';
  END IF;

  IF NOT (
    (OLD."status" = 'DETECTED' AND NEW."status" IN ('DETECTED', 'REQUESTED'))
    OR (OLD."status" = 'REQUESTED' AND NEW."status" IN ('REQUESTED', 'APPROVED', 'REJECTED'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('APPROVED', 'SUPERSEDED'))
    OR (OLD."status" = 'REJECTED' AND NEW."status" = 'REJECTED')
    OR (OLD."status" = 'SUPERSEDED' AND NEW."status" = 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION 'invalid override lifecycle transition'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogVenueOverride_transition_check';
  END IF;

  IF OLD."status" <> 'DETECTED' AND (
    NEW."requestBatchId" IS DISTINCT FROM OLD."requestBatchId"
    OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
    OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
  ) THEN
    RAISE EXCEPTION 'override request lineage is immutable after request'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogVenueOverride_transition_check';
  END IF;

  IF OLD."status" IN ('APPROVED', 'REJECTED', 'SUPERSEDED') AND (
    NEW."decidedById" IS DISTINCT FROM OLD."decidedById"
    OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
  ) THEN
    RAISE EXCEPTION 'override decision lineage is immutable after decision'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogVenueOverride_transition_check';
  END IF;

  IF OLD."status" = 'SUPERSEDED' AND (
    NEW."supersededByOverrideId" IS DISTINCT FROM OLD."supersededByOverrideId"
    OR NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt"
  ) THEN
    RAISE EXCEPTION 'override supersession lineage is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogVenueOverride_transition_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CatalogVenueOverride_transition_trigger"
BEFORE INSERT OR UPDATE ON "CatalogVenueOverride"
FOR EACH ROW EXECUTE FUNCTION "guard_catalog_override_transition"();

-- An idempotency key's operation is identity, not mutable state. Freezing it
-- closes the inverse race after an override has validated its request batch.
CREATE FUNCTION "guard_catalog_idempotency_operation_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."operation" IS DISTINCT FROM OLD."operation" THEN
    RAISE EXCEPTION 'catalog idempotency operation is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogIdempotencyRecord_operation_immutable_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CatalogIdempotencyRecord_operation_immutable_trigger"
BEFORE UPDATE OF "operation" ON "CatalogIdempotencyRecord"
FOR EACH ROW EXECUTE FUNCTION "guard_catalog_idempotency_operation_identity"();

CREATE FUNCTION "assert_catalog_override_supersession"(override_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  current_override RECORD;
BEGIN
  SELECT "status", "organizationId", "bindingId", "field", "supersededByOverrideId"
    INTO current_override
    FROM "CatalogVenueOverride"
   WHERE "id" = override_id;
  IF NOT FOUND OR current_override."status" <> 'SUPERSEDED' THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM "CatalogVenueOverride" replacement
     WHERE replacement."id" = current_override."supersededByOverrideId"
       AND replacement."organizationId" = current_override."organizationId"
       AND replacement."bindingId" = current_override."bindingId"
       AND replacement."field" = current_override."field"
       AND replacement."status" IN ('APPROVED', 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION 'superseded override must point to approved override history'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogVenueOverride_supersession_check';
  END IF;

  IF EXISTS (
    WITH RECURSIVE supersession_chain AS (
      SELECT current_row."id", current_row."supersededByOverrideId", ARRAY[current_row."id"]::TEXT[] AS path, false AS cycle
        FROM "CatalogVenueOverride" current_row
       WHERE current_row."id" = override_id
      UNION ALL
      SELECT next_row."id", next_row."supersededByOverrideId",
             chain.path || next_row."id", next_row."id" = ANY(chain.path)
        FROM supersession_chain chain
        JOIN "CatalogVenueOverride" next_row ON next_row."id" = chain."supersededByOverrideId"
       WHERE NOT chain.cycle
    )
    SELECT 1 FROM supersession_chain WHERE cycle
  ) THEN
    RAISE EXCEPTION 'override supersession chain cannot contain a cycle'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogVenueOverride_supersession_check';
  END IF;
END;
$$;

CREATE FUNCTION "check_catalog_override_supersession"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM "assert_catalog_override_supersession"(OLD."id");
    FOR affected_id IN
      SELECT "id" FROM "CatalogVenueOverride"
       WHERE "supersededByOverrideId" = OLD."id"
       ORDER BY "id"
    LOOP
      PERFORM "assert_catalog_override_supersession"(affected_id);
    END LOOP;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    PERFORM "assert_catalog_override_supersession"(NEW."id");
    FOR affected_id IN
      SELECT "id" FROM "CatalogVenueOverride"
       WHERE "supersededByOverrideId" = NEW."id"
       ORDER BY "id"
    LOOP
      PERFORM "assert_catalog_override_supersession"(affected_id);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "CatalogVenueOverride_supersession_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "CatalogVenueOverride"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_catalog_override_supersession"();

-- Request/decision history is deletable only as part of the explicit
-- Venue-owned purge. At deferred-check time a surviving Venue distinguishes
-- an accidental leaf/batch delete from the complete cascade.
CREATE FUNCTION "guard_catalog_override_durable_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" IN ('REQUESTED', 'APPROVED', 'REJECTED', 'SUPERSEDED')
     AND EXISTS (
       SELECT 1
         FROM "Venue"
        WHERE "id" = OLD."venueId"
          AND "organizationId" = OLD."organizationId"
     ) THEN
    RAISE EXCEPTION 'requested or decided override history cannot be deleted while its Venue exists'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogVenueOverride_durable_delete_check';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "CatalogVenueOverride_durable_delete_constraint_trigger"
AFTER DELETE ON "CatalogVenueOverride"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "guard_catalog_override_durable_delete"();

-- Every generic command is attributed and versioned. APPLYING rows must carry
-- a complete lease tuple so executors and watchdogs can use the same CAS fence.
-- Preview rows may name the resource type before an ID exists; NOT_STARTED and
-- APPLIED rows cannot retain that otherwise ambiguous half-reference.
ALTER TABLE "CatalogIdempotencyRecord"
  ADD CONSTRAINT "CatalogIdempotencyRecord_actor_identity_check" CHECK (
    (
      ("actorType" = 'HUMAN' AND ("staffId" ~ '[^[:space:]]') IS TRUE AND "servicePrincipalId" IS NULL)
      OR ("actorType" = 'SERVICE' AND "staffId" IS NULL AND ("servicePrincipalId" ~ '[^[:space:]]') IS TRUE)
    ) IS TRUE
  ),
  ADD CONSTRAINT "CatalogIdempotencyRecord_resource_reference_check" CHECK (
    (
      ("resourceType" IS NULL AND "resourceId" IS NULL)
      OR (("resourceType" ~ '[^[:space:]]') IS TRUE AND ("resourceId" ~ '[^[:space:]]') IS TRUE)
      OR (
        ("resourceType" ~ '[^[:space:]]') IS TRUE
        AND "resourceId" IS NULL
        AND "state" IN ('PREVIEWED', 'APPLYING', 'FAILED', 'EXPIRED', 'SUPERSEDED')
      )
    ) IS TRUE
  ),
  ADD CONSTRAINT "CatalogIdempotencyRecord_request_hash_version_check" CHECK ("requestHashVersion" >= 1),
  ADD CONSTRAINT "CatalogIdempotencyRecord_hash_shape_check" CHECK (
    "requestHash" ~ '^[0-9a-f]{64}$'
    AND ("targetHash" IS NULL OR "targetHash" ~ '^[0-9a-f]{64}$')
    AND ("previewTokenHash" IS NULL OR "previewTokenHash" ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "CatalogIdempotencyRecord_preview_snapshot_check" CHECK (
    ("targetHash" IS NULL AND "previewTokenHash" IS NULL AND "previewExpiresAt" IS NULL AND "dependencies" IS NULL)
    OR (
      "targetHash" IS NOT NULL AND "previewTokenHash" IS NOT NULL AND "previewExpiresAt" IS NOT NULL
      AND "dependencies" IS NOT NULL AND "dependencies" <> 'null'::jsonb
      AND "previewExpiresAt" > "createdAt"
    )
  ),
  ADD CONSTRAINT "CatalogIdempotencyRecord_state_shape_check" CHECK (
    (
      "state" = 'NOT_STARTED'
      AND "targetHash" IS NULL AND "previewTokenHash" IS NULL AND "previewExpiresAt" IS NULL AND "dependencies" IS NULL
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "result" IS NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL AND "completedAt" IS NULL
    )
    OR (
      "state" = 'PREVIEWED'
      AND "targetHash" IS NOT NULL AND "previewTokenHash" IS NOT NULL AND "previewExpiresAt" IS NOT NULL
      AND "dependencies" IS NOT NULL AND "dependencies" <> 'null'::jsonb
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "result" IS NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL AND "completedAt" IS NULL
    )
    OR (
      "state" = 'APPLYING'
      AND "targetHash" IS NOT NULL AND "previewTokenHash" IS NOT NULL AND "previewExpiresAt" IS NOT NULL
      AND "dependencies" IS NOT NULL AND "dependencies" <> 'null'::jsonb
      AND ("attemptId" ~ '[^[:space:]]') IS TRUE AND "leaseExpiresAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL
      AND "leaseExpiresAt" > "heartbeatAt"
      AND "result" IS NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL AND "completedAt" IS NULL
    )
    OR (
      "state" = 'APPLIED'
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "completedAt" IS NOT NULL
      AND (("result" IS NOT NULL AND "result" <> 'null'::jsonb) OR ("resourceType" IS NOT NULL AND "resourceId" IS NOT NULL))
      AND "failureCode" IS NULL AND "failureMessage" IS NULL
    )
    OR (
      "state" = 'FAILED'
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "completedAt" IS NOT NULL AND "result" IS NULL
      AND ("failureCode" ~ '[^[:space:]]') IS TRUE
      AND ("failureMessage" ~ '[^[:space:]]') IS TRUE
    )
    OR (
      "state" IN ('EXPIRED', 'SUPERSEDED')
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "completedAt" IS NOT NULL AND "result" IS NULL
      AND "failureCode" IS NULL AND "failureMessage" IS NULL
    )
  );

ALTER TABLE "CatalogImportBatch"
  ADD CONSTRAINT "CatalogImportBatch_actor_identity_check" CHECK (
    (
      ("actorType" = 'HUMAN' AND ("staffId" ~ '[^[:space:]]') IS TRUE AND "servicePrincipalId" IS NULL)
      OR ("actorType" = 'SERVICE' AND "staffId" IS NULL AND ("servicePrincipalId" ~ '[^[:space:]]') IS TRUE)
    ) IS TRUE
  ),
  ADD CONSTRAINT "CatalogImportBatch_versions_check" CHECK ("schemaVersion" >= 1 AND "requestHashVersion" >= 1),
  ADD CONSTRAINT "CatalogImportBatch_hash_shape_check" CHECK (
    ("fileSha256" IS NULL OR "fileSha256" ~ '^[0-9a-f]{64}$')
    AND "requestHash" ~ '^[0-9a-f]{64}$'
    AND "targetHash" ~ '^[0-9a-f]{64}$'
    AND "previewTokenHash" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "CatalogImportBatch_preview_snapshot_check" CHECK (
    "dependencies" <> 'null'::jsonb AND "previewExpiresAt" > "createdAt"
  ),
  ADD CONSTRAINT "CatalogImportBatch_state_shape_check" CHECK (
    (
      "state" IN ('NOT_STARTED', 'PREVIEWED')
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "result" IS NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL
      AND "appliedAt" IS NULL AND "completedAt" IS NULL
    )
    OR (
      "state" = 'APPLYING'
      AND ("attemptId" ~ '[^[:space:]]') IS TRUE AND "leaseExpiresAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL
      AND "leaseExpiresAt" > "heartbeatAt"
      AND "result" IS NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL
      AND "appliedAt" IS NULL AND "completedAt" IS NULL
    )
    OR (
      "state" = 'APPLIED'
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "result" IS NOT NULL AND "result" <> 'null'::jsonb AND "failureCode" IS NULL AND "failureMessage" IS NULL
      AND "appliedAt" IS NOT NULL AND "completedAt" IS NOT NULL
    )
    OR (
      "state" = 'FAILED'
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "result" IS NULL AND "appliedAt" IS NULL AND "completedAt" IS NOT NULL
      AND ("failureCode" ~ '[^[:space:]]') IS TRUE AND ("failureMessage" ~ '[^[:space:]]') IS TRUE
    )
    OR (
      "state" IN ('EXPIRED', 'SUPERSEDED')
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "result" IS NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL
      AND "appliedAt" IS NULL AND "completedAt" IS NOT NULL
    )
  );

ALTER TABLE "CatalogBindingBatch"
  ADD CONSTRAINT "CatalogBindingBatch_actor_identity_check" CHECK (
    (
      ("actorType" = 'HUMAN' AND ("staffId" ~ '[^[:space:]]') IS TRUE AND "servicePrincipalId" IS NULL)
      OR ("actorType" = 'SERVICE' AND "staffId" IS NULL AND ("servicePrincipalId" ~ '[^[:space:]]') IS TRUE)
    ) IS TRUE
  ),
  ADD CONSTRAINT "CatalogBindingBatch_versions_check" CHECK ("schemaVersion" >= 1 AND "requestHashVersion" >= 1),
  ADD CONSTRAINT "CatalogBindingBatch_hash_shape_check" CHECK (
    "requestHash" ~ '^[0-9a-f]{64}$'
    AND "targetHash" ~ '^[0-9a-f]{64}$'
    AND "previewTokenHash" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "CatalogBindingBatch_preview_snapshot_check" CHECK (
    "dependencies" <> 'null'::jsonb AND "previewExpiresAt" > "createdAt"
  ),
  ADD CONSTRAINT "CatalogBindingBatch_state_shape_check" CHECK (
    (
      "state" IN ('NOT_STARTED', 'PREVIEWED')
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "result" IS NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL
      AND "appliedAt" IS NULL AND "completedAt" IS NULL
    )
    OR (
      "state" = 'APPLYING'
      AND ("attemptId" ~ '[^[:space:]]') IS TRUE AND "leaseExpiresAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL
      AND "leaseExpiresAt" > "heartbeatAt"
      AND "result" IS NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL
      AND "appliedAt" IS NULL AND "completedAt" IS NULL
    )
    OR (
      "state" = 'APPLIED'
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "result" IS NOT NULL AND "result" <> 'null'::jsonb AND "failureCode" IS NULL AND "failureMessage" IS NULL
      AND "appliedAt" IS NOT NULL AND "completedAt" IS NOT NULL
    )
    OR (
      "state" = 'FAILED'
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "result" IS NULL AND "appliedAt" IS NULL AND "completedAt" IS NOT NULL
      AND ("failureCode" ~ '[^[:space:]]') IS TRUE AND ("failureMessage" ~ '[^[:space:]]') IS TRUE
    )
    OR (
      "state" IN ('EXPIRED', 'SUPERSEDED')
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "result" IS NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL
      AND "appliedAt" IS NULL AND "completedAt" IS NOT NULL
    )
  );

ALTER TABLE "CatalogPublicationBatch"
  ADD CONSTRAINT "CatalogPublicationBatch_actor_identity_check" CHECK (
    (
      ("actorType" = 'HUMAN' AND ("staffId" ~ '[^[:space:]]') IS TRUE AND "servicePrincipalId" IS NULL)
      OR ("actorType" = 'SERVICE' AND "staffId" IS NULL AND ("servicePrincipalId" ~ '[^[:space:]]') IS TRUE)
    ) IS TRUE
  ),
  ADD CONSTRAINT "CatalogPublicationBatch_versions_check" CHECK ("schemaVersion" >= 1 AND "requestHashVersion" >= 1),
  ADD CONSTRAINT "CatalogPublicationBatch_hash_shape_check" CHECK (
    "requestHash" ~ '^[0-9a-f]{64}$'
    AND "targetHash" ~ '^[0-9a-f]{64}$'
    AND "previewTokenHash" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "CatalogPublicationBatch_preview_snapshot_check" CHECK (
    "dependencies" <> 'null'::jsonb AND "previewExpiresAt" > "createdAt"
  ),
  ADD CONSTRAINT "CatalogPublicationBatch_state_shape_check" CHECK (
    (
      "state" IN ('NOT_STARTED', 'PREVIEWED')
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "result" IS NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL
      AND "appliedAt" IS NULL AND "completedAt" IS NULL
    )
    OR (
      "state" = 'APPLYING'
      AND ("attemptId" ~ '[^[:space:]]') IS TRUE AND "leaseExpiresAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL
      AND "leaseExpiresAt" > "heartbeatAt"
      AND "result" IS NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL
      AND "appliedAt" IS NULL AND "completedAt" IS NULL
    )
    OR (
      "state" = 'APPLIED'
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "result" IS NOT NULL AND "result" <> 'null'::jsonb AND "failureCode" IS NULL AND "failureMessage" IS NULL
      AND "appliedAt" IS NOT NULL AND "completedAt" IS NOT NULL
    )
    OR (
      "state" = 'FAILED'
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "result" IS NULL AND "appliedAt" IS NULL AND "completedAt" IS NOT NULL
      AND ("failureCode" ~ '[^[:space:]]') IS TRUE AND ("failureMessage" ~ '[^[:space:]]') IS TRUE
    )
    OR (
      "state" IN ('EXPIRED', 'SUPERSEDED')
      AND "attemptId" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL
      AND "result" IS NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL
      AND "appliedAt" IS NULL AND "completedAt" IS NOT NULL
    )
  );

ALTER TABLE "CatalogImportLine"
  ADD CONSTRAINT "CatalogImportLine_source_row_check" CHECK ("sourceRow" >= 1);
ALTER TABLE "CatalogPublicationLine"
  ADD CONSTRAINT "CatalogPublicationLine_versions_check" CHECK (
    "decisionSchemaVersion" >= 1 AND "hashVersion" >= 1 AND "sourceCatalogRevision" >= 1
    AND "decisionInvariantVersion" >= 0
    AND ("bindingRevision" IS NULL OR "bindingRevision" >= 1)
  ),
  ADD CONSTRAINT "CatalogPublicationLine_hash_shape_check" CHECK (
    "canonicalTargetHash" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "CatalogPublicationLine_lineage_shape_check" CHECK (
    ("supersedesLineId" IS NULL OR "supersedesLineId" <> "id")
    AND ("reversesLineId" IS NULL OR "reversesLineId" <> "id")
    AND (
      ("changeKind" = 'PUBLICATION' AND "reversesLineId" IS NULL)
      OR ("changeKind" = 'REVERSION' AND "supersedesLineId" IS NOT NULL AND "reversesLineId" IS NOT NULL)
    )
  );

ALTER TABLE "CatalogPublicationFieldDecision"
  ADD CONSTRAINT "CatalogPublicationFieldDecision_nonempty_field_check" CHECK (("field" ~ '[^[:space:]]') IS TRUE),
  ADD CONSTRAINT "CatalogPublicationFieldDecision_value_shape_check" CHECK (
    ("decision" = 'PUBLISH_CORPORATE' AND "overrideId" IS NULL AND "after" = "proposed")
    OR (
      "decision" = 'APPROVE_LOCAL_OVERRIDE'
      AND "overrideId" IS NOT NULL AND "after" = "before"
    )
    OR ("decision" = 'UNDECIDED' AND "overrideId" IS NULL)
  );

-- FieldDecision statements serialize through every affected parent line in
-- one global order. Transition tables avoid opposite row-order deadlocks for
-- bulk statements while preserving RC rechecks and RR write-conflict aborts.
CREATE FUNCTION "bump_catalog_publication_decision_invariant_version_from_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_line_id TEXT;
BEGIN
  FOR affected_line_id IN
    SELECT DISTINCT "lineId" FROM new_rows WHERE "lineId" IS NOT NULL ORDER BY "lineId"
  LOOP
    UPDATE "CatalogPublicationLine"
       SET "decisionInvariantVersion" = "decisionInvariantVersion" + 1
     WHERE "id" = affected_line_id;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "bump_catalog_publication_decision_invariant_version_from_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_line_id TEXT;
BEGIN
  FOR affected_line_id IN
    SELECT "lineId" FROM old_rows WHERE "lineId" IS NOT NULL
    UNION
    SELECT "lineId" FROM new_rows WHERE "lineId" IS NOT NULL
    ORDER BY 1
  LOOP
    UPDATE "CatalogPublicationLine"
       SET "decisionInvariantVersion" = "decisionInvariantVersion" + 1
     WHERE "id" = affected_line_id;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "bump_catalog_publication_decision_invariant_version_from_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_line_id TEXT;
BEGIN
  FOR affected_line_id IN
    SELECT DISTINCT "lineId" FROM old_rows WHERE "lineId" IS NOT NULL ORDER BY "lineId"
  LOOP
    UPDATE "CatalogPublicationLine"
       SET "decisionInvariantVersion" = "decisionInvariantVersion" + 1
     WHERE "id" = affected_line_id;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "CatalogPublicationDecision_invariant_version_insert_trigger"
AFTER INSERT ON "CatalogPublicationFieldDecision"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_catalog_publication_decision_invariant_version_from_insert"();

CREATE TRIGGER "CatalogPublicationDecision_invariant_version_update_trigger"
AFTER UPDATE ON "CatalogPublicationFieldDecision"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_catalog_publication_decision_invariant_version_from_update"();

CREATE TRIGGER "CatalogPublicationDecision_invariant_version_delete_trigger"
AFTER DELETE ON "CatalogPublicationFieldDecision"
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_catalog_publication_decision_invariant_version_from_delete"();

-- Once applied, a publication line is durable history. Child decisions also
-- hit this guard through their invariantVersion bump, so they cannot be edited
-- after application while full Venue deletion remains a separate cascade path.
CREATE FUNCTION "guard_applied_catalog_publication_line"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'APPLIED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'APPLIED publication line is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogPublicationLine_applied_immutable_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CatalogPublicationLine_applied_immutable_trigger"
BEFORE UPDATE ON "CatalogPublicationLine"
FOR EACH ROW EXECUTE FUNCTION "guard_applied_catalog_publication_line"();

-- A line can accumulate decisions while previewing, but APPLIED is terminal
-- provenance: no UNDECIDED rows, no duplicate mask entries, and exact set
-- equality between fieldMask and normalized decisions.
CREATE FUNCTION "assert_catalog_publication_line_decisions"(publication_line_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  line_status "CatalogPublicationLineStatus";
  line_field_mask TEXT[];
  supersedes_line_id TEXT;
  reverses_line_id TEXT;
  mask_count INTEGER;
  distinct_mask_count INTEGER;
  decision_count INTEGER;
BEGIN
  SELECT "status", COALESCE("fieldMask", ARRAY[]::TEXT[]), "supersedesLineId", "reversesLineId"
    INTO line_status, line_field_mask, supersedes_line_id, reverses_line_id
    FROM "CatalogPublicationLine"
   WHERE "id" = publication_line_id;
  IF NOT FOUND OR line_status <> 'APPLIED' THEN
    IF NOT FOUND THEN
      RETURN;
    END IF;
  END IF;

  IF (supersedes_line_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "CatalogPublicationLine" target
         WHERE target."id" = supersedes_line_id AND target."status" = 'APPLIED'
      ))
     OR (reverses_line_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "CatalogPublicationLine" target
         WHERE target."id" = reverses_line_id AND target."status" = 'APPLIED'
      )) THEN
    RAISE EXCEPTION 'every publication lineage target must be APPLIED'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogPublicationLine_lineage_target_check';
  END IF;

  -- REVERSION has two independent historical edges. UNION deduplicates every
  -- reachable ID globally, so convergent histories stay linear in graph size
  -- while a return to the new line still exposes mixed-edge cycles.
  IF EXISTS (
    WITH RECURSIVE reachable_line(line_id) AS (
      SELECT edge.next_id
        FROM "CatalogPublicationLine" current_line
        CROSS JOIN LATERAL (
          VALUES (current_line."supersedesLineId"), (current_line."reversesLineId")
        ) AS edge(next_id)
       WHERE current_line."id" = publication_line_id AND edge.next_id IS NOT NULL
      UNION
      SELECT edge.next_id
        FROM reachable_line reachable
        JOIN "CatalogPublicationLine" next_line ON next_line."id" = reachable.line_id
        CROSS JOIN LATERAL (
          VALUES (next_line."supersedesLineId"), (next_line."reversesLineId")
        ) AS edge(next_id)
       WHERE edge.next_id IS NOT NULL
    )
    SELECT 1 FROM reachable_line WHERE line_id = publication_line_id
  ) THEN
    RAISE EXCEPTION 'publication lineage cannot contain a cycle'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogPublicationLine_lineage_cycle_check';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "CatalogPublicationFieldDecision" decision_row
      LEFT JOIN "CatalogVenueOverride" override_row
        ON override_row."id" = decision_row."overrideId"
       AND override_row."organizationId" = decision_row."organizationId"
       AND override_row."bindingId" = decision_row."bindingId"
       AND override_row."field" = decision_row."field"
     WHERE decision_row."lineId" = publication_line_id
       AND decision_row."decision" = 'APPROVE_LOCAL_OVERRIDE'
       AND (override_row."id" IS NULL OR override_row."status" <> 'APPROVED')
  ) THEN
    RAISE EXCEPTION 'new local publication decision must reference the currently approved override'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogPublicationFieldDecision_approved_override_check';
  END IF;

  IF line_status <> 'APPLIED' THEN
    RETURN;
  END IF;

  mask_count := CARDINALITY(line_field_mask);
  SELECT COUNT(DISTINCT field)::INTEGER
    INTO distinct_mask_count
    FROM UNNEST(line_field_mask) AS mask(field)
   WHERE (field ~ '[^[:space:]]') IS TRUE;
  SELECT COUNT(*)::INTEGER
    INTO decision_count
    FROM "CatalogPublicationFieldDecision"
   WHERE "lineId" = publication_line_id
     AND "decision" <> 'UNDECIDED';

  IF mask_count = 0
     OR mask_count <> distinct_mask_count
     OR decision_count <> mask_count
     OR EXISTS (
       SELECT 1
         FROM "CatalogPublicationFieldDecision" decision_row
        WHERE decision_row."lineId" = publication_line_id
          AND (decision_row."decision" = 'UNDECIDED' OR NOT (decision_row."field" = ANY(line_field_mask)))
     )
     OR EXISTS (
       SELECT 1
         FROM UNNEST(line_field_mask) AS mask(field)
        WHERE NOT EXISTS (
          SELECT 1 FROM "CatalogPublicationFieldDecision" decision_row
           WHERE decision_row."lineId" = publication_line_id
             AND decision_row."field" = mask.field
             AND decision_row."decision" <> 'UNDECIDED'
        )
     ) THEN
    RAISE EXCEPTION 'APPLIED publication decisions must exactly match fieldMask'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogPublicationLine_applied_decisions_check';
  END IF;
END;
$$;

CREATE FUNCTION "check_catalog_publication_line_decisions_from_line"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM "assert_catalog_publication_line_decisions"(OLD."id");
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW."id" IS DISTINCT FROM OLD."id") THEN
    PERFORM "assert_catalog_publication_line_decisions"(NEW."id");
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM "assert_catalog_publication_line_decisions"(NEW."id");
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "check_catalog_publication_line_decisions_from_field"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM "assert_catalog_publication_line_decisions"(OLD."lineId");
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW."lineId" IS DISTINCT FROM OLD."lineId") THEN
    PERFORM "assert_catalog_publication_line_decisions"(NEW."lineId");
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM "assert_catalog_publication_line_decisions"(NEW."lineId");
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "CatalogPublicationLine_decisions_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "CatalogPublicationLine"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_catalog_publication_line_decisions_from_line"();

CREATE CONSTRAINT TRIGGER "CatalogPublicationFieldDecision_line_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "CatalogPublicationFieldDecision"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_catalog_publication_line_decisions_from_field"();

-- APPLIED line/decision provenance is durable until the owning Venue is
-- intentionally purged. This also blocks deleting a parent batch as a shortcut.
CREATE FUNCTION "guard_catalog_publication_line_durable_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'APPLIED'
     AND EXISTS (
       SELECT 1
         FROM "Venue"
        WHERE "id" = OLD."venueId"
          AND "organizationId" = OLD."organizationId"
     ) THEN
    RAISE EXCEPTION 'applied publication history cannot be deleted while its Venue exists'
      USING ERRCODE = '23514', CONSTRAINT = 'CatalogPublicationLine_durable_delete_check';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "CatalogPublicationLine_durable_delete_constraint_trigger"
AFTER DELETE ON "CatalogPublicationLine"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "guard_catalog_publication_line_durable_delete"();

ALTER TABLE "CatalogVenueEventSequence"
  ADD CONSTRAINT "CatalogVenueEventSequence_nonnegative_check" CHECK ("lastIssuedSequence" >= 0);

-- Claim columns form one lease tuple, delivery timestamps mirror terminal
-- status, and per-venue sequences start at one for actual emitted events.
ALTER TABLE "CatalogPublicationOutbox"
  ADD CONSTRAINT "CatalogPublicationOutbox_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "CatalogPublicationOutbox_versions_check" CHECK ("payloadVersion" >= 1 AND "venueSequence" >= 1),
  ADD CONSTRAINT "CatalogPublicationOutbox_identity_shape_check" CHECK (
    ("eventKind" ~ '[^[:space:]]') IS TRUE
    AND ("dedupeKey" ~ '[^[:space:]]') IS TRUE
    AND "payload" <> 'null'::jsonb
  ),
  ADD CONSTRAINT "CatalogPublicationOutbox_claim_tuple_check" CHECK (
    ("claimedBy" IS NULL AND "claimedAt" IS NULL AND "claimExpiresAt" IS NULL)
    OR (
      ("claimedBy" ~ '[^[:space:]]') IS TRUE
      AND "claimedAt" IS NOT NULL AND "claimExpiresAt" IS NOT NULL
      AND "claimExpiresAt" > "claimedAt"
    )
  ),
  ADD CONSTRAINT "CatalogPublicationOutbox_state_shape_check" CHECK (
    (
      "status" = 'PENDING'
      AND "deliveredAt" IS NULL
    )
    OR (
      "status" = 'DELIVERED'
      AND "deliveredAt" IS NOT NULL
      AND "claimedBy" IS NULL AND "claimedAt" IS NULL AND "claimExpiresAt" IS NULL
      AND "lastError" IS NULL
    )
    OR (
      "status" = 'DEAD_LETTER'
      AND "deliveredAt" IS NULL
      AND "claimedBy" IS NULL AND "claimedAt" IS NULL AND "claimExpiresAt" IS NULL
      AND ("lastError" ~ '[^[:space:]]') IS TRUE
    )
  );

-- Every child DML statement acquires all affected CatalogItem rows in one
-- sorted pass. Statement transition tables make that order global even when
-- two bulk writers visit the same aggregates in opposite physical row order.
CREATE FUNCTION "bump_catalog_item_invariant_version_from_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_item_id TEXT;
BEGIN
  FOR affected_item_id IN
    SELECT DISTINCT "catalogItemId" FROM new_rows WHERE "catalogItemId" IS NOT NULL ORDER BY "catalogItemId"
  LOOP
    UPDATE "CatalogItem"
       SET "invariantVersion" = "invariantVersion" + 1
     WHERE "id" = affected_item_id;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "bump_catalog_item_invariant_version_from_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_item_id TEXT;
BEGIN
  FOR affected_item_id IN
    SELECT "catalogItemId" FROM old_rows WHERE "catalogItemId" IS NOT NULL
    UNION
    SELECT "catalogItemId" FROM new_rows WHERE "catalogItemId" IS NOT NULL
    ORDER BY 1
  LOOP
    UPDATE "CatalogItem"
       SET "invariantVersion" = "invariantVersion" + 1
     WHERE "id" = affected_item_id;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "bump_catalog_item_invariant_version_from_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_item_id TEXT;
BEGIN
  FOR affected_item_id IN
    SELECT DISTINCT "catalogItemId" FROM old_rows WHERE "catalogItemId" IS NOT NULL ORDER BY "catalogItemId"
  LOOP
    UPDATE "CatalogItem"
       SET "invariantVersion" = "invariantVersion" + 1
     WHERE "id" = affected_item_id;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "CatalogIdentifier_invariant_version_insert_trigger"
AFTER INSERT ON "CatalogIdentifier"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_catalog_item_invariant_version_from_insert"();
CREATE TRIGGER "CatalogIdentifier_invariant_version_update_trigger"
AFTER UPDATE ON "CatalogIdentifier"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_catalog_item_invariant_version_from_update"();
CREATE TRIGGER "CatalogIdentifier_invariant_version_delete_trigger"
AFTER DELETE ON "CatalogIdentifier"
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_catalog_item_invariant_version_from_delete"();

CREATE TRIGGER "CatalogItemBusinessType_invariant_version_insert_trigger"
AFTER INSERT ON "CatalogItemBusinessType"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_catalog_item_invariant_version_from_insert"();
CREATE TRIGGER "CatalogItemBusinessType_invariant_version_update_trigger"
AFTER UPDATE ON "CatalogItemBusinessType"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_catalog_item_invariant_version_from_update"();
CREATE TRIGGER "CatalogItemBusinessType_invariant_version_delete_trigger"
AFTER DELETE ON "CatalogItemBusinessType"
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_catalog_item_invariant_version_from_delete"();

CREATE TRIGGER "CatalogItemPrice_invariant_version_insert_trigger"
AFTER INSERT ON "CatalogItemPrice"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_catalog_item_invariant_version_from_insert"();
CREATE TRIGGER "CatalogItemPrice_invariant_version_update_trigger"
AFTER UPDATE ON "CatalogItemPrice"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_catalog_item_invariant_version_from_update"();
CREATE TRIGGER "CatalogItemPrice_invariant_version_delete_trigger"
AFTER DELETE ON "CatalogItemPrice"
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_catalog_item_invariant_version_from_delete"();

-- CatalogItem owns corporate SKU mutations. The deferred check allows item and
-- projection writes in either order inside one transaction but rejects every
-- incomplete or divergent state at COMMIT, including RETIRED projections.
CREATE FUNCTION "assert_catalog_item_corporate_sku_projection"(item_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  item_normalized_sku TEXT;
  item_status TEXT;
  projection_count BIGINT;
  projection_normalized_code TEXT;
  projection_status TEXT;
BEGIN
  SELECT "normalizedSku", "status"::TEXT
    INTO item_normalized_sku, item_status
    FROM "CatalogItem"
   WHERE "id" = item_id
     FOR UPDATE;

  -- Cascading item deletes have no surviving invariant to validate.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*), MIN("normalizedCode"), MIN("status"::TEXT)
    INTO projection_count, projection_normalized_code, projection_status
    FROM "CatalogIdentifier"
   WHERE "catalogItemId" = item_id
     AND "type" = 'CORPORATE_SKU';

  IF projection_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CatalogItem_corporate_sku_projection_check',
      MESSAGE = 'CatalogItem must have exactly one CORPORATE_SKU projection';
  END IF;

  IF projection_normalized_code IS DISTINCT FROM item_normalized_sku THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CatalogItem_corporate_sku_projection_check',
      MESSAGE = 'CORPORATE_SKU normalizedCode must equal CatalogItem.normalizedSku';
  END IF;

  IF projection_status IS DISTINCT FROM item_status THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CatalogItem_corporate_sku_projection_check',
      MESSAGE = 'CORPORATE_SKU status must mirror CatalogItem.status';
  END IF;
END;
$$;

CREATE FUNCTION "enforce_catalog_item_corporate_sku_projection"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'CatalogItem' THEN
    IF TG_OP = 'DELETE' THEN
      PERFORM "assert_catalog_item_corporate_sku_projection"(OLD."id");
    ELSE
      PERFORM "assert_catalog_item_corporate_sku_projection"(NEW."id");
      IF TG_OP = 'UPDATE' AND OLD."id" IS DISTINCT FROM NEW."id" THEN
        PERFORM "assert_catalog_item_corporate_sku_projection"(OLD."id");
      END IF;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      PERFORM "assert_catalog_item_corporate_sku_projection"(OLD."catalogItemId");
    ELSIF TG_OP = 'INSERT' THEN
      PERFORM "assert_catalog_item_corporate_sku_projection"(NEW."catalogItemId");
    ELSE
      PERFORM "assert_catalog_item_corporate_sku_projection"(NEW."catalogItemId");
      IF OLD."catalogItemId" IS DISTINCT FROM NEW."catalogItemId" THEN
        PERFORM "assert_catalog_item_corporate_sku_projection"(OLD."catalogItemId");
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "CatalogItem_corporate_sku_projection_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "CatalogItem"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_catalog_item_corporate_sku_projection"();

CREATE CONSTRAINT TRIGGER "CatalogIdentifier_corporate_sku_projection_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "CatalogIdentifier"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_catalog_item_corporate_sku_projection"();

-- Authoritative items have no DRAFT state. This static relational baseline is
-- deferred so writers can assemble the aggregate in any order, while staging
-- remains the only place that may persist incomplete rows.
CREATE FUNCTION "assert_catalog_item_relational_baseline"(item_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  item_organization_id TEXT;
  has_business_type BOOLEAN;
  has_same_currency_price_pair BOOLEAN;
BEGIN
  SELECT "organizationId"
    INTO item_organization_id
    FROM "CatalogItem"
   WHERE "id" = item_id
     FOR UPDATE;

  -- Cascading child triggers run after the parent disappears; there is no
  -- surviving aggregate to validate in that case.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM "CatalogItemBusinessType"
     WHERE "catalogItemId" = item_id
  ) INTO has_business_type;

  IF NOT has_business_type THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CatalogItem_relational_baseline_check',
      MESSAGE = 'CatalogItem must have at least one CatalogItemBusinessType';
  END IF;

  SELECT EXISTS (
    SELECT 1
     FROM "CatalogItemPrice"
     WHERE "catalogItemId" = item_id
       AND "organizationId" = item_organization_id
       AND "scope" = 'ORGANIZATION'
       AND "active"
       AND "kind" IN ('SALE_PRICE', 'PURCHASE_COST')
     GROUP BY "currency"
    HAVING BOOL_OR("kind" = 'SALE_PRICE')
       AND BOOL_OR("kind" = 'PURCHASE_COST')
  ) INTO has_same_currency_price_pair;

  IF NOT has_same_currency_price_pair THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CatalogItem_relational_baseline_check',
      MESSAGE = 'CatalogItem must have active ORGANIZATION SALE_PRICE and PURCHASE_COST in the same currency';
  END IF;
END;
$$;

CREATE FUNCTION "enforce_catalog_item_relational_baseline"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'CatalogItem' THEN
    IF TG_OP = 'DELETE' THEN
      PERFORM "assert_catalog_item_relational_baseline"(OLD."id");
    ELSE
      PERFORM "assert_catalog_item_relational_baseline"(NEW."id");
      IF TG_OP = 'UPDATE' AND OLD."id" IS DISTINCT FROM NEW."id" THEN
        PERFORM "assert_catalog_item_relational_baseline"(OLD."id");
      END IF;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      PERFORM "assert_catalog_item_relational_baseline"(OLD."catalogItemId");
    ELSIF TG_OP = 'INSERT' THEN
      PERFORM "assert_catalog_item_relational_baseline"(NEW."catalogItemId");
    ELSE
      PERFORM "assert_catalog_item_relational_baseline"(NEW."catalogItemId");
      IF OLD."catalogItemId" IS DISTINCT FROM NEW."catalogItemId" THEN
        PERFORM "assert_catalog_item_relational_baseline"(OLD."catalogItemId");
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "CatalogItem_relational_baseline_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "CatalogItem"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_catalog_item_relational_baseline"();

CREATE CONSTRAINT TRIGGER "CatalogItemBusinessType_relational_baseline_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "CatalogItemBusinessType"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_catalog_item_relational_baseline"();

CREATE CONSTRAINT TRIGGER "CatalogItemPrice_relational_baseline_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "CatalogItemPrice"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_catalog_item_relational_baseline"();
