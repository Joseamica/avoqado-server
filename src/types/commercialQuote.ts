import type { CommercialCatalogSnapshotV1, CommercialProductKind } from './commercial'

export type CommercialPromotionType = 'FIXED_PRICE' | 'PERCENT_OFF' | 'AMOUNT_OFF' | 'FREE_PERIOD' | 'BUNDLE_PRICE'

export interface CommercialCampaignTargetV1 {
  productCodes?: string[]
  productKinds?: CommercialProductKind[]
  bundleCodes?: string[]
}

interface CommercialCampaignRuleBaseV1 {
  code: string
  type: CommercialPromotionType
  priority: number
  target: CommercialCampaignTargetV1
  cycles: number
}

export interface CommercialFixedPriceRuleV1 extends CommercialCampaignRuleBaseV1 {
  type: 'FIXED_PRICE'
  amountMinor: number
}

export interface CommercialPercentOffRuleV1 extends CommercialCampaignRuleBaseV1 {
  type: 'PERCENT_OFF'
  percentBasisPoints: number
}

export interface CommercialAmountOffRuleV1 extends CommercialCampaignRuleBaseV1 {
  type: 'AMOUNT_OFF'
  amountMinor: number
}

export interface CommercialFreePeriodRuleV1 extends CommercialCampaignRuleBaseV1 {
  type: 'FREE_PERIOD'
}

export interface CommercialBundlePriceRuleV1 extends CommercialCampaignRuleBaseV1 {
  type: 'BUNDLE_PRICE'
  amountMinor: number
}

export type CommercialCampaignRuleV1 =
  | CommercialFixedPriceRuleV1
  | CommercialPercentOffRuleV1
  | CommercialAmountOffRuleV1
  | CommercialFreePeriodRuleV1
  | CommercialBundlePriceRuleV1

export interface CommercialCampaignVersionV1 {
  schemaVersion: 1
  campaignVersionId: string
  campaignCode: string
  version: number
  status: 'ACTIVE' | 'INACTIVE'
  startsAt: string
  endsAt: string
  allowedRuleCodeGroups: string[][]
  rules: CommercialCampaignRuleV1[]
}

export interface CommercialCampaignTargetV2 {
  productCodes?: string[]
  productKinds?: CommercialProductKind[]
  bundleCodes?: string[]
}

interface CommercialCampaignRuleBaseV2 {
  code: string
  type: CommercialPromotionType
  priority: number
  target: CommercialCampaignTargetV2
  cycles: number
}

export interface CommercialFixedPriceRuleV2 extends CommercialCampaignRuleBaseV2 {
  type: 'FIXED_PRICE'
  amount: string
}

export interface CommercialPercentOffRuleV2 extends CommercialCampaignRuleBaseV2 {
  type: 'PERCENT_OFF'
  percentBasisPoints: number
}

export interface CommercialAmountOffRuleV2 extends CommercialCampaignRuleBaseV2 {
  type: 'AMOUNT_OFF'
  amount: string
}

export interface CommercialFreePeriodRuleV2 extends CommercialCampaignRuleBaseV2 {
  type: 'FREE_PERIOD'
}

export interface CommercialBundlePriceRuleV2 extends CommercialCampaignRuleBaseV2 {
  type: 'BUNDLE_PRICE'
  amount: string
}

export type CommercialCampaignRuleV2 =
  | CommercialFixedPriceRuleV2
  | CommercialPercentOffRuleV2
  | CommercialAmountOffRuleV2
  | CommercialFreePeriodRuleV2
  | CommercialBundlePriceRuleV2

export interface CommercialCampaignStackingStepV2 {
  position: number
  ruleCode: string
}

export interface CommercialCampaignStackingGroupV2 {
  code: string
  steps: CommercialCampaignStackingStepV2[]
}

export interface CommercialCampaignDraftInput {
  code: string
  name: string
  description?: string | null
  startsAt: string
  endsAt: string
  stackingGroups: CommercialCampaignStackingGroupV2[]
  rules: CommercialCampaignRuleV2[]
}

export interface CommercialCampaignDraftView extends CommercialCampaignDraftInput {
  id: string
  revision: number
  offerSchemaVersion: 2 | 3
  status: 'ACTIVE' | 'ARCHIVED'
  createdAt?: Date
  updatedAt?: Date
}

export interface CommercialQuoteSelectionV1 {
  targetType: 'PRODUCT' | 'BUNDLE'
  targetCode: string
  priceCode: string
  quantity: number
}

export interface CommercialQuoteRequestV1 {
  market: 'MX'
  currency: 'MXN'
  lines: CommercialQuoteSelectionV1[]
}

export type CommercialAcquisitionChannel = 'PAID_META' | 'PAID_GOOGLE' | 'SELLER' | 'DISTRIBUTOR' | 'ORGANIC' | 'PARTNER' | 'DIRECT'

export interface CommercialAcquisitionAttributionV1 {
  campaignCode?: string
  sourceRef?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  utmTerm?: string
  gclid?: string
  fbclid?: string
}

export interface CommercialCampaignClaimRecordV1 {
  id: string
  tokenHash: string
  campaignVersionId: string
  campaignCode: string
  channel: CommercialAcquisitionChannel
  sourceRef: string
  issuedById: string
  reason: string
  createdAt: Date
  expiresAt: Date
}

export interface CommercialResolvedCampaignClaimV1 {
  campaignVersionId: string
  campaignCode: string
  channel: CommercialAcquisitionChannel
  sourceRef: string
}

export interface CommercialAcquisitionContextRecordV1 {
  id: string
  tokenHash: string
  campaignVersionId: string | null
  channel: CommercialAcquisitionChannel
  attribution: CommercialAcquisitionAttributionV1
  createdAt: Date
  expiresAt: Date
}

export interface CommercialQuoteAdjustmentV1 {
  ruleCode: string
  type: CommercialPromotionType
  beforeMinor: number
  afterMinor: number
  discountMinor: number
  cycles: number
}

export interface CommercialQuoteLineV1 extends CommercialQuoteSelectionV1 {
  productKind: CommercialProductKind | 'BUNDLE'
  name: string
  billingUnit: 'VENUE_MONTH' | 'VENUE_YEAR'
  currency: 'MXN'
  taxRateBasisPoints: 0 | 1600
  unitAmountMinor: number
  listSubtotalMinor: number
  adjustments: CommercialQuoteAdjustmentV1[]
  discountMinor: number
  subtotalMinor: number
  taxMinor: number
  totalMinor: number
  promotionalCycles: number | null
  renewalSubtotalMinor: number
  renewalTaxMinor: number
  renewalTotalMinor: number
}

export interface CommercialQuoteV1 {
  schemaVersion: 1
  quoteId: string
  catalogPublicationId: string
  campaignVersionId: string | null
  campaignCode: string | null
  market: 'MX'
  currency: 'MXN'
  quotedAt: string
  expiresAt: string
  lines: CommercialQuoteLineV1[]
  totals: {
    listSubtotalMinor: number
    discountMinor: number
    subtotalMinor: number
    taxMinor: number
    totalMinor: number
  }
  renewal: {
    subtotalMinor: number
    taxMinor: number
    totalMinor: number
  }
}

export interface EvaluateCommercialQuoteInput {
  quoteId: string
  catalog: CommercialCatalogSnapshotV1
  campaign?: CommercialCampaignVersionV1
  request: CommercialQuoteRequestV1
  now: Date
  expiresAt: Date
}
