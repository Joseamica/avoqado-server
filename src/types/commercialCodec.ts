export type CommercialPersistedArtifactKind = 'CATALOG' | 'CAMPAIGN' | 'QUOTE'
export type CommercialCodecMode = 'READ_ONLY' | 'READ_WRITE'

export interface CommercialArtifactCodecRegistration {
  kind: CommercialPersistedArtifactKind
  schemaVersion: 1 | 2
  mode: CommercialCodecMode
}

export interface CommercialCatalogRowContext {
  kind: 'CATALOG'
  id: string
  schemaVersion: number
  publishedAt: Date
}

export interface CommercialCatalogDecodeInput {
  kind: 'CATALOG'
  rowSchemaVersion: number
  snapshot: unknown
  checksum: unknown
  rowContext: CommercialCatalogRowContext
  authorities?: never
}

export interface CommercialCatalogMoneyProjection {
  prices: readonly {
    ownerType: 'PRODUCT' | 'BUNDLE'
    ownerCode: string
    priceCode: string
    amountMinor: bigint
  }[]
}

export interface DecodedCommercialCatalog {
  kind: 'CATALOG'
  schemaVersion: 1 | 2
  mode: CommercialCodecMode
  snapshot: unknown
  checksum: string
  money: CommercialCatalogMoneyProjection
}

export interface CommercialCampaignRowContext {
  kind: 'CAMPAIGN'
  id: string
  campaignCode: string
  sourceRevision: number
  schemaVersion: number
  publishedAt: Date
}

export interface CommercialCampaignDecodeInput {
  kind: 'CAMPAIGN'
  rowSchemaVersion: number
  snapshot: unknown
  checksum: unknown
  rowContext: CommercialCampaignRowContext
  authorities?: never
}

export interface CommercialCampaignMoneyProjection {
  rules: readonly { ruleCode: string; amountMinor: bigint }[]
}

export interface DecodedCommercialCampaign {
  kind: 'CAMPAIGN'
  schemaVersion: 1 | 2
  mode: CommercialCodecMode
  snapshot: unknown
  checksum: string
  money: CommercialCampaignMoneyProjection
}

export interface CommercialQuoteRowContext {
  kind: 'QUOTE'
  id: string
  catalogPublicationId: string
  campaignVersionId: string | null
  acquisitionContextId: string | null
  organizationId: string | null
  venueId: string | null
  createdById: string | null
  schemaVersion: number
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
  venueOrganizationId: string | null
}

export interface CommercialQuoteDecodeInput {
  kind: 'QUOTE'
  rowSchemaVersion: number
  snapshot: unknown
  checksum: unknown
  rowContext: CommercialQuoteRowContext
  authorities: {
    catalog: CommercialCatalogDecodeInput
    campaign: CommercialCampaignDecodeInput | null
  }
}

export interface CommercialQuoteMoneyProjection {
  lines: readonly {
    lineKey: string
    unitAmountMinor: bigint
    listSubtotalMinor: bigint
    discountMinor: bigint
    subtotalMinor: bigint
    taxMinor: bigint
    totalMinor: bigint
    renewalSubtotalMinor: bigint
    renewalTaxMinor: bigint
    renewalTotalMinor: bigint
    adjustments: readonly {
      ruleCode: string
      beforeMinor?: bigint
      afterMinor?: bigint
      inputAmountMinor?: bigint
      outputAmountMinor?: bigint
      discountAmountMinor?: bigint
      discountMinor: bigint
    }[]
  }[]
  totals: {
    listSubtotalMinor: bigint
    discountMinor: bigint
    subtotalMinor: bigint
    taxMinor: bigint
    totalMinor: bigint
  }
  renewal: {
    subtotalMinor: bigint
    taxMinor: bigint
    totalMinor: bigint
  }
}

export type CommercialQuoteScope =
  | { kind: 'LEGACY_VENUE'; organizationId: string; venueId: string; actorId: string }
  | { kind: 'LEGACY_UNSCOPED' }
  | { kind: 'ACQUISITION_CONTEXT'; acquisitionContextId: string }
  | { kind: 'VENUE'; organizationId: string; venueId: string; actorId: string }

export interface CommercialQuoteVerifiedScope {
  scope: CommercialQuoteScope
  lineage: { acquisitionContextId: string | null }
}

export interface DecodedCommercialQuote {
  kind: 'QUOTE'
  schemaVersion: 1 | 2
  mode: CommercialCodecMode
  snapshot: unknown
  checksum: string
  money: CommercialQuoteMoneyProjection
  scope: CommercialQuoteScope
  lineage: { acquisitionContextId: string | null }
}

export type DecodedCommercialQuoteV2 = DecodedCommercialQuote & { schemaVersion: 2; mode: 'READ_WRITE' }

export interface CommercialCatalogEmitInputV2 {
  kind: 'CATALOG'
  schemaVersion: 2
  domainValue: unknown
  authorities?: never
}

export interface CommercialCampaignEmitInputV2 {
  kind: 'CAMPAIGN'
  schemaVersion: 2
  domainValue: unknown
  authorities?: never
}

export interface CommercialQuoteEmitInputV2 {
  kind: 'QUOTE'
  schemaVersion: 2
  domainValue: unknown
  authorities: {
    catalog: VerifiedCommercialArtifactV2
    campaign: VerifiedCommercialArtifactV2 | null
  }
}

export type CommercialArtifactEmitInputV2 = CommercialCatalogEmitInputV2 | CommercialCampaignEmitInputV2 | CommercialQuoteEmitInputV2

export interface CommercialRuntimeEmitInput {
  kind: CommercialPersistedArtifactKind
  schemaVersion: number
  domainValue: unknown
  authorities?: unknown
}

export interface EmittedCommercialArtifactV2 {
  kind: CommercialPersistedArtifactKind
  schemaVersion: 2
  mode: 'READ_WRITE'
  snapshot: unknown
  checksum: string
  money: CommercialCatalogMoneyProjection | CommercialCampaignMoneyProjection | CommercialQuoteMoneyProjection
}

export type VerifiedCommercialArtifactV2 =
  | (DecodedCommercialCatalog & { schemaVersion: 2 })
  | (DecodedCommercialCampaign & { schemaVersion: 2 })
  | EmittedCommercialArtifactV2

export type CommercialArtifactDecodeInput = CommercialCatalogDecodeInput | CommercialCampaignDecodeInput | CommercialQuoteDecodeInput
export type DecodedCommercialArtifact = DecodedCommercialCatalog | DecodedCommercialCampaign | DecodedCommercialQuote

export interface CommercialCatalogPersistedRow {
  id: string
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

export type CommercialCatalogActivationEventType = 'PUBLICATION_ACTIVATED' | 'PUBLICATION_ROLLED_BACK'

export interface CommercialCatalogActivationOutboxRecord {
  id: string
  eventType: CommercialCatalogActivationEventType
  publicationId: string
  previousPublicationId: string | null
  payloadVersion: number
  payload: unknown
  dedupeKey: string
  createdAt: Date
  publication: CommercialCatalogPersistedRow
  previousPublication: CommercialCatalogPersistedRow | null
}

export interface CommercialCatalogResolutionInput {
  activePointer: {
    environment: 'PRODUCTION' | 'PREVIEW'
    publicationId: string
    revision: number
  }
  activePublication: CommercialCatalogPersistedRow
  activationEvents: readonly CommercialCatalogActivationOutboxRecord[]
}

export interface PublicCommercialCatalogFallbackMetadata {
  fallbackUsed: true
  activePublicationId: string
  fallbackPublicationId: string
  incidentCode: 'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED'
}

export interface PublicCommercialCatalogResolution {
  catalog: DecodedCommercialCatalog
  fallback: PublicCommercialCatalogFallbackMetadata | null
}
