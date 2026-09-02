import type { CommercialCampaignDecodeInput, CommercialCatalogDecodeInput, CommercialQuoteDecodeInput } from '@/types/commercialCodec'

const INTEGER_TEXT = /^-?[0-9]+$/u
const UTC_MILLISECOND = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u
const INT4_MIN = -2_147_483_648n
const INT4_MAX = 2_147_483_647n

export type CommercialContractV2RowBuilderCode =
  | 'COMMERCIAL_CONTRACT_V2_ROW_DECIMAL_TEXT_INVALID'
  | 'COMMERCIAL_CONTRACT_V2_ROW_INT4_RANGE'
  | 'COMMERCIAL_CONTRACT_V2_ROW_TIMESTAMP_INVALID'

export class CommercialContractV2RowBuilderError extends Error {
  constructor(readonly code: CommercialContractV2RowBuilderCode) {
    super(code)
    this.name = 'CommercialContractV2RowBuilderError'
  }
}

function rowBuildFail(code: CommercialContractV2RowBuilderCode): never {
  throw new CommercialContractV2RowBuilderError(code)
}

export function parseCommercialContractV2DecimalText(value: string): bigint {
  if (!INTEGER_TEXT.test(value)) rowBuildFail('COMMERCIAL_CONTRACT_V2_ROW_DECIMAL_TEXT_INVALID')
  return BigInt(value)
}

export function parseCommercialContractV2Int4Text(value: string): bigint {
  const parsed = parseCommercialContractV2DecimalText(value)
  if (parsed < INT4_MIN || parsed > INT4_MAX) rowBuildFail('COMMERCIAL_CONTRACT_V2_ROW_INT4_RANGE')
  return parsed
}

export function parseCommercialContractV2UtcMillisecond(value: string): Date {
  if (!UTC_MILLISECOND.test(value)) rowBuildFail('COMMERCIAL_CONTRACT_V2_ROW_TIMESTAMP_INVALID')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    rowBuildFail('COMMERCIAL_CONTRACT_V2_ROW_TIMESTAMP_INVALID')
  }
  return date
}

export interface CommercialContractV2PublicationRow {
  id: string
  schemaVersion: number
  snapshot: unknown
  checksum: string
}

export interface CommercialContractV2CampaignRow extends CommercialContractV2PublicationRow {
  campaignCode: string
  sourceRevision: number
}

export interface CommercialContractV2QuoteRow extends CommercialContractV2PublicationRow {
  catalogPublicationId: string
  campaignVersionId: string | null
  acquisitionContextId: string | null
  organizationId: string | null
  venueId: string | null
  createdById: string | null
  market: string
  currency: string
}

export interface CommercialContractV2QuoteMoney {
  listSubtotalMinor: bigint
  discountMinor: bigint
  subtotalMinor: bigint
  taxMinor: bigint
  totalMinor: bigint
  renewalSubtotalMinor: bigint
  renewalTaxMinor: bigint
  renewalTotalMinor: bigint
}

export function buildCommercialContractV2PublicationEnvelope(
  row: CommercialContractV2PublicationRow,
  publishedAt: Date,
): CommercialCatalogDecodeInput {
  return {
    kind: 'CATALOG',
    rowSchemaVersion: row.schemaVersion,
    snapshot: row.snapshot,
    checksum: row.checksum,
    rowContext: { kind: 'CATALOG', id: row.id, schemaVersion: row.schemaVersion, publishedAt },
  }
}

export function buildCommercialContractV2CampaignEnvelope(
  row: CommercialContractV2CampaignRow,
  publishedAt: Date,
): CommercialCampaignDecodeInput {
  return {
    kind: 'CAMPAIGN',
    rowSchemaVersion: row.schemaVersion,
    snapshot: row.snapshot,
    checksum: row.checksum,
    rowContext: {
      kind: 'CAMPAIGN',
      id: row.id,
      campaignCode: row.campaignCode,
      sourceRevision: row.sourceRevision,
      schemaVersion: row.schemaVersion,
      publishedAt,
    },
  }
}

export function buildCommercialContractV2QuoteEnvelope(
  row: CommercialContractV2QuoteRow,
  quotedAt: Date,
  expiresAt: Date,
  money: CommercialContractV2QuoteMoney,
  venueOrganizationId: string | null,
  authorities: CommercialQuoteDecodeInput['authorities'],
): CommercialQuoteDecodeInput {
  return {
    kind: 'QUOTE',
    rowSchemaVersion: row.schemaVersion,
    snapshot: row.snapshot,
    checksum: row.checksum,
    rowContext: {
      kind: 'QUOTE',
      id: row.id,
      catalogPublicationId: row.catalogPublicationId,
      campaignVersionId: row.campaignVersionId,
      acquisitionContextId: row.acquisitionContextId,
      organizationId: row.organizationId,
      venueId: row.venueId,
      createdById: row.createdById,
      schemaVersion: row.schemaVersion,
      market: row.market,
      currency: row.currency,
      quotedAt,
      expiresAt,
      ...money,
      venueOrganizationId,
    },
    authorities,
  }
}
