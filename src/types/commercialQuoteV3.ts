import type { CommercialCampaignRuleTypeV2, CommercialCatalogSnapshotV2, CommercialEntitlementGrantV2 } from './commercialV2'
import type { CommercialBillingUnit, CommercialProductKind } from './commercial'
import type {
  CommercialOfferResolutionV3,
  CommercialOfferSnapshotV3,
  CommercialOfferV3DecodeInput,
  HardwareSkuSnapshotV3,
} from './commercialOfferV3'

export type CommercialMinorUnitV3 = string

export interface CommercialMoneyBreakdownV3 {
  listSubtotalMinor: CommercialMinorUnitV3
  discountMinor: CommercialMinorUnitV3
  subtotalMinor: CommercialMinorUnitV3
  taxMinor: CommercialMinorUnitV3
  totalMinor: CommercialMinorUnitV3
}

export interface CommercialAppliedSaasStepV3 {
  benefitCode: string
  ruleCode: string
  type: CommercialCampaignRuleTypeV2
  position: number
  inputAmountMinor: CommercialMinorUnitV3
  discountAmountMinor: CommercialMinorUnitV3
  outputAmountMinor: CommercialMinorUnitV3
  cycles: number
}

export interface CommercialQuoteSaasLineV3 {
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
  listUnitAmountMinor: CommercialMinorUnitV3
  listSubtotalMinor: CommercialMinorUnitV3
  appliedOfferSteps: CommercialAppliedSaasStepV3[]
  discountMinor: CommercialMinorUnitV3
  subtotalMinor: CommercialMinorUnitV3
  taxMinor: CommercialMinorUnitV3
  totalMinor: CommercialMinorUnitV3
  promotionalCycles: number | null
  renewalSubtotalMinor: CommercialMinorUnitV3
  renewalTaxMinor: CommercialMinorUnitV3
  renewalTotalMinor: CommercialMinorUnitV3
}

export type CommercialQuoteHardwareBenefitV3 =
  | {
      kind: 'HARDWARE_PERCENT_OFF'
      benefitCode: string
      percentBasisPoints: number
      appliedQuantity: number
    }
  | {
      kind: 'HARDWARE_FIXED_PRICE'
      benefitCode: string
      unitAmountMinor: CommercialMinorUnitV3
      appliedQuantity: number
    }

export interface CommercialQuoteHardwareLineV3 {
  lineKey: string
  catalogKey: string
  skuSnapshot: HardwareSkuSnapshotV3
  quantity: number
  benefitedQuantity: number
  listPriceQuantity: number
  appliedBenefit: CommercialQuoteHardwareBenefitV3 | null
  currency: 'MXN'
  taxRateBasisPoints: 1600
  listSubtotalMinor: CommercialMinorUnitV3
  discountMinor: CommercialMinorUnitV3
  subtotalMinor: CommercialMinorUnitV3
  taxMinor: CommercialMinorUnitV3
  totalMinor: CommercialMinorUnitV3
}

export type CommercialQuoteSubjectV3 =
  | { kind: 'ACQUISITION_CONTEXT'; acquisitionContextId: string }
  | { kind: 'VENUE'; organizationId: string; venueId: string; actorId: string }

export interface CommercialQuoteDerivedFromPreviewV3 {
  previewQuoteId: string
  previewChecksum: string
  selectionFingerprint: string
}

export interface CommercialQuoteSnapshotV3 {
  schemaVersion: 3
  contractVersion: '3.0.0'
  quoteId: string
  subject: CommercialQuoteSubjectV3
  acquisitionContextId: string | null
  derivedFromPreview: CommercialQuoteDerivedFromPreviewV3 | null
  catalogPublicationId: string
  catalogChecksum: string
  offerVersionId: string
  offerCode: string
  offerChecksum: string
  market: 'MX'
  currency: 'MXN'
  quotedAt: string
  expiresAt: string
  saasLines: CommercialQuoteSaasLineV3[]
  hardwareLines: CommercialQuoteHardwareLineV3[]
  entitlementGrants: CommercialEntitlementGrantV2[]
  resolution: CommercialOfferResolutionV3
  totals: {
    recurringCurrent: CommercialMoneyBreakdownV3
    oneTime: CommercialMoneyBreakdownV3
    dueNow: CommercialMoneyBreakdownV3
  }
  renewal: CommercialMoneyBreakdownV3
}

export interface CommercialQuoteV3CatalogAuthority {
  kind: 'CATALOG'
  schemaVersion: 2
  mode: 'READ_WRITE'
  snapshot: CommercialCatalogSnapshotV2
  checksum: string
}

export interface CommercialQuoteV3OfferAuthority extends Omit<CommercialOfferV3DecodeInput, 'snapshot' | 'checksum'> {
  snapshot: CommercialOfferSnapshotV3
  checksum: string
}

export interface CommercialQuoteV3AcquisitionContextAuthority {
  id: string
  createdAt: string | Date
}

export interface CommercialQuoteV3Authorities {
  catalog: CommercialQuoteV3CatalogAuthority
  offer: CommercialQuoteV3OfferAuthority
  acquisitionContext: CommercialQuoteV3AcquisitionContextAuthority | null
}

export interface EmittedCommercialQuoteV3 {
  kind: 'COMMERCIAL_QUOTE'
  schemaVersion: 3
  mode: 'READ_WRITE'
  snapshot: CommercialQuoteSnapshotV3
  checksum: string
}

export interface CommercialQuoteV3RowContext {
  id: string
  schemaVersion: number
  catalogPublicationId: string
  offerVersionId: string
  acquisitionContextId: string | null
  organizationId: string | null
  venueId: string | null
  createdById: string | null
  venueOrganizationId: string | null
  market: string
  currency: string
  quotedAt: Date
  expiresAt: Date
  listSubtotalMinor: bigint | number
  discountMinor: bigint | number
  subtotalMinor: bigint | number
  taxMinor: bigint | number
  totalMinor: bigint | number
  renewalSubtotalMinor: bigint | number
  renewalTaxMinor: bigint | number
  renewalTotalMinor: bigint | number
}

export interface CommercialQuoteV3DecodeInput {
  rowSchemaVersion: number
  snapshot: unknown
  checksum: unknown
  rowContext: CommercialQuoteV3RowContext
  authorities: CommercialQuoteV3Authorities
}

export type VerifiedStoredCommercialQuoteV3 = EmittedCommercialQuoteV3 & { verified: true }
