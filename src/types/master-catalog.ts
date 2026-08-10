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

export type CatalogPublicationFieldDecisionKindV1 = 'PUBLISH_CORPORATE' | 'APPROVE_LOCAL_OVERRIDE' | 'UNDECIDED'

export type CatalogPublicationFieldV1 = CatalogManagedFieldV1 | 'active'

export type CatalogPublicationFieldDecisionInput =
  | { field: CatalogManagedFieldV1; decision: 'PUBLISH_CORPORATE' }
  | { field: CatalogManagedFieldV1; decision: 'APPROVE_LOCAL_OVERRIDE'; overrideId: string }
  | { field: CatalogManagedFieldV1; decision: 'UNDECIDED' }

export interface CatalogPublicationPreviewTargetInput {
  catalogItemId: string
  venueId: string
  productId: string
  sourceLineId?: string
  decisions?: CatalogPublicationFieldDecisionInput[]
}

export interface CatalogPublicationPreviewInput {
  operation: CatalogPublicationOperation
  sourcePublicationBatchId?: string
  idempotencyKey: string
  targets: CatalogPublicationPreviewTargetInput[]
}

export interface CatalogPublicationPreviewField {
  field: CatalogPublicationFieldV1
  before: Prisma.JsonValue
  proposed: Prisma.JsonValue
  after: Prisma.JsonValue
  decision: CatalogPublicationFieldDecisionKindV1
  overrideId: string | null
}

export interface CatalogPublicationPreviewLine {
  catalogItemId: string
  venueId: string
  productId: string
  bindingId: string
  status: string
  fieldMask: CatalogPublicationFieldV1[]
  canonicalTargetHash: string
  diagnosticCode: string | null
  diagnostic: string | null
  fields: CatalogPublicationPreviewField[]
}

export interface CatalogPublicationPreview {
  publicationBatchId: string
  operation: CatalogPublicationOperation
  previewToken: string
  targetHash: string
  expiresAt: string
  canConfirm: boolean
  lines: CatalogPublicationPreviewLine[]
}

export interface CatalogPublicationConfirmInput extends CatalogConfirmInput {
  publicationBatchId: string
}

export interface CatalogPublicationResultLine {
  lineId: string
  catalogItemId: string
  venueId: string
  productId: string
  status: 'APPLIED' | 'NO_CHANGE'
}

export interface CatalogPublicationResult {
  publicationBatchId: string
  operation: CatalogPublicationOperation
  state: 'APPLIED'
  lines: CatalogPublicationResultLine[]
}

export interface CatalogPublicationInProgress {
  publicationBatchId: string
  operation: CatalogPublicationOperation
  state: 'IN_PROGRESS'
  retryAfterSeconds: number
}

export interface CatalogPublicationPreviewed {
  publicationBatchId: string
  operation: CatalogPublicationOperation
  state: 'PREVIEWED'
  expiresAt: string
}

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

// WHY: Task 8 and Task 9 share one closed ownership vocabulary. Keeping the
// ordered masks here prevents publication from silently hashing local fields.
export type CatalogManagedFieldV1 =
  | 'cost'
  | 'description'
  | 'imageUrl'
  | 'name'
  | 'objetoImp'
  | 'satProductKey'
  | 'satUnitKey'
  | 'taxRate'
  | 'type'
  | 'unit'

export const CATALOG_RETAIL_MANAGED_FIELD_MASK_V1 = [
  'cost',
  'description',
  'imageUrl',
  'name',
  'objetoImp',
  'satProductKey',
  'satUnitKey',
  'taxRate',
  'type',
  'unit',
] as const satisfies readonly CatalogManagedFieldV1[]

export const CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1 = [
  'description',
  'imageUrl',
  'name',
  'objetoImp',
  'satProductKey',
  'satUnitKey',
  'taxRate',
  'type',
  'unit',
] as const satisfies readonly CatalogManagedFieldV1[]

export type CatalogBindingDecisionInput =
  | { decision: 'LINK'; productId: string }
  | { decision: 'CREATE'; create: { categoryId: string; localSku: string; initialPrice: string } }
  | { decision: 'SKIP' }

export interface CatalogBindingPreviewLineInput {
  catalogItemId: string
  venueId: string
  decision?: CatalogBindingDecisionInput
}

export interface CatalogBindingPreviewInput {
  lines: CatalogBindingPreviewLineInput[]
}

export interface CatalogBindingCandidateV1 {
  id: string
  sku: string
  gtin: string | null
  name: string
  categoryId: string
  active: boolean
  deletedAt: string | null
  updatedAt: string
}

export interface CatalogBindingPreviewLine {
  catalogItemId: string
  venueId: string
  proposal: 'LINK' | 'CREATE' | 'SKIP'
  decision: CatalogBindingDecisionInput | null
  status: 'READY' | 'CONFLICT' | 'INVALID'
  errorCode: string | null
  candidates: CatalogBindingCandidateV1[]
  readiness: 'NOT_REQUIRED' | 'READY' | 'MISSING_RECIPE' | 'INVALID' | 'STALE'
}

export interface CatalogBindingPreview {
  bindingBatchId: string | null
  previewToken: string | null
  targetHash: string
  expiresAt: string | null
  canConfirm: boolean
  lines: CatalogBindingPreviewLine[]
}

export interface CatalogBindingConfirmInput extends CatalogConfirmInput {
  bindingBatchId: string
}

export interface CatalogBindingResultLine {
  catalogItemId: string
  venueId: string
  decision: 'LINK' | 'CREATE' | 'SKIP'
  status: 'APPLIED' | 'SKIPPED'
  productId: string | null
  bindingId: string | null
  readiness: PreparedDishReadiness | null
}

export interface CatalogBindingResult {
  bindingBatchId: string
  state: 'APPLIED'
  lines: CatalogBindingResultLine[]
}

export interface CatalogVenueContext {
  organizationId: string
  venueId: string
  actor: CatalogActor
}

export interface CatalogOverrideRequestLineInput {
  field: CatalogManagedFieldV1
  reason: string
}

export interface CatalogOverrideRequestInput {
  bindingId: string
  idempotencyKey: string
  requests: CatalogOverrideRequestLineInput[]
}

export interface CatalogOverrideRequestPreviewLine extends CatalogOverrideRequestLineInput {
  bindingId: string
  localValue: Prisma.JsonValue
}

export interface CatalogOverrideRequestPreview {
  requestBatchId: string
  previewToken: string
  targetHash: string
  expiresAt: string
  requests: CatalogOverrideRequestPreviewLine[]
}

export interface CatalogOverrideConfirmInput extends CatalogConfirmInput {
  requestBatchId: string
}

export interface CatalogOverrideRequestResult {
  requestBatchId: string
  state: 'APPLIED'
  overrideIds: string[]
}

export interface CatalogVenueProvenanceInput {
  productId: string
}

export interface CatalogVenueProvenanceResult {
  bindingId: string
  catalogItemId: string
  productId: string | null
  status: string
  revision: number
  managedFieldMask: CatalogManagedFieldV1[]
  lastPublishedCatalogRevision: number | null
  lastPublishedManagedSnapshot: Prisma.JsonValue | null
  lastPublishedManagedHash: string | null
  productUpdatedAtObserved: string | null
}

export interface CatalogVenueChangesInput {
  cursor?: string | null
  pageSize?: number
}

export interface CatalogVenueChangesPage {
  items: CatalogVenueProvenanceResult[]
  nextCursor: string | null
}
