export type CommercialProductKind = 'PLAN' | 'POS' | 'MODULE'
export type CommercialSalesMode = 'SELF_SERVICE' | 'CONTACT'
export type CommercialBillingUnit = 'VENUE_MONTH' | 'VENUE_YEAR'
export type CommercialTaxBehavior = 'EXCLUSIVE' | 'NOT_APPLICABLE'
export type CommercialCapabilityKind = 'FEATURE' | 'MODULE' | 'CORE'

export interface CommercialProductDraftInput {
  code: string
  slug: string
  kind: CommercialProductKind
  salesMode: CommercialSalesMode
  name: string
  description: string
  active: boolean
  sortOrder: number
  limits?: { users: 'UNLIMITED'; devices: 'UNLIMITED' }
}

export interface CommercialPricebookDraftInput {
  code: string
  name: string
  active: boolean
}

export interface CommercialPriceDraftInput {
  code: string
  pricebookCode: string
  productCode?: string
  bundleCode?: string
  billingUnit: CommercialBillingUnit
  /** Exact pesos. This is deliberately a decimal string, never a JS number. */
  amount: string
  taxBehavior: CommercialTaxBehavior
  active: boolean
}

export interface CommercialBundleDraftInput {
  code: string
  slug: string
  name: string
  description: string
  active: boolean
  sortOrder: number
}

export interface CommercialBundleItemDraftInput {
  bundleCode: string
  productCode: string
  quantity: number
  sortOrder: number
}

export interface CommercialFeatureBindingDraftInput {
  productCode: string
  capabilityCode: string
  capabilityKind: CommercialCapabilityKind
}

export interface CommercialDraftInput {
  name: string
  description?: string | null
  products: CommercialProductDraftInput[]
  pricebooks: CommercialPricebookDraftInput[]
  prices: CommercialPriceDraftInput[]
  bundles: CommercialBundleDraftInput[]
  bundleItems: CommercialBundleItemDraftInput[]
  featureBindings: CommercialFeatureBindingDraftInput[]
}

export interface CommercialDraftActor {
  staffId: string
  reason: string
  ipAddress?: string
  userAgent?: string
}

export interface CommercialPublisherActor extends CommercialDraftActor {
  permissions: string[]
}

export interface CommercialCatalogPriceV1 {
  code: string
  billingUnit: CommercialBillingUnit
  amountMinor: number
  currency: 'MXN'
  taxBehavior: CommercialTaxBehavior
  taxRateBasisPoints: 0 | 1600
}

export interface CommercialCatalogProductV1 {
  code: string
  slug: string
  kind: CommercialProductKind
  name: string
  description: string
  salesMode: CommercialSalesMode
  capabilityCodes: string[]
  prices: CommercialCatalogPriceV1[]
  limits?: { users: 'UNLIMITED'; devices: 'UNLIMITED' }
}

export interface CommercialCatalogBundleV1 {
  code: string
  slug: string
  name: string
  description: string
  itemProductCodes: string[]
  prices: CommercialCatalogPriceV1[]
}

export interface CommercialCatalogSnapshotV1 {
  schemaVersion: 1
  publicationId: string
  publishedAt: string
  market: {
    country: 'MX'
    currency: 'MXN'
    timezone: 'America/Mexico_City'
    taxLabel: 'IVA'
    taxRateBasisPoints: 1600
  }
  products: CommercialCatalogProductV1[]
  bundles: CommercialCatalogBundleV1[]
}

export interface CommercialDraftView extends CommercialDraftInput {
  id: string
  sourceKey?: string | null
  revision: number
  status: 'ACTIVE' | 'ARCHIVED'
  createdAt?: Date
  updatedAt?: Date
}
