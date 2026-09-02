import { parseCommercialMoneyV2 } from './commercialMoneyV2.service'
import { failCommercialArtifactCodec } from './commercialArtifactCodecErrors.service'
import { isVerifiedObjectCandidate, readOwnData, toValidIso } from './commercialArtifactCodecBoundary.service'
import type { CommercialCampaignSnapshotV2, CommercialQuoteSnapshotV2 } from '@/types/commercialV2'
import type {
  CommercialCampaignRowContext,
  CommercialQuoteMoneyProjection,
  CommercialQuoteRowContext,
  CommercialQuoteVerifiedScope,
  DecodedCommercialCampaign,
  DecodedCommercialCatalog,
} from '@/types/commercialCodec'

function captureRow(kind: 'CAMPAIGN' | 'QUOTE', value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isVerifiedObjectCandidate(value)) failCommercialArtifactCodec(`COMMERCIAL_${kind}_IDENTITY_MISMATCH`)
  const captured: Record<string, unknown> = Object.create(null)
  try {
    for (const key of keys) captured[key] = readOwnData(value, key)
  } catch {
    failCommercialArtifactCodec(`COMMERCIAL_${kind}_IDENTITY_MISMATCH`)
  }
  return captured
}

export function assertCampaignV2Identity(snapshot: CommercialCampaignSnapshotV2, rowValue: unknown): void {
  const row = captureRow('CAMPAIGN', rowValue, [
    'kind',
    'id',
    'campaignCode',
    'sourceRevision',
    'schemaVersion',
    'publishedAt',
  ]) as unknown as CommercialCampaignRowContext
  const startsAt = Date.parse(snapshot.startsAt)
  const endsAt = Date.parse(snapshot.endsAt)
  if (
    row.kind !== 'CAMPAIGN' ||
    row.schemaVersion !== 2 ||
    row.id !== snapshot.campaignVersionId ||
    row.campaignCode !== snapshot.campaignCode ||
    row.sourceRevision !== snapshot.version ||
    toValidIso(row.publishedAt) !== snapshot.publishedAt ||
    !Number.isFinite(startsAt) ||
    !Number.isFinite(endsAt) ||
    startsAt >= endsAt
  ) {
    failCommercialArtifactCodec('COMMERCIAL_CAMPAIGN_IDENTITY_MISMATCH')
  }
}

export function projectCampaignMoneyV2(snapshot: CommercialCampaignSnapshotV2): DecodedCommercialCampaign['money'] {
  return {
    rules: snapshot.rules.flatMap(rule =>
      'amount' in rule ? [{ ruleCode: rule.code, amountMinor: parseCommercialMoneyV2(rule.amount) }] : [],
    ),
  }
}

function quoteTotals(snapshot: CommercialQuoteSnapshotV2): readonly bigint[] {
  return [
    snapshot.totals.listSubtotal,
    snapshot.totals.discount,
    snapshot.totals.subtotal,
    snapshot.totals.tax,
    snapshot.totals.total,
    snapshot.renewal.subtotal,
    snapshot.renewal.tax,
    snapshot.renewal.total,
  ].map(parseCommercialMoneyV2)
}

export function assertQuoteV2Identity(
  snapshot: CommercialQuoteSnapshotV2,
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
  const rowMoney = [
    row.listSubtotalMinor,
    row.discountMinor,
    row.subtotalMinor,
    row.taxMinor,
    row.totalMinor,
    row.renewalSubtotalMinor,
    row.renewalTaxMinor,
    row.renewalTotalMinor,
  ]
  const snapshotMoney = quoteTotals(snapshot)
  const catalogSnapshot = catalog.snapshot as { publicationId?: unknown }
  const campaignSnapshot = campaign?.snapshot as { campaignVersionId?: unknown; campaignCode?: unknown } | undefined
  const campaignMatches =
    snapshot.campaignVersionId === null
      ? campaign === null
      : campaign?.schemaVersion === 2 &&
        campaignSnapshot?.campaignVersionId === snapshot.campaignVersionId &&
        campaignSnapshot.campaignCode === snapshot.campaignCode
  const quotedAt = toValidIso(row.quotedAt)
  const expiresAt = toValidIso(row.expiresAt)
  if (
    row.kind !== 'QUOTE' ||
    row.schemaVersion !== 2 ||
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
    rowMoney.some(value => typeof value !== 'bigint' || value < 0n) ||
    rowMoney.some((value, index) => value !== snapshotMoney[index]) ||
    catalog.schemaVersion !== 2 ||
    catalogSnapshot.publicationId !== snapshot.catalogPublicationId ||
    !campaignMatches
  ) {
    failCommercialArtifactCodec('COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
  }

  if (snapshot.subject.kind === 'ACQUISITION_CONTEXT') {
    if (
      row.acquisitionContextId === snapshot.subject.acquisitionContextId &&
      row.acquisitionContextId === snapshot.acquisitionContextId &&
      row.organizationId === null &&
      row.venueId === null &&
      row.createdById === null &&
      row.venueOrganizationId === null
    ) {
      return {
        scope: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: snapshot.subject.acquisitionContextId },
        lineage: { acquisitionContextId: snapshot.acquisitionContextId },
      }
    }
    return failCommercialArtifactCodec('COMMERCIAL_QUOTE_SCOPE_MISMATCH')
  }

  if (
    row.organizationId === snapshot.subject.organizationId &&
    row.venueId === snapshot.subject.venueId &&
    row.createdById === snapshot.subject.actorId &&
    row.venueOrganizationId === snapshot.subject.organizationId &&
    row.acquisitionContextId === snapshot.acquisitionContextId
  ) {
    return {
      scope: {
        kind: 'VENUE',
        organizationId: snapshot.subject.organizationId,
        venueId: snapshot.subject.venueId,
        actorId: snapshot.subject.actorId,
      },
      lineage: { acquisitionContextId: snapshot.acquisitionContextId },
    }
  }
  return failCommercialArtifactCodec('COMMERCIAL_QUOTE_SCOPE_MISMATCH')
}

export function projectQuoteMoneyV2(snapshot: CommercialQuoteSnapshotV2): CommercialQuoteMoneyProjection {
  return {
    lines: snapshot.lines.map(line => ({
      lineKey: line.lineKey,
      unitAmountMinor: parseCommercialMoneyV2(line.unitAmount),
      listSubtotalMinor: parseCommercialMoneyV2(line.listSubtotal),
      discountMinor: parseCommercialMoneyV2(line.discount),
      subtotalMinor: parseCommercialMoneyV2(line.subtotal),
      taxMinor: parseCommercialMoneyV2(line.tax),
      totalMinor: parseCommercialMoneyV2(line.total),
      renewalSubtotalMinor: parseCommercialMoneyV2(line.renewalSubtotal),
      renewalTaxMinor: parseCommercialMoneyV2(line.renewalTax),
      renewalTotalMinor: parseCommercialMoneyV2(line.renewalTotal),
      adjustments: line.appliedCampaigns.map(step => ({
        ruleCode: step.ruleCode,
        inputAmountMinor: parseCommercialMoneyV2(step.inputAmount),
        discountAmountMinor: parseCommercialMoneyV2(step.discountAmount),
        outputAmountMinor: parseCommercialMoneyV2(step.outputAmount),
        discountMinor: parseCommercialMoneyV2(step.discountAmount),
      })),
    })),
    totals: {
      listSubtotalMinor: parseCommercialMoneyV2(snapshot.totals.listSubtotal),
      discountMinor: parseCommercialMoneyV2(snapshot.totals.discount),
      subtotalMinor: parseCommercialMoneyV2(snapshot.totals.subtotal),
      taxMinor: parseCommercialMoneyV2(snapshot.totals.tax),
      totalMinor: parseCommercialMoneyV2(snapshot.totals.total),
    },
    renewal: {
      subtotalMinor: parseCommercialMoneyV2(snapshot.renewal.subtotal),
      taxMinor: parseCommercialMoneyV2(snapshot.renewal.tax),
      totalMinor: parseCommercialMoneyV2(snapshot.renewal.total),
    },
  }
}
