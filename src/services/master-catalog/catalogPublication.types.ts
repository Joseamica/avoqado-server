import type { BusinessType, CatalogItemKind, ProductType, Unit, VenueOperationalRole, Prisma } from '@prisma/client'
import type { Decimal } from '@prisma/client/runtime/library'
import type { CatalogManagedFieldV1, CatalogPublicationOperation, PreparedDishReadiness } from '../../types/master-catalog'
import type { CatalogPublicationResolvedDecision } from './catalogPublicationOverrideDecision.service'

export type CatalogPublicationJson = null | boolean | number | string | CatalogPublicationJson[] | { [key: string]: CatalogPublicationJson }

export interface CatalogPublicationSocketProductV1 {
  productId: string
  productName: string
  sku: string
  categoryId: string
  categoryName: string
  price: number
  available: boolean
  imageUrl: string | null
  description: string | null
  modifierGroupIds: string[]
}

export interface CatalogPublicationPriceChangeV1 {
  productId: string
  productName: string
  sku: string
  categoryId: string
  categoryName: string
  oldPrice: number
  newPrice: number
}

export interface CatalogPublicationOutboxPayloadV1 {
  schemaVersion: 1
  menuItems: Array<{
    itemId: string
    itemName: string
    sku: string
    categoryId: string
    categoryName: string
    price: number
    available: boolean
    imageUrl: string | null
    description: string | null
    modifierGroupIds: string[]
  }>
  menu: {
    updateType: 'PARTIAL_UPDATE'
    productIds: string[]
    categoryIds: string[]
    reason: 'CATEGORY_UPDATED'
  }
  priceChanges: Array<{
    productId: string
    productName: string
    sku: string
    oldPrice: number
    newPrice: number
    priceChange: number
    priceChangePercent: number | null
    categoryId: string
    categoryName: string
  }>
}

export interface CatalogPublicationItemRecord {
  id: string
  organizationId: string
  sku: string
  kind: CatalogItemKind
  status: string
  revision: number
  invariantVersion: bigint
  name: string
  description: string
  imageUrl: string
  brandId: string
  manufacturerId: string
  familyId: string
  presentationLabel: string
  unit: Unit
  taxRate: Decimal
  satProductKey: string
  satUnitKey: string
  objetoImp: string
  productType: ProductType
  iepsMode: string
  iepsRate: Decimal | null
  iepsQuota: Decimal | null
  iepsQuotaUnit: Unit | null
  createdById: string
  createdAt: Date
  updatedById: string
  updatedAt: Date
  family: { parentId: string | null }
  businessTypes: Array<{ businessType: BusinessType }>
  prices: Array<{
    kind: string
    scope: string
    amount: Decimal
    currency: string
    active: boolean
    revision: number
  }>
}

export interface CatalogPublicationProductRecord {
  id: string
  venueId: string
  name: string
  description: string | null
  imageUrl: string | null
  type: ProductType
  cost: Decimal | null
  taxRate: Decimal
  satProductKey: string | null
  satUnitKey: string | null
  objetoImp: string | null
  unit: Unit | null
  categoryId: string
  price: Decimal
  active: boolean
  deletedAt?: Date | null
  updatedAt: Date
}

export interface CatalogPublicationBindingRecord {
  id: string
  revision: number
  managedFieldMask: string[]
  lastPublishedCatalogRevision: number | null
  lastPublishedManagedSnapshot: unknown
  lastPublishedManagedHash: string | null
}

export interface CatalogPublicationProfileRecord {
  id: string
  profileVersion?: number
  updatedAt?: Date
  active: boolean
  businessType: BusinessType | null
  operationalRole: VenueOperationalRole | null
  rulesSchemaVersion: number
  requiredFields: string[]
  additionalRules: unknown
}

export interface CatalogPublicationProjectionInput {
  operation: CatalogPublicationOperation
  organizationId: string
  venue: {
    id: string
    organizationId: string
    currency: string
    operationalRole: VenueOperationalRole | null
  }
  item: CatalogPublicationItemRecord
  product: CatalogPublicationProductRecord
  binding: CatalogPublicationBindingRecord
  profiles: CatalogPublicationProfileRecord[]
  readiness: PreparedDishReadiness
}

export interface CatalogPublicationProjectedField {
  field: CatalogManagedFieldV1
  before: CatalogPublicationJson
  proposed: CatalogPublicationJson
  changed: boolean
  diverged: boolean
}

export interface CatalogPublicationProjection {
  fieldMask: CatalogManagedFieldV1[]
  before: Record<CatalogManagedFieldV1, CatalogPublicationJson> | Partial<Record<CatalogManagedFieldV1, CatalogPublicationJson>>
  proposed: Record<CatalogManagedFieldV1, CatalogPublicationJson> | Partial<Record<CatalogManagedFieldV1, CatalogPublicationJson>>
  fields: CatalogPublicationProjectedField[]
  status: 'NO_CHANGE' | 'READY' | 'LOCAL_DIVERGENCE' | 'INVALID' | 'RECIPE_COST_STALE'
  diagnosticCode: string | null
  diagnostic: string | null
  canonicalTargetHash: string
}

export interface ProjectedCatalogPublicationTarget {
  organizationId: string
  venueId: string
  catalogItemId: string
  productId: string
  bindingId: string
  sourceCatalogRevision: number
  sourceCatalogInvariantVersion: string
  bindingRevision: number
  dependencies: Prisma.InputJsonObject
  projection: CatalogPublicationProjection
}

export interface CatalogPublicationApplyLine {
  lineId: string
  organizationId: string
  catalogItemId: string
  venueId: string
  productId: string
  bindingId: string
  sourceCatalogRevision: number
  bindingRevision: number
  fieldMask: CatalogManagedFieldV1[]
  decisions: CatalogPublicationResolvedDecision[]
  supersedesLineId?: string | null
  reversesLineId?: string | null
}
