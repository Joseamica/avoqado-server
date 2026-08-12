import {
  BusinessType,
  CatalogIepsMode,
  CatalogItemKind,
  CatalogItemPriceKind,
  CatalogItemPriceScope,
  CatalogItemStatus,
  CatalogReferenceStatus,
  Prisma,
  ProductType,
  Unit,
} from '@prisma/client'

// WHY: A discriminated owner makes per-command auditing explicit; imports
// cannot accidentally pass a vague boolean that suppresses their batch audit.
export type CatalogAuditOwnership = { kind: 'DIRECT' } | { kind: 'BATCH'; batchId: string }
export type CatalogReferenceType = 'BRAND' | 'MANUFACTURER' | 'FAMILY'

// WHY: Rule revisions belong to each stable price row, independently of the
// aggregate revision, so imports can detect stale monetary edits precisely.
export interface CatalogOrganizationValueInput {
  kind: CatalogItemPriceKind
  amount: string
  currency: string
  expectedRuleRevision?: number
}

// WHY: Persistence keeps stable organization-rule identity and CAS state
// separate from command amounts/actors; both validation and writes consume it.
export interface PersistedCatalogOrganizationValue {
  id: string
  kind: CatalogItemPriceKind
  currency: string
  revision: number
  active: boolean
}

// WHY: Full-replacement UPDATEs need explicit CAS tombstones for active rules
// omitted from the new set; absence alone cannot carry a caller revision.
export interface CatalogOrganizationValueDeactivationInput {
  kind: CatalogItemPriceKind
  currency: string
  expectedRuleRevision: number
}

// WHY: CatalogItem has no DRAFT state; this DTO enumerates the complete
// baseline that must be validated before the first authoritative write.
export interface CreateCatalogItemInput {
  sku: string
  kind: CatalogItemKind
  name: string
  description: string
  imageUrl: string
  brandId: string
  manufacturerId: string
  familyId: string
  presentationLabel: string
  unit: Unit
  taxRate: string
  satProductKey: string
  satUnitKey: string
  objetoImp: string
  productType: ProductType
  iepsMode: CatalogIepsMode
  iepsRate: string | null
  iepsQuota: string | null
  iepsQuotaUnit: Unit | null
  businessTypes: BusinessType[]
  organizationValues: CatalogOrganizationValueInput[]
}

// WHY: A mutable SKU is addressed by stable ID plus CAS revision; the SKU is
// never accepted as the identity of an update or retirement command.
export interface UpdateCatalogItemInput extends CreateCatalogItemInput {
  catalogItemId: string
  expectedRevision: number
  organizationValueDeactivations: CatalogOrganizationValueDeactivationInput[]
}

export interface RetireCatalogItemInput {
  catalogItemId: string
  expectedRevision: number
}

export type CatalogItemAggregateCommand =
  | { operation: 'CREATE'; input: CreateCatalogItemInput }
  | { operation: 'UPDATE'; input: UpdateCatalogItemInput }
  | { operation: 'RETIRE'; input: RetireCatalogItemInput }

// WHY: Reference proposals are a closed union so Task 7 can call the same
// transaction-bound lifecycle without importing direct HTTP-style wrappers.
export type CatalogReferenceProposal =
  | { operation: 'CREATE'; referenceType: CatalogReferenceType; name: string; parentId?: string | null }
  | {
      operation: 'UPDATE'
      referenceType: CatalogReferenceType
      referenceId: string
      expectedRevision: number
      name: string
      parentId?: string | null
    }
  | { operation: 'RETIRE'; referenceType: CatalogReferenceType; referenceId: string; expectedRevision: number }

// WHY: Batch callers need deterministic deltas to build one summary audit;
// direct callers pass the same envelope to the shared transactional writer.
export interface CatalogMutationAuditEnvelope {
  action: string
  entity: string
  entityId: string
  batchId: string | null
  before?: Prisma.InputJsonValue
  after?: Prisma.InputJsonValue
  metadata?: Prisma.InputJsonValue
}

export interface CatalogReferenceMutationResult {
  id: string
  organizationId: string
  name: string
  normalizedName: string
  status: CatalogReferenceStatus
  revision: number
  createdById: string
  updatedById: string
  parentId?: string | null
  reused: boolean
}

// WHY: Reference reads expose only controller-ready display/governance fields;
// normalized keys and ORM relation containers remain internal implementation.
export interface CatalogReferenceListItem {
  id: string
  name: string
  status: CatalogReferenceStatus
  revision: number
  parent?: { id: string; name: string; status: CatalogReferenceStatus } | null
}

export interface CatalogItemDetail {
  id: string
  organizationId: string
  sku: string
  normalizedSku: string
  kind: CatalogItemKind
  name: string
  description: string
  imageUrl: string
  brand: { id: string; name: string; status: CatalogReferenceStatus }
  manufacturer: { id: string; name: string; status: CatalogReferenceStatus }
  family: {
    id: string
    name: string
    status: CatalogReferenceStatus
    parent: { id: string; name: string; status: CatalogReferenceStatus }
  }
  presentationLabel: string
  unit: Unit
  taxRate: string
  satProductKey: string
  satUnitKey: string
  objetoImp: string
  productType: ProductType
  iepsMode: CatalogIepsMode
  iepsRate: string | null
  iepsQuota: string | null
  iepsQuotaUnit: Unit | null
  status: CatalogItemStatus
  revision: number
  businessTypes: BusinessType[]
  organizationValues: Array<{
    id: string
    kind: CatalogItemPriceKind
    amount: string
    currency: string
    revision: number
    active: boolean
  }>
  createdById: string
  updatedById: string
  createdAt: Date
  updatedAt: Date
  validation: { state: 'NOT_EVALUATED'; summary: null }
  bindingSummary: { total: number }
}

// WHY: One bounded projection keeps detail/list responses aligned and proves
// Recipe/modifier graphs are never traversed by master-catalog reads.
export const CATALOG_ITEM_DETAIL_SELECT = {
  id: true,
  organizationId: true,
  sku: true,
  normalizedSku: true,
  kind: true,
  name: true,
  description: true,
  imageUrl: true,
  presentationLabel: true,
  unit: true,
  taxRate: true,
  satProductKey: true,
  satUnitKey: true,
  objetoImp: true,
  productType: true,
  iepsMode: true,
  iepsRate: true,
  iepsQuota: true,
  iepsQuotaUnit: true,
  status: true,
  revision: true,
  createdById: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
  brand: { select: { id: true, name: true, status: true } },
  manufacturer: { select: { id: true, name: true, status: true } },
  family: {
    select: { id: true, name: true, status: true, parent: { select: { id: true, name: true, status: true } } },
  },
  businessTypes: { select: { businessType: true }, orderBy: { businessType: 'asc' as const } },
  prices: {
    where: { scope: CatalogItemPriceScope.ORGANIZATION },
    select: { id: true, kind: true, amount: true, currency: true, revision: true, active: true },
    orderBy: [{ currency: 'asc' as const }, { kind: 'asc' as const }],
  },
  _count: { select: { bindings: true } },
} satisfies Prisma.CatalogItemSelect

export type CatalogItemDetailRow = Prisma.CatalogItemGetPayload<{ select: typeof CATALOG_ITEM_DETAIL_SELECT }>

// WHY: Validation canonicalizes decimals once, before persistence, while
// retaining per-rule expected revisions for update preflight and CAS writes.
export type ValidatedCatalogItem = Omit<CreateCatalogItemInput, 'taxRate' | 'iepsRate' | 'iepsQuota' | 'organizationValues'> & {
  normalizedSku: string
  taxRate: string
  iepsRate: string | null
  iepsQuota: string | null
  organizationValues: CatalogOrganizationValueInput[]
  organizationValueDeactivations: CatalogOrganizationValueDeactivationInput[]
}
