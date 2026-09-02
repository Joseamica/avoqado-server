import type { Prisma } from '@prisma/client'

import AppError from '@/errors/AppError'
import { assertCommercialJsonValue } from '@/services/commercial/commercialJsonBoundary.service'
import {
  CommercialQuoteV3Error,
  decodeAndVerifyStoredCommercialQuoteV3,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Contract.service'
import type { CommercialQuoteV3Authorities, EmittedCommercialQuoteV3 } from '@/types/commercialQuoteV3'

export interface CommercialQuoteV3PersistenceTransaction {
  loadAuthorities(input: {
    catalogPublicationId: string
    offerVersionId: string
    organizationId: string
    venueId: string
  }): Promise<CommercialQuoteV3Authorities | null>
  commercialQuote: {
    create(input: { data: Prisma.CommercialQuoteUncheckedCreateInput }): Promise<{ id: string }>
  }
  activityLog: {
    create(input: { data: Prisma.ActivityLogUncheckedCreateInput }): Promise<unknown>
  }
}

export interface PersistedCommercialQuoteV3 {
  id: string
  snapshot: EmittedCommercialQuoteV3['snapshot']
  checksum: string
}

export interface CommercialQuoteV3PersistenceAuditContext {
  correlationId: string
}

export interface CommercialQuoteV3BridgePersistenceContext {
  actorId: string
  acquisitionContext: {
    id: string
    createdAt: Date
  }
  preview: {
    quoteId: string
    checksum: string
    selectionFingerprint: string
  }
}

function exactDate(value: string): Date {
  const result = new Date(value)
  if (!Number.isFinite(result.getTime()) || result.toISOString() !== value) {
    throw new AppError('COMMERCIAL_QUOTE_V3_WINDOW_INVALID', 422, true, 'COMMERCIAL_QUOTE_V3_WINDOW_INVALID')
  }
  return result
}

function exactMinor(value: string): bigint {
  try {
    return BigInt(value)
  } catch {
    throw new AppError('COMMERCIAL_QUOTE_V3_MONEY_INVALID', 422, true, 'COMMERCIAL_QUOTE_V3_MONEY_INVALID')
  }
}

async function persistVerifiedVenueQuoteV3(
  emitted: EmittedCommercialQuoteV3,
  tx: CommercialQuoteV3PersistenceTransaction,
  acquisitionContextId: string | null,
  auditContext?: CommercialQuoteV3PersistenceAuditContext,
): Promise<PersistedCommercialQuoteV3> {
  const snapshot = emitted?.snapshot
  if (snapshot?.subject?.kind !== 'VENUE') {
    throw new AppError('COMMERCIAL_QUOTE_V3_SCOPE_MISMATCH', 422, true, 'COMMERCIAL_QUOTE_V3_SCOPE_MISMATCH')
  }
  const subject = snapshot.subject

  const authorities = await tx.loadAuthorities({
    catalogPublicationId: snapshot.catalogPublicationId,
    offerVersionId: snapshot.offerVersionId,
    organizationId: subject.organizationId,
    venueId: subject.venueId,
  })
  if (authorities === null) {
    throw new AppError('COMMERCIAL_QUOTE_V3_AUTHORITY_UNAVAILABLE', 409, true, 'COMMERCIAL_QUOTE_V3_AUTHORITY_UNAVAILABLE')
  }

  let verified: ReturnType<typeof decodeAndVerifyStoredCommercialQuoteV3>
  try {
    verified = decodeAndVerifyStoredCommercialQuoteV3({
      rowSchemaVersion: 3,
      snapshot,
      checksum: emitted.checksum,
      rowContext: {
        id: snapshot.quoteId,
        schemaVersion: 3,
        catalogPublicationId: snapshot.catalogPublicationId,
        offerVersionId: snapshot.offerVersionId,
        acquisitionContextId,
        organizationId: subject.organizationId,
        venueId: subject.venueId,
        createdById: subject.actorId,
        venueOrganizationId: subject.organizationId,
        market: snapshot.market,
        currency: snapshot.currency,
        quotedAt: exactDate(snapshot.quotedAt),
        expiresAt: exactDate(snapshot.expiresAt),
        listSubtotalMinor: exactMinor(snapshot.totals.dueNow.listSubtotalMinor),
        discountMinor: exactMinor(snapshot.totals.dueNow.discountMinor),
        subtotalMinor: exactMinor(snapshot.totals.dueNow.subtotalMinor),
        taxMinor: exactMinor(snapshot.totals.dueNow.taxMinor),
        totalMinor: exactMinor(snapshot.totals.dueNow.totalMinor),
        renewalSubtotalMinor: exactMinor(snapshot.renewal.subtotalMinor),
        renewalTaxMinor: exactMinor(snapshot.renewal.taxMinor),
        renewalTotalMinor: exactMinor(snapshot.renewal.totalMinor),
      },
      authorities,
    })
  } catch (error) {
    if (error instanceof AppError) throw error
    if (error instanceof CommercialQuoteV3Error) {
      throw new AppError(error.code, 409, true, error.code)
    }
    throw error
  }

  const quotedAt = exactDate(verified.snapshot.quotedAt)
  const expiresAt = exactDate(verified.snapshot.expiresAt)
  const dueNow = verified.snapshot.totals.dueNow
  const renewal = verified.snapshot.renewal
  if (verified.snapshot.subject.kind !== 'VENUE') {
    throw new AppError('COMMERCIAL_QUOTE_V3_SCOPE_MISMATCH', 422, true, 'COMMERCIAL_QUOTE_V3_SCOPE_MISMATCH')
  }
  const verifiedSubject = verified.snapshot.subject
  const auditData = assertCommercialJsonValue({
    schemaVersion: 3,
    catalogPublicationId: verified.snapshot.catalogPublicationId,
    offerVersionId: verified.snapshot.offerVersionId,
    ...(acquisitionContextId === null ? {} : { acquisitionContextId }),
    ...(verified.snapshot.derivedFromPreview === null
      ? {}
      : { previewQuoteId: verified.snapshot.derivedFromPreview.previewQuoteId }),
    totalMinor: dueNow.totalMinor,
    renewalTotalMinor: renewal.totalMinor,
    expiresAt: verified.snapshot.expiresAt,
    ...(auditContext ? { correlationId: auditContext.correlationId } : {}),
  })

  const persisted = await tx.commercialQuote.create({
    data: {
      id: verified.snapshot.quoteId,
      catalogPublicationId: verified.snapshot.catalogPublicationId,
      campaignVersionId: null,
      offerVersionId: verified.snapshot.offerVersionId,
      offerSchemaVersion: 3,
      acquisitionContextId,
      organizationId: verifiedSubject.organizationId,
      venueId: verifiedSubject.venueId,
      createdById: verifiedSubject.actorId,
      schemaVersion: 3,
      market: verified.snapshot.market,
      currency: verified.snapshot.currency,
      snapshot: verified.snapshot as unknown as Prisma.InputJsonValue,
      checksum: verified.checksum,
      listSubtotalMinor: exactMinor(dueNow.listSubtotalMinor),
      discountMinor: exactMinor(dueNow.discountMinor),
      subtotalMinor: exactMinor(dueNow.subtotalMinor),
      taxMinor: exactMinor(dueNow.taxMinor),
      totalMinor: exactMinor(dueNow.totalMinor),
      renewalSubtotalMinor: exactMinor(renewal.subtotalMinor),
      renewalTaxMinor: exactMinor(renewal.taxMinor),
      renewalTotalMinor: exactMinor(renewal.totalMinor),
      quotedAt,
      expiresAt,
    },
  })

  await tx.activityLog.create({
    data: {
      organizationId: verifiedSubject.organizationId,
      venueId: verifiedSubject.venueId,
      actorType: 'HUMAN',
      staffId: verifiedSubject.actorId,
      actorStaffId: verifiedSubject.actorId,
      action: 'COMMERCIAL_QUOTE_CREATED',
      entity: 'CommercialQuote',
      entityId: verified.snapshot.quoteId,
      data: auditData,
    },
  })

  return { id: persisted.id, snapshot: verified.snapshot, checksum: verified.checksum }
}

export async function persistCommercialQuoteV3(
  emitted: EmittedCommercialQuoteV3,
  tx: CommercialQuoteV3PersistenceTransaction,
  auditContext?: CommercialQuoteV3PersistenceAuditContext,
): Promise<PersistedCommercialQuoteV3> {
  const snapshot = emitted?.snapshot
  if (snapshot?.subject?.kind !== 'VENUE') {
    throw new AppError('COMMERCIAL_QUOTE_V3_SCOPE_MISMATCH', 422, true, 'COMMERCIAL_QUOTE_V3_SCOPE_MISMATCH')
  }
  if (snapshot.acquisitionContextId !== null || snapshot.derivedFromPreview !== null) {
    throw new AppError('COMMERCIAL_QUOTE_V3_LINEAGE_MISMATCH', 422, true, 'COMMERCIAL_QUOTE_V3_LINEAGE_MISMATCH')
  }
  return persistVerifiedVenueQuoteV3(emitted, tx, null, auditContext)
}

export async function persistBridgedCommercialQuoteV3(
  emitted: EmittedCommercialQuoteV3,
  tx: CommercialQuoteV3PersistenceTransaction,
  bridge: CommercialQuoteV3BridgePersistenceContext,
  auditContext?: CommercialQuoteV3PersistenceAuditContext,
): Promise<PersistedCommercialQuoteV3> {
  const snapshot = emitted?.snapshot
  const subject = snapshot?.subject
  const derived = snapshot?.derivedFromPreview
  if (subject?.kind !== 'VENUE') {
    throw new AppError('COMMERCIAL_QUOTE_V3_SCOPE_MISMATCH', 422, true, 'COMMERCIAL_QUOTE_V3_SCOPE_MISMATCH')
  }
  if (
    snapshot.acquisitionContextId !== bridge.acquisitionContext.id ||
    derived === null ||
    subject.actorId !== bridge.actorId ||
    derived.previewQuoteId !== bridge.preview.quoteId ||
    derived.previewChecksum !== bridge.preview.checksum ||
    derived.selectionFingerprint !== bridge.preview.selectionFingerprint
  ) {
    throw new AppError('COMMERCIAL_QUOTE_V3_LINEAGE_MISMATCH', 422, true, 'COMMERCIAL_QUOTE_V3_LINEAGE_MISMATCH')
  }

  const guardedTx: CommercialQuoteV3PersistenceTransaction = {
    ...tx,
    async loadAuthorities(input) {
      const authorities = await tx.loadAuthorities(input)
      if (authorities === null || authorities.acquisitionContext === null) return null
      const acquisition = authorities.acquisitionContext
      const acquisitionCreatedAt =
        typeof acquisition.createdAt === 'string'
          ? Date.parse(acquisition.createdAt)
          : Date.prototype.getTime.call(acquisition.createdAt)
      if (acquisition.id !== bridge.acquisitionContext.id || acquisitionCreatedAt !== bridge.acquisitionContext.createdAt.getTime()) return null
      return authorities
    },
  }
  return persistVerifiedVenueQuoteV3(emitted, guardedTx, bridge.acquisitionContext.id, auditContext)
}
