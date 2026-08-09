import type { BusinessType, Prisma, VenueOperationalRole } from '@prisma/client'

export type GovernanceMode = 'OFF' | 'ADVISORY' | 'ENFORCED'
export type CatalogItemKind = 'RETAIL_PRODUCT' | 'PREPARED_DISH'
export type CatalogItemStatus = 'ACTIVE' | 'RETIRED'
export type CatalogMutationRole = 'OWNER' | 'ADMIN'

export interface MasterCatalogModuleConfigV1 {
  schemaVersion: 1
  catalogCoreEnabled: boolean
  identifiersEnabled: boolean
  regionalPricingEnabled: boolean
  governanceMode: GovernanceMode
}

// Default-off is the compatibility boundary: defining the module during a deploy
// cannot enable catalog behavior for PITS or any existing organization.
export const MASTER_CATALOG_DEFAULT_CONFIG: MasterCatalogModuleConfigV1 = {
  schemaVersion: 1,
  catalogCoreEnabled: false,
  identifiersEnabled: false,
  regionalPricingEnabled: false,
  governanceMode: 'OFF',
}

export type MasterCatalogAccessReasonCode =
  | 'ACCESSIBLE'
  | 'ENTITLEMENT_MISSING'
  | 'ENTITLEMENT_INACTIVE'
  | 'MODULE_MISSING'
  | 'MODULE_INACTIVE'
  | 'CONFIG_MISSING'
  | 'CONFIG_INVALID'
  | 'GATE_DISABLED'
  | 'ROLE_DENIED'
  | 'DEPENDENCY_UNAVAILABLE'

export interface MasterCatalogAccess {
  organizationId: string
  orgRole: 'OWNER' | 'ADMIN' | 'VIEWER' | 'MEMBER' | null
  entitlementActive: boolean
  moduleActive: boolean
  config: MasterCatalogModuleConfigV1 | null
  reasonCode: MasterCatalogAccessReasonCode
  canRead: boolean
  canMutateContent: boolean
  canConfigureControlPlane: boolean
}

// HUMAN and SERVICE are deliberately disjoint so background jobs cannot reuse
// interactive-role shortcuts and human requests always retain impersonation state.
export type CatalogActor = { type: 'HUMAN'; staffId: string; impersonating: boolean } | { type: 'SERVICE'; servicePrincipalId: string }

export type MasterCatalogCapability = 'READ_CONTENT' | 'MUTATE_CONTENT' | 'MANAGE_PROFILE' | 'CONFIGURE_CONTROL_PLANE' | 'RUN_SERVICE_JOB'

export type MasterCatalogRequiredGate = 'CORE' | 'IDENTIFIERS' | 'REGIONAL_PRICING'

export interface CatalogCommandContext {
  organizationId: string
  actor: CatalogActor
  orgRole?: MasterCatalogAccess['orgRole']
  idempotencyKey?: string
}

export interface CatalogReadContext {
  organizationId: string
  actor: CatalogActor
  orgRole?: MasterCatalogAccess['orgRole']
}

export type CatalogPublicationOperation = 'CATALOG_FIELDS_PUBLISH' | 'CATALOG_FIELDS_REVERSION' | 'CATALOG_PRODUCT_ACTIVATION'

// H1 audit data stays transaction-ready and tenant-explicit so later writers
// cannot fall back to the legacy fire-and-forget logger or infer organization.
export interface CatalogAuditInput {
  organizationId: string
  venueId?: string | null
  actor: CatalogActor
  action: string
  entity: string
  entityId?: string | null
  batchId?: string | null
  idempotencyKeyHash?: string | null
  reason?: string | null
  before?: Prisma.InputJsonValue
  after?: Prisma.InputJsonValue
  metadata?: Prisma.InputJsonValue
  ipAddress?: string | null
  userAgent?: string | null
}

export interface CatalogConfirmInput {
  previewToken: string
  confirm: true
  idempotencyKey: string
}

export interface CatalogWorkbookUpload {
  buffer: Buffer
  mimeType: string
  originalFilename: string
}

export interface CatalogPreviewTokenV1 {
  schemaVersion: 1
  organizationId: string
  commandKind: string
  targetHash: string
  expiresAt: string
}

// WHY: This union freezes the H1 baseline vocabulary independently of Prisma
// column names while profiles remain additive and may introduce later fields.
export type CatalogValidationBaselineFieldV1 =
  | 'sku'
  | 'imageUrl'
  | 'name'
  | 'description'
  | 'brandId'
  | 'manufacturerId'
  | 'familyId'
  | 'subfamily'
  | 'presentationLabel'
  | 'unit'
  | 'kind'
  | 'productType'
  | 'organizationSalePrice'
  | 'organizationPurchaseCost'
  | 'currency'
  | 'taxRate'
  | 'ieps'
  | 'satProductKey'
  | 'satUnitKey'
  | 'objetoImp'
  | 'createdById'
  | 'createdAt'
  | 'updatedById'
  | 'updatedAt'
  | 'businessTypes'

export interface CatalogValidationProfileScopeV1 {
  businessType: BusinessType | null
  operationalRole: VenueOperationalRole | null
}

export interface CatalogValidationProfileRuleV1 extends CatalogValidationProfileScopeV1 {
  rulesSchemaVersion: number
  requiredFields: readonly string[]
}

export interface CatalogValidationProfilePreviewInput {
  idempotencyKey: string
  name: string
  businessType?: BusinessType | null
  operationalRole?: VenueOperationalRole | null
  requiredFields: readonly string[]
  additionalRules?: Prisma.InputJsonObject | null
}

export interface CatalogValidationProfilePreview {
  profileBatchId: string
  previewToken: string
  targetHash: string
  expiresAt: string
  proposedProfileVersion: number
  rulesSchemaVersion: 1
  requiredFields: string[]
}

export interface CatalogValidationProfileConfirmInput extends CatalogConfirmInput {
  profileBatchId: string
}

export interface CatalogValidationProfileResult {
  profileBatchId: string
  profileId: string
  profileVersion: number
  rulesSchemaVersion: 1
  active: true
}

export type PreparedDishReadinessState = 'READY' | 'INVALID' | 'STALE'

// WHY: Stable finding codes are API data consumed by preview/export callers;
// lineId is optional because recipe-level findings have no ingredient target.
export type PreparedDishReadinessFindingCode =
  | 'PRODUCT_TYPE_INVALID'
  | 'MISSING_RECIPE'
  | 'INVALID_PORTION_YIELD'
  | 'MISSING_PREP_TIME'
  | 'EMPTY_LINES'
  | 'INVALID_RECIPE_LINE'
  | 'RECIPE_COST_STALE'

export interface PreparedDishReadinessFinding {
  code: PreparedDishReadinessFindingCode
  lineId?: string
  reason?: string
}

// WHY: The concise alias is the public finding vocabulary used by preview and
// export callers; the longer name remains source-compatible for existing code.
export type PreparedDishFinding = PreparedDishReadinessFinding

export interface PreparedDishReadinessDependencies {
  bindingId: string
  bindingRevision: number
  catalogItemId: string
  catalogItemRevision: number
  productId: string
  recipeId: string | null
  recipeUpdatedAt: string | null
  recipeLineHash: string | null
}

export interface PreparedDishReadiness {
  state: PreparedDishReadinessState
  findings: PreparedDishReadinessFinding[]
  dependencies: PreparedDishReadinessDependencies
  costs?: {
    batchCost: string
    costPerPortion: string
    storedCostPerPortion: string
  }
}
