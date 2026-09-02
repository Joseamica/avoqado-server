import type {
  CommercialBillingUnit,
  CommercialCapabilityKind,
  CommercialProductKind,
  CommercialSalesMode,
  CommercialTaxBehavior,
} from './commercial'

export type CommercialMoneyV2 = string

export type CommercialActivationRequirementV2 =
  | { mode: 'NOT_REQUIRED' }
  | { mode: 'VENUE_SETTING'; settingKey: string; defaultState: 'ON' | 'OFF' }

export interface CommercialCapabilityBindingV2 {
  capabilityCode: string
  capabilityKind: CommercialCapabilityKind
  activationRequirement: CommercialActivationRequirementV2
}

export interface CommercialCatalogPriceV2 {
  code: string
  billingUnit: CommercialBillingUnit
  amount: CommercialMoneyV2
  currency: 'MXN'
  taxBehavior: CommercialTaxBehavior
  taxRateBasisPoints: 0 | 1600
}

export interface CommercialCatalogProductV2 {
  code: string
  slug: string
  kind: CommercialProductKind
  name: string
  description: string
  salesMode: CommercialSalesMode
  sortOrder: number
  capabilityBindings: CommercialCapabilityBindingV2[]
  prices: CommercialCatalogPriceV2[]
  limits?: { users: 'UNLIMITED'; devices: 'UNLIMITED' }
}

export interface CommercialCatalogBundleItemV2 {
  productCode: string
  quantity: 1
  sortOrder: number
}

export interface CommercialCatalogBundleV2 {
  code: string
  slug: string
  name: string
  description: string
  sortOrder: number
  items: CommercialCatalogBundleItemV2[]
  prices: CommercialCatalogPriceV2[]
}

export interface CommercialCatalogSnapshotV2 {
  schemaVersion: 2
  contractVersion: '2.0.0'
  publicationId: string
  publishedAt: string
  market: {
    country: 'MX'
    currency: 'MXN'
    timezone: 'America/Mexico_City'
    taxLabel: 'IVA'
    taxRateBasisPoints: 1600
  }
  products: CommercialCatalogProductV2[]
  bundles: CommercialCatalogBundleV2[]
}

export type CommercialCampaignRuleTypeV2 = 'FIXED_PRICE' | 'PERCENT_OFF' | 'AMOUNT_OFF' | 'FREE_PERIOD' | 'BUNDLE_PRICE'

export type CommercialNonEmptyArrayV2<T> = [T, ...T[]]

export type CommercialCampaignTargetV2 =
  | {
      productCodes: CommercialNonEmptyArrayV2<string>
      productKinds?: CommercialNonEmptyArrayV2<CommercialProductKind>
      bundleCodes?: CommercialNonEmptyArrayV2<string>
    }
  | {
      productCodes?: CommercialNonEmptyArrayV2<string>
      productKinds: CommercialNonEmptyArrayV2<CommercialProductKind>
      bundleCodes?: CommercialNonEmptyArrayV2<string>
    }
  | {
      productCodes?: CommercialNonEmptyArrayV2<string>
      productKinds?: CommercialNonEmptyArrayV2<CommercialProductKind>
      bundleCodes: CommercialNonEmptyArrayV2<string>
    }

interface CommercialCampaignRuleBaseV2 {
  code: string
  priority: number
  target: CommercialCampaignTargetV2
  cycles: number
}

export type CommercialCampaignRuleV2 =
  | (CommercialCampaignRuleBaseV2 & {
      type: 'FIXED_PRICE' | 'AMOUNT_OFF' | 'BUNDLE_PRICE'
      amount: CommercialMoneyV2
    })
  | (CommercialCampaignRuleBaseV2 & {
      type: 'PERCENT_OFF'
      percentBasisPoints: number
    })
  | (CommercialCampaignRuleBaseV2 & {
      type: 'FREE_PERIOD'
    })

export interface CommercialCampaignStackingGroupV2 {
  code: string
  steps: Array<{ position: number; ruleCode: string }>
}

export interface CommercialCampaignSnapshotV2 {
  schemaVersion: 2
  contractVersion: '2.0.0'
  campaignVersionId: string
  campaignCode: string
  version: number
  status: 'ACTIVE' | 'INACTIVE'
  publishedAt: string
  startsAt: string
  endsAt: string
  stackingGroups: CommercialCampaignStackingGroupV2[]
  rules: CommercialCampaignRuleV2[]
}

export type CommercialEntitlementOriginV2 =
  | { kind: 'FREE'; sourceCode: string; lineKey: string }
  | { kind: 'PRODUCT'; sourceCode: string; lineKey: string }
  | { kind: 'BUNDLE'; sourceCode: string; lineKey: string }
  | { kind: 'BUNDLE_COMPONENT'; sourceCode: string; parentSourceCode: string; lineKey: string }
  | { kind: 'CAMPAIGN'; sourceCode: string; sourceId: string; lineKey: string }
  | { kind: 'TRIAL'; sourceId: string }
  | { kind: 'GRANDFATHERED'; sourceId: string }
  | { kind: 'CONTRACT'; sourceId: string }
  | { kind: 'MANUAL'; sourceId: string }

export type CommercialQuoteSubjectV2 =
  | { kind: 'ACQUISITION_CONTEXT'; acquisitionContextId: string }
  | { kind: 'VENUE'; organizationId: string; venueId: string; actorId: string }

export interface CommercialQuoteDerivedFromPreviewV2 {
  previewQuoteId: string
  previewChecksum: string
  selectionFingerprint: string
}

export interface CommercialAppliedCampaignV2 {
  campaignVersionId: string
  campaignCode: string
  ruleCode: string
  type: CommercialCampaignRuleTypeV2
  position: number
  inputAmount: CommercialMoneyV2
  discountAmount: CommercialMoneyV2
  outputAmount: CommercialMoneyV2
  cycles: number
}

export interface CommercialQuoteLineV2 {
  lineKey: string
  targetType: 'PRODUCT' | 'BUNDLE'
  targetCode: string
  priceCode: string
  quantity: number
  productKind: CommercialProductKind | 'BUNDLE'
  name: string
  billingUnit: CommercialBillingUnit
  currency: 'MXN'
  taxRateBasisPoints: 0 | 1600
  unitAmount: CommercialMoneyV2
  listSubtotal: CommercialMoneyV2
  appliedCampaigns: CommercialAppliedCampaignV2[]
  discount: CommercialMoneyV2
  subtotal: CommercialMoneyV2
  tax: CommercialMoneyV2
  total: CommercialMoneyV2
  promotionalCycles: number | null
  renewalSubtotal: CommercialMoneyV2
  renewalTax: CommercialMoneyV2
  renewalTotal: CommercialMoneyV2
}

export interface CommercialEntitlementGrantV2 {
  capabilityCode: string
  capabilityKind: CommercialCapabilityKind
  origins: CommercialEntitlementOriginV2[]
  activationRequirement: CommercialActivationRequirementV2
}

export interface CommercialQuoteSnapshotV2 {
  schemaVersion: 2
  contractVersion: '2.0.0'
  quoteId: string
  subject: CommercialQuoteSubjectV2
  acquisitionContextId: string | null
  derivedFromPreview: CommercialQuoteDerivedFromPreviewV2 | null
  catalogPublicationId: string
  campaignVersionId: string | null
  campaignCode: string | null
  market: 'MX'
  currency: 'MXN'
  quotedAt: string
  expiresAt: string
  lines: CommercialQuoteLineV2[]
  entitlementGrants: CommercialEntitlementGrantV2[]
  totals: {
    listSubtotal: CommercialMoneyV2
    discount: CommercialMoneyV2
    subtotal: CommercialMoneyV2
    tax: CommercialMoneyV2
    total: CommercialMoneyV2
  }
  renewal: {
    subtotal: CommercialMoneyV2
    tax: CommercialMoneyV2
    total: CommercialMoneyV2
  }
}

export type CommercialEntitlementStateV2 = 'ACTIVE' | 'PENDING' | 'GRACE_PERIOD' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED'
export type CommercialActivationStateV2 = 'NOT_REQUIRED' | 'ON' | 'OFF'

export interface CommercialEntitlementProjectionV2 {
  schemaVersion: 2
  contractVersion: '2.0.0'
  subject: { kind: 'VENUE'; organizationId: string; venueId: string }
  capabilities: Array<{
    capabilityCode: string
    capabilityKind: CommercialCapabilityKind
    entitlement: { state: CommercialEntitlementStateV2; origins: CommercialEntitlementOriginV2[] }
    activation: { state: CommercialActivationStateV2 }
  }>
}

export interface CommercialLifecycleVocabularyV2 {
  schemaVersion: 2
  contractVersion: '2.0.0'
  quoteStates: readonly ['ISSUED', 'VOIDED', 'EXPIRED']
  acceptanceStates: readonly ['ACCEPTED', 'STRIPE_PENDING', 'ACTIVE', 'FAILED', 'CANCELED', 'REFUNDED', 'DISPUTED']
  redemptionStates: readonly ['RESERVED', 'RECONCILING', 'CONSUMED', 'RELEASED']
  checkoutAttemptStates: readonly [
    'PENDING',
    'PROCESSING',
    'STRIPE_PENDING',
    'OUTCOME_UNKNOWN',
    'SUCCEEDED',
    'FAILED_RETRYABLE',
    'FAILED_FINAL',
  ]
  entitlementStates: readonly ['ACTIVE', 'PENDING', 'GRACE_PERIOD', 'SUSPENDED', 'REVOKED', 'EXPIRED']
}
