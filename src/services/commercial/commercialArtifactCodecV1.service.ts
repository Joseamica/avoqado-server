import Ajv from 'ajv'
import campaignSchema from '@/contracts/commercial/commercial-campaign-v1.schema.json'
import quoteSchema from '@/contracts/commercial/commercial-quote-v1.schema.json'
import { artifactCode, failCommercialArtifactCodec } from './commercialArtifactCodecErrors.service'
import { isVerifiedObjectCandidate, readOwnData, toValidIso } from './commercialArtifactCodecBoundary.service'
import type { CommercialCampaignVersionV1, CommercialQuoteV1 } from '@/types/commercialQuote'
import type {
  CommercialCampaignRowContext,
  CommercialQuoteMoneyProjection,
  CommercialQuoteRowContext,
  CommercialQuoteVerifiedScope,
  DecodedCommercialCampaign,
  DecodedCommercialCatalog,
} from '@/types/commercialCodec'

const ajv = new Ajv({ allErrors: true, jsonPointers: true })
const validateCampaign = ajv.compile(campaignSchema)
const validateQuote = ajv.compile(quoteSchema)

function captureRow(kind: 'CAMPAIGN' | 'QUOTE', value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isVerifiedObjectCandidate(value)) failCommercialArtifactCodec(artifactCode(kind, 'IDENTITY_MISMATCH'))
  const captured: Record<string, unknown> = Object.create(null)
  try {
    for (const key of keys) captured[key] = readOwnData(value, key)
  } catch {
    failCommercialArtifactCodec(artifactCode(kind, 'IDENTITY_MISMATCH'))
  }
  return captured
}

function validWindow(startsAt: string, endsAt: string): boolean {
  const start = Date.parse(startsAt)
  const end = Date.parse(endsAt)
  return Number.isFinite(start) && Number.isFinite(end) && start < end
}

export function assertCampaignV1Shape(snapshot: unknown): asserts snapshot is CommercialCampaignVersionV1 {
  if (!validateCampaign(snapshot)) failCommercialArtifactCodec('COMMERCIAL_CAMPAIGN_SHAPE_INVALID')
}

export function assertCampaignV1Identity(snapshot: CommercialCampaignVersionV1, rowValue: unknown): void {
  const row = captureRow('CAMPAIGN', rowValue, [
    'kind',
    'id',
    'campaignCode',
    'sourceRevision',
    'schemaVersion',
    'publishedAt',
  ]) as unknown as CommercialCampaignRowContext
  if (
    row.kind !== 'CAMPAIGN' ||
    row.schemaVersion !== 1 ||
    row.id !== snapshot.campaignVersionId ||
    row.campaignCode !== snapshot.campaignCode ||
    row.sourceRevision !== snapshot.version ||
    toValidIso(row.publishedAt) === null ||
    !validWindow(snapshot.startsAt, snapshot.endsAt)
  ) {
    failCommercialArtifactCodec('COMMERCIAL_CAMPAIGN_IDENTITY_MISMATCH')
  }
}

export function projectCampaignMoneyV1(snapshot: CommercialCampaignVersionV1): DecodedCommercialCampaign['money'] {
  return {
    rules: snapshot.rules.flatMap(rule => ('amountMinor' in rule ? [{ ruleCode: rule.code, amountMinor: BigInt(rule.amountMinor) }] : [])),
  }
}

export function assertQuoteV1Shape(snapshot: unknown): asserts snapshot is CommercialQuoteV1 {
  if (!validateQuote(snapshot)) failCommercialArtifactCodec('COMMERCIAL_QUOTE_SHAPE_INVALID')
}

export function assertQuoteV1CampaignPair(snapshot: CommercialQuoteV1): void {
  if ((snapshot.campaignVersionId === null) !== (snapshot.campaignCode === null)) {
    failCommercialArtifactCodec('COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
  }
}

function rowMinorV1(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
}

function quoteTotalsV1(snapshot: CommercialQuoteV1): readonly bigint[] {
  return [
    snapshot.totals.listSubtotalMinor,
    snapshot.totals.discountMinor,
    snapshot.totals.subtotalMinor,
    snapshot.totals.taxMinor,
    snapshot.totals.totalMinor,
    snapshot.renewal.subtotalMinor,
    snapshot.renewal.taxMinor,
    snapshot.renewal.totalMinor,
  ].map(BigInt)
}

export function assertQuoteV1Identity(
  snapshot: CommercialQuoteV1,
  rowValue: unknown,
  catalog: DecodedCommercialCatalog,
  campaign: DecodedCommercialCampaign | null,
): CommercialQuoteVerifiedScope {
  const keys = [
    'kind',
    'id',
    'catalogPublicationId',
    'campaignVersionId',
    'acquisitionContextId',
    'organizationId',
    'venueId',
    'createdById',
    'schemaVersion',
    'market',
    'currency',
    'quotedAt',
    'expiresAt',
    'listSubtotalMinor',
    'discountMinor',
    'subtotalMinor',
    'taxMinor',
    'totalMinor',
    'renewalSubtotalMinor',
    'renewalTaxMinor',
    'renewalTotalMinor',
    'venueOrganizationId',
  ] as const
  const row = captureRow('QUOTE', rowValue, keys) as unknown as CommercialQuoteRowContext
  const moneyKeys = [
    'listSubtotalMinor',
    'discountMinor',
    'subtotalMinor',
    'taxMinor',
    'totalMinor',
    'renewalSubtotalMinor',
    'renewalTaxMinor',
    'renewalTotalMinor',
  ] as const
  const rowMoney = moneyKeys.map(key => rowMinorV1(row[key]))
  const snapshotMoney = quoteTotalsV1(snapshot)
  const quotedAt = toValidIso(row.quotedAt)
  const expiresAt = toValidIso(row.expiresAt)
  const catalogSnapshot = catalog.snapshot as { publicationId?: unknown }
  const campaignSnapshot = campaign?.snapshot as { campaignVersionId?: unknown; campaignCode?: unknown } | undefined
  const campaignMatches =
    snapshot.campaignVersionId === null
      ? campaign === null
      : campaign?.schemaVersion === 1 &&
        campaignSnapshot?.campaignVersionId === snapshot.campaignVersionId &&
        campaignSnapshot.campaignCode === snapshot.campaignCode
  if (
    row.kind !== 'QUOTE' ||
    row.schemaVersion !== 1 ||
    row.id !== snapshot.quoteId ||
    row.catalogPublicationId !== snapshot.catalogPublicationId ||
    row.campaignVersionId !== snapshot.campaignVersionId ||
    row.market !== snapshot.market ||
    row.currency !== snapshot.currency ||
    quotedAt !== snapshot.quotedAt ||
    expiresAt !== snapshot.expiresAt ||
    quotedAt === null ||
    expiresAt === null ||
    Date.parse(quotedAt) >= Date.parse(expiresAt) ||
    rowMoney.some(value => value === null) ||
    rowMoney.some((value, index) => value !== snapshotMoney[index]) ||
    catalog.schemaVersion !== 1 ||
    catalogSnapshot.publicationId !== snapshot.catalogPublicationId ||
    !campaignMatches
  ) {
    failCommercialArtifactCodec('COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
  }

  if (row.acquisitionContextId !== null && (typeof row.acquisitionContextId !== 'string' || row.acquisitionContextId.length === 0)) {
    failCommercialArtifactCodec('COMMERCIAL_QUOTE_SCOPE_MISMATCH')
  }
  const lineage = { acquisitionContextId: row.acquisitionContextId }

  const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  const allVenue = validId(row.organizationId) && validId(row.venueId) && validId(row.createdById)
  const allUnscoped = row.organizationId === null && row.venueId === null && row.createdById === null
  if (allVenue && row.venueOrganizationId === row.organizationId) {
    return {
      scope: { kind: 'LEGACY_VENUE', organizationId: row.organizationId!, venueId: row.venueId!, actorId: row.createdById! },
      lineage,
    }
  }
  if (allUnscoped && row.venueOrganizationId === null) return { scope: { kind: 'LEGACY_UNSCOPED' }, lineage }
  return failCommercialArtifactCodec('COMMERCIAL_QUOTE_SCOPE_MISMATCH')
}

export function projectQuoteMoneyV1(snapshot: CommercialQuoteV1): CommercialQuoteMoneyProjection {
  return {
    lines: snapshot.lines.map(line => ({
      lineKey: `${line.targetType}:${line.targetCode}:${line.priceCode}`,
      unitAmountMinor: BigInt(line.unitAmountMinor),
      listSubtotalMinor: BigInt(line.listSubtotalMinor),
      discountMinor: BigInt(line.discountMinor),
      subtotalMinor: BigInt(line.subtotalMinor),
      taxMinor: BigInt(line.taxMinor),
      totalMinor: BigInt(line.totalMinor),
      renewalSubtotalMinor: BigInt(line.renewalSubtotalMinor),
      renewalTaxMinor: BigInt(line.renewalTaxMinor),
      renewalTotalMinor: BigInt(line.renewalTotalMinor),
      adjustments: line.adjustments.map(adjustment => ({
        ruleCode: adjustment.ruleCode,
        beforeMinor: BigInt(adjustment.beforeMinor),
        afterMinor: BigInt(adjustment.afterMinor),
        discountMinor: BigInt(adjustment.discountMinor),
      })),
    })),
    totals: {
      listSubtotalMinor: BigInt(snapshot.totals.listSubtotalMinor),
      discountMinor: BigInt(snapshot.totals.discountMinor),
      subtotalMinor: BigInt(snapshot.totals.subtotalMinor),
      taxMinor: BigInt(snapshot.totals.taxMinor),
      totalMinor: BigInt(snapshot.totals.totalMinor),
    },
    renewal: {
      subtotalMinor: BigInt(snapshot.renewal.subtotalMinor),
      taxMinor: BigInt(snapshot.renewal.taxMinor),
      totalMinor: BigInt(snapshot.renewal.totalMinor),
    },
  }
}
