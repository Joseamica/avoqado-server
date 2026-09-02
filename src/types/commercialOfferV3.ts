import type { CommercialCampaignRuleV2, CommercialCampaignStackingGroupV2 } from './commercialV2'
import type {
  CommercialCampaignRuleV2 as CommercialCampaignDraftRuleV2,
  CommercialCampaignStackingGroupV2 as CommercialCampaignDraftStackingGroupV2,
} from './commercialQuote'

export interface HardwareSkuSnapshotV3 {
  catalogKey: string
  catalogContentHash: string
  brand: string
  model: string
  name: string
  listUnitAmountMinor: string
  currency: 'MXN'
  taxRateBasisPoints: 1600
}

export interface CommercialSaasPriceBenefitV3 {
  benefitCode: string
  kind: 'SAAS_PRICE'
  stackingGroups: CommercialCampaignStackingGroupV2[]
  rules: CommercialCampaignRuleV2[]
}

export interface CommercialHardwarePercentOffBenefitV3 {
  benefitCode: string
  kind: 'HARDWARE_PERCENT_OFF'
  skuSnapshot: HardwareSkuSnapshotV3
  percentBasisPoints: number
  quantityLimit: number
  benefitStartsAt: string
  benefitEndsAt: string
}

export interface CommercialHardwareFixedPriceBenefitV3 {
  benefitCode: string
  kind: 'HARDWARE_FIXED_PRICE'
  skuSnapshot: HardwareSkuSnapshotV3
  unitAmountMinor: string
  quantityLimit: number
  benefitStartsAt: string
  benefitEndsAt: string
}

export interface CommercialPaymentsRateScheduleBenefitV3 {
  benefitCode: string
  kind: 'PAYMENTS_RATE_SCHEDULE'
  paymentsRateScheduleVersionId: string
}

export type CommercialHardwareBenefitV3 = CommercialHardwarePercentOffBenefitV3 | CommercialHardwareFixedPriceBenefitV3

export type CommercialBenefitV3 = CommercialSaasPriceBenefitV3 | CommercialHardwareBenefitV3 | CommercialPaymentsRateScheduleBenefitV3

export interface CommercialOfferSnapshotV3 {
  schemaVersion: 3
  contractVersion: '3.0.0'
  campaignVersionId: string
  campaignCode: string
  version: number
  status: 'ACTIVE' | 'INACTIVE'
  publishedAt: string
  claimStartsAt: string
  claimEndsAt: string
  benefits: CommercialBenefitV3[]
}

export interface EmittedCommercialOfferV3 {
  kind: 'COMMERCIAL_OFFER'
  schemaVersion: 3
  mode: 'READ_WRITE'
  snapshot: CommercialOfferSnapshotV3
  checksum: string
}

export interface CommercialOfferV3RowContext {
  id: string
  campaignCode: string
  sourceRevision: number
  schemaVersion: number
  publishedAt: Date
}

export interface CommercialOfferV3DecodeInput {
  rowSchemaVersion: number
  snapshot: unknown
  checksum: unknown
  rowContext: CommercialOfferV3RowContext
}

export type VerifiedStoredCommercialOfferV3 = EmittedCommercialOfferV3 & {
  verified: true
}

export type CommercialRateBlockerV3 = 'NEGOTIATED_RATE' | 'ENTERPRISE_RATE' | 'PRIOR_PROMOTION' | 'CHANNEL_AGREEMENT'

export type CommercialOfferResolutionExclusionReasonV3 =
  | 'LOWER_PRIORITY_SAAS_RULE'
  | 'SAAS_STACKING_NOT_ALLOWED'
  | 'HARDWARE_SKU_NOT_SELECTED'
  | 'HARDWARE_QUANTITY_EXCEEDED'
  | 'HARDWARE_WINDOW_INACTIVE'
  | 'NEGOTIATED_RATE_PRESENT'
  | 'ENTERPRISE_RATE_PRESENT'
  | 'PRIOR_PROMOTION_PRESENT'
  | 'CHANNEL_AGREEMENT_PRESENT'
  | 'RATE_SCHEDULE_AUTHORITY_UNAVAILABLE'

export type CommercialOfferResolutionSubjectKindV3 = 'SAAS_LINE' | 'HARDWARE_SKU' | 'PAYMENTS_RATE'

interface CommercialResolvedBenefitV3Base {
  subjectKey: string
  benefitCode: string
}

export interface CommercialAppliedSaasBenefitV3 extends CommercialResolvedBenefitV3Base {
  subjectKind: 'SAAS_LINE'
  ruleCode: string
}

export interface CommercialAppliedHardwareBenefitV3 extends CommercialResolvedBenefitV3Base {
  subjectKind: 'HARDWARE_SKU'
  appliedQuantity: number
}

export type CommercialAppliedBenefitV3 = CommercialAppliedSaasBenefitV3 | CommercialAppliedHardwareBenefitV3

export interface CommercialExcludedSaasBenefitV3 extends CommercialResolvedBenefitV3Base {
  subjectKind: 'SAAS_LINE'
  ruleCode: string
  accountingEffect: 'EXPLANATORY'
  reasonCode: 'LOWER_PRIORITY_SAAS_RULE' | 'SAAS_STACKING_NOT_ALLOWED'
}

export interface CommercialUnselectedHardwareBenefitV3 extends CommercialResolvedBenefitV3Base {
  subjectKind: 'HARDWARE_SKU'
  accountingEffect: 'EXPLANATORY'
  reasonCode: 'HARDWARE_SKU_NOT_SELECTED'
}

export interface CommercialExcludedHardwareExcessBenefitV3 extends CommercialResolvedBenefitV3Base {
  subjectKind: 'HARDWARE_SKU'
  excludedQuantity: number
  accountingEffect: 'LIST_PRICE_EXCESS'
  reasonCode: 'HARDWARE_QUANTITY_EXCEEDED'
}

export interface CommercialInactiveHardwareBenefitV3 extends CommercialResolvedBenefitV3Base {
  subjectKind: 'HARDWARE_SKU'
  accountingEffect: 'EXPLANATORY'
  reasonCode: 'HARDWARE_WINDOW_INACTIVE'
}

export interface CommercialExcludedPaymentsRateBenefitV3 extends CommercialResolvedBenefitV3Base {
  subjectKind: 'PAYMENTS_RATE'
  accountingEffect: 'EXPLANATORY'
  reasonCode:
    | 'NEGOTIATED_RATE_PRESENT'
    | 'ENTERPRISE_RATE_PRESENT'
    | 'PRIOR_PROMOTION_PRESENT'
    | 'CHANNEL_AGREEMENT_PRESENT'
    | 'RATE_SCHEDULE_AUTHORITY_UNAVAILABLE'
}

export type CommercialExcludedBenefitV3 =
  | CommercialExcludedSaasBenefitV3
  | CommercialUnselectedHardwareBenefitV3
  | CommercialExcludedHardwareExcessBenefitV3
  | CommercialInactiveHardwareBenefitV3
  | CommercialExcludedPaymentsRateBenefitV3

export interface CommercialOfferResolutionV3 {
  schemaVersion: 3
  resolutionVersion: 2
  campaignVersionId: string
  resolvedAt: string
  applied: CommercialAppliedBenefitV3[]
  exclusions: CommercialExcludedBenefitV3[]
}

export interface CommercialOfferResolutionInputV3 {
  offer: CommercialOfferSnapshotV3
  resolvedAt: string
  saasMatches: Array<{ lineKey: string; ruleCodes: string[] }>
  hardwareSelections: Array<{ catalogKey: string; quantity: number }>
  rateBlockers: CommercialRateBlockerV3[]
}

export type CommercialOfferBenefitDraftInputV3 =
  | {
      benefitCode: string
      kind: 'HARDWARE_PERCENT_OFF'
      priority: number
      hardwareCatalogKey: string
      percentBasisPoints: number
      quantityLimit: number
      benefitStartsAt: string
      benefitEndsAt: string
    }
  | {
      benefitCode: string
      kind: 'HARDWARE_FIXED_PRICE'
      priority: number
      hardwareCatalogKey: string
      unitAmountMinor: string
      quantityLimit: number
      benefitStartsAt: string
      benefitEndsAt: string
    }
  | {
      benefitCode: string
      kind: 'PAYMENTS_RATE_SCHEDULE'
      priority: number
      paymentsRateScheduleVersionId: string
    }

export interface CommercialOfferDraftViewV3 {
  id: string
  code: string
  name: string
  description?: string | null
  revision: number
  offerSchemaVersion: 3
  status: 'ACTIVE' | 'ARCHIVED'
  startsAt: string
  endsAt: string
  stackingGroups: CommercialCampaignDraftStackingGroupV2[]
  rules: CommercialCampaignDraftRuleV2[]
  offerBenefits: CommercialOfferBenefitDraftInputV3[]
  createdAt?: Date
  updatedAt?: Date
}
