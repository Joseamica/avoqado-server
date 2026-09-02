import type { Prisma } from '@prisma/client'
import AppError from '@/errors/AppError'
import { assertEmittedCommercialQuoteV2, type QuoteV2Result } from './commercialArtifactCodecRegistry.service'
import { assertCommercialJsonValue } from './commercialJsonBoundary.service'
import { parseCommercialMoneyV2 } from './commercialMoneyV2.service'

export interface CommercialQuotePersistenceTransaction {
  commercialQuote: {
    create(input: { data: Prisma.CommercialQuoteUncheckedCreateInput }): Promise<{ id: string }>
  }
  activityLog: {
    create(input: { data: Prisma.ActivityLogUncheckedCreateInput }): Promise<unknown>
  }
}

export interface PersistedCommercialQuoteV2 {
  id: string
  snapshot: QuoteV2Result['snapshot']
  checksum: string
}

function quoteDate(value: string): Date {
  const result = new Date(value)
  if (!Number.isFinite(result.getTime()) || result.toISOString() !== value) {
    throw new AppError('La vigencia de la cotización es inválida.', 422, true, 'COMMERCIAL_QUOTE_INVALID_WINDOW')
  }
  return result
}

export async function persistCommercialQuoteV2(
  result: QuoteV2Result,
  tx: CommercialQuotePersistenceTransaction,
): Promise<PersistedCommercialQuoteV2> {
  assertEmittedCommercialQuoteV2(result)
  const { snapshot } = result
  if (snapshot.subject.kind !== 'VENUE') {
    throw new AppError('La cotización debe pertenecer a una sucursal.', 422, true, 'COMMERCIAL_QUOTE_SCOPE_MISMATCH')
  }

  const quotedAt = quoteDate(snapshot.quotedAt)
  const expiresAt = quoteDate(snapshot.expiresAt)
  const auditData = assertCommercialJsonValue({
    schemaVersion: 2,
    catalogPublicationId: snapshot.catalogPublicationId,
    campaignVersionId: snapshot.campaignVersionId,
    acquisitionContextId: snapshot.acquisitionContextId,
    total: snapshot.totals.total,
    renewalTotal: snapshot.renewal.total,
    expiresAt: snapshot.expiresAt,
  })
  const persisted = await tx.commercialQuote.create({
    data: {
      id: snapshot.quoteId,
      catalogPublicationId: snapshot.catalogPublicationId,
      campaignVersionId: snapshot.campaignVersionId,
      acquisitionContextId: snapshot.acquisitionContextId,
      organizationId: snapshot.subject.organizationId,
      venueId: snapshot.subject.venueId,
      createdById: snapshot.subject.actorId,
      schemaVersion: 2,
      market: snapshot.market,
      currency: snapshot.currency,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      checksum: result.checksum,
      listSubtotalMinor: parseCommercialMoneyV2(snapshot.totals.listSubtotal),
      discountMinor: parseCommercialMoneyV2(snapshot.totals.discount),
      subtotalMinor: parseCommercialMoneyV2(snapshot.totals.subtotal),
      taxMinor: parseCommercialMoneyV2(snapshot.totals.tax),
      totalMinor: parseCommercialMoneyV2(snapshot.totals.total),
      renewalSubtotalMinor: parseCommercialMoneyV2(snapshot.renewal.subtotal),
      renewalTaxMinor: parseCommercialMoneyV2(snapshot.renewal.tax),
      renewalTotalMinor: parseCommercialMoneyV2(snapshot.renewal.total),
      quotedAt,
      expiresAt,
    },
  })

  await tx.activityLog.create({
    data: {
      organizationId: snapshot.subject.organizationId,
      venueId: snapshot.subject.venueId,
      actorType: 'HUMAN',
      staffId: snapshot.subject.actorId,
      actorStaffId: snapshot.subject.actorId,
      action: 'COMMERCIAL_QUOTE_CREATED',
      entity: 'CommercialQuote',
      entityId: snapshot.quoteId,
      data: auditData,
    },
  })

  return { id: persisted.id, snapshot, checksum: result.checksum }
}
