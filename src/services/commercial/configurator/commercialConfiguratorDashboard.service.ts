import { Prisma } from '@prisma/client'

import AppError from '@/errors/AppError'
import { decodeAndVerifyStoredCommercialCatalogV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import {
  previewCommercialConfigurator,
  type CommercialConfiguratorPreview,
  type CommercialConfiguratorSelection,
} from '@/services/commercial/configurator/commercialConfiguratorPreview.service'
import { decodeAndVerifyStoredCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  assertCommercialOfferAllowsPreviewV3,
  resolveCommercialOfferControlStateV3,
  type CommercialOfferControlLatestEventV3,
} from '@/services/commercial/quotes-v3/commercialOfferControlV3.service'
import type { CommercialQuoteV3CatalogAuthority, CommercialQuoteV3OfferAuthority } from '@/types/commercialQuoteV3'
import prisma from '@/utils/prismaClient'

interface CatalogRow {
  id: string
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

interface OfferRow {
  id: string
  campaignCode: string
  sourceRevision: number
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

interface BoundOffer {
  offerVersionId: string
  offerCode: string
  contractStatus: 'DRAFT' | 'PENDING_PAYMENT' | 'ACTIVE' | 'PAUSED' | 'CANCELED' | 'COMPLETED'
}

const CONTRACT_STATUSES_WITH_BOUND_PRICING = new Set<BoundOffer['contractStatus']>([
  'PENDING_PAYMENT',
  'ACTIVE',
  'PAUSED',
])

export interface CommercialConfiguratorDashboardTransaction {
  readDatabaseClock(): Promise<Date>
  findVenue(venueId: string): Promise<{ id: string; organizationId: string } | null>
  findActiveCatalog(): Promise<CatalogRow | null>
  findLatestContractOffer(organizationId: string, venueId: string): Promise<BoundOffer | null>
  findOffer(offerVersionId: string): Promise<OfferRow | null>
  findLatestOfferControl(offerVersionId: string): Promise<CommercialOfferControlLatestEventV3 | null>
}

export interface CommercialConfiguratorDashboardDependencies {
  runInRepeatableRead<T>(operation: (tx: CommercialConfiguratorDashboardTransaction) => Promise<T>): Promise<T>
}

export interface CommercialConfiguratorDashboardResult {
  schemaVersion: 1
  state: 'READY'
  pricing:
    | { state: 'LIST_PRICE' }
    | { state: 'BOUND_OFFER_APPLIED'; offerVersionId: string; offerCode: string }
    | {
        state: 'BOUND_OFFER_UNAVAILABLE'
        offerVersionId: string
        offerCode: string
        reason: 'OFFER_NOT_FOUND' | 'OFFER_NOT_ACTIVE' | 'CLAIM_WINDOW_NOT_STARTED' | 'CLAIM_WINDOW_ENDED' | 'OFFER_SUSPENDED'
      }
  preview: CommercialConfiguratorPreview
}

type BoundOfferUnavailableReason = Extract<
  CommercialConfiguratorDashboardResult['pricing'],
  { state: 'BOUND_OFFER_UNAVAILABLE' }
>['reason']

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function inputId(value: string, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new AppError('La solicitud del configurador no es válida.', 422, true, 'COMMERCIAL_CONFIGURATOR_INPUT_INVALID', {
      field,
    })
  }
  return value
}

function authorityInvalid(cause: 'CATALOG' | 'OFFER'): never {
  throw new AppError(
    'No fue posible verificar la autoridad comercial publicada.',
    409,
    true,
    'COMMERCIAL_CONFIGURATOR_AUTHORITY_INVALID',
    { cause },
  )
}

function verifyCatalog(row: CatalogRow): CommercialQuoteV3CatalogAuthority {
  try {
    if (row.schemaVersion !== 2) return authorityInvalid('CATALOG')
    return decodeAndVerifyStoredCommercialCatalogV2({
      kind: 'CATALOG',
      rowSchemaVersion: row.schemaVersion,
      snapshot: row.snapshot,
      checksum: row.checksum,
      rowContext: {
        kind: 'CATALOG',
        id: row.id,
        schemaVersion: row.schemaVersion,
        publishedAt: row.publishedAt,
      },
    })
  } catch (error) {
    if (error instanceof AppError) throw error
    return authorityInvalid('CATALOG')
  }
}

function verifyOffer(row: OfferRow): CommercialQuoteV3OfferAuthority {
  try {
    const rowContext = {
      id: row.id,
      campaignCode: row.campaignCode,
      sourceRevision: row.sourceRevision,
      schemaVersion: row.schemaVersion,
      publishedAt: row.publishedAt,
    }
    const verified = decodeAndVerifyStoredCommercialOfferV3({
      rowSchemaVersion: row.schemaVersion,
      snapshot: row.snapshot,
      checksum: row.checksum,
      rowContext,
    })
    return {
      rowSchemaVersion: row.schemaVersion,
      rowContext,
      snapshot: verified.snapshot,
      checksum: verified.checksum,
    }
  } catch {
    return authorityInvalid('OFFER')
  }
}

function validClock(value: Date): Date {
  try {
    const time = Date.prototype.getTime.call(value)
    if (!Number.isFinite(time)) throw new Error('invalid')
    return new Date(time)
  } catch {
    throw new AppError('El reloj comercial no está disponible.', 503, true, 'COMMERCIAL_CONFIGURATOR_CLOCK_INVALID')
  }
}

function offerUnavailableReason(
  offer: CommercialQuoteV3OfferAuthority,
  latestControl: CommercialOfferControlLatestEventV3 | null,
  now: Date,
): BoundOfferUnavailableReason | null {
  const snapshot = offer.snapshot
  const nowIso = now.toISOString()
  if (snapshot.status !== 'ACTIVE') return 'OFFER_NOT_ACTIVE'
  if (nowIso < snapshot.claimStartsAt) return 'CLAIM_WINDOW_NOT_STARTED'
  if (nowIso >= snapshot.claimEndsAt) return 'CLAIM_WINDOW_ENDED'
  try {
    assertCommercialOfferAllowsPreviewV3(resolveCommercialOfferControlStateV3(latestControl))
    return null
  } catch {
    return 'OFFER_SUSPENDED'
  }
}

export function createCommercialConfiguratorDashboardService(dependencies: CommercialConfiguratorDashboardDependencies) {
  return Object.freeze({
    async preview(
      input: { organizationId: string; venueId: string; selection: CommercialConfiguratorSelection },
      testing: { now?: Date } = {},
    ): Promise<CommercialConfiguratorDashboardResult> {
      const organizationId = inputId(input.organizationId, 'organizationId')
      const venueId = inputId(input.venueId, 'venueId')
      return dependencies.runInRepeatableRead(async tx => {
        const venue = await tx.findVenue(venueId)
        if (!venue || venue.organizationId !== organizationId) {
          throw new AppError('No se encontró el local solicitado.', 404, true, 'COMMERCIAL_CONFIGURATOR_VENUE_NOT_FOUND')
        }
        const activeCatalogRow = await tx.findActiveCatalog()
        if (!activeCatalogRow) {
          throw new AppError('El catálogo comercial no está disponible.', 503, true, 'COMMERCIAL_CONFIGURATOR_CATALOG_UNAVAILABLE')
        }
        const catalogAuthority = verifyCatalog(activeCatalogRow)
        const now = validClock(testing.now ?? (await tx.readDatabaseClock()))
        const bound = await tx.findLatestContractOffer(organizationId, venueId)
        if (!bound || !CONTRACT_STATUSES_WITH_BOUND_PRICING.has(bound.contractStatus)) {
          return {
            schemaVersion: 1,
            state: 'READY',
            pricing: { state: 'LIST_PRICE' },
            preview: previewCommercialConfigurator({
              catalogAuthority,
              offerAuthority: null,
              selection: input.selection,
              resolvedAt: now,
            }),
          }
        }

        const offerRow = await tx.findOffer(bound.offerVersionId)
        if (!offerRow) {
          return {
            schemaVersion: 1,
            state: 'READY',
            pricing: {
              state: 'BOUND_OFFER_UNAVAILABLE',
              offerVersionId: bound.offerVersionId,
              offerCode: bound.offerCode,
              reason: 'OFFER_NOT_FOUND',
            },
            preview: previewCommercialConfigurator({
              catalogAuthority,
              offerAuthority: null,
              selection: input.selection,
              resolvedAt: now,
            }),
          }
        }
        const offerAuthority = verifyOffer(offerRow)
        if (
          offerAuthority.snapshot.campaignVersionId !== bound.offerVersionId ||
          offerAuthority.snapshot.campaignCode !== bound.offerCode
        ) {
          return authorityInvalid('OFFER')
        }
        const latestControl = await tx.findLatestOfferControl(bound.offerVersionId)
        const reason = offerUnavailableReason(offerAuthority, latestControl, now)
        if (reason) {
          return {
            schemaVersion: 1,
            state: 'READY',
            pricing: {
              state: 'BOUND_OFFER_UNAVAILABLE',
              offerVersionId: bound.offerVersionId,
              offerCode: bound.offerCode,
              reason,
            },
            preview: previewCommercialConfigurator({
              catalogAuthority,
              offerAuthority: null,
              selection: input.selection,
              resolvedAt: now,
            }),
          }
        }
        return {
          schemaVersion: 1,
          state: 'READY',
          pricing: {
            state: 'BOUND_OFFER_APPLIED',
            offerVersionId: bound.offerVersionId,
            offerCode: bound.offerCode,
          },
          preview: previewCommercialConfigurator({
            catalogAuthority,
            offerAuthority,
            selection: input.selection,
            resolvedAt: now,
          }),
        }
      })
    },
  })
}

export const commercialConfiguratorDashboardService = createCommercialConfiguratorDashboardService({
  runInRepeatableRead: operation =>
    prisma.$transaction(
      async tx =>
        operation({
          async readDatabaseClock() {
            const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT transaction_timestamp() AS now`)
            return rows[0]?.now ?? new Date(Number.NaN)
          },
          findVenue: venueId =>
            tx.venue.findUnique({ where: { id: venueId }, select: { id: true, organizationId: true } }),
          async findActiveCatalog() {
            const activation = await tx.commercialPublicationActivation.findUnique({
              where: { environment: 'PRODUCTION' },
              select: {
                publication: {
                  select: { id: true, schemaVersion: true, snapshot: true, checksum: true, publishedAt: true },
                },
              },
            })
            return activation?.publication ?? null
          },
          async findLatestContractOffer(organizationId, venueId) {
            const contract = await tx.commercialSubscriptionContract.findFirst({
              where: {
                organizationId,
                venueId,
                status: { in: ['PENDING_PAYMENT', 'ACTIVE', 'PAUSED'] },
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: {
                status: true,
                quoteAcceptance: {
                  select: {
                    quote: {
                      select: {
                        offerVersionId: true,
                        offerVersion: { select: { campaignCode: true } },
                      },
                    },
                  },
                },
              },
            })
            const quote = contract?.quoteAcceptance.quote
            return contract && quote?.offerVersionId && quote.offerVersion
              ? {
                  offerVersionId: quote.offerVersionId,
                  offerCode: quote.offerVersion.campaignCode,
                  contractStatus: contract.status,
                }
              : null
          },
          findOffer: offerVersionId =>
            tx.commercialCampaignVersion.findUnique({
              where: { id_schemaVersion: { id: offerVersionId, schemaVersion: 3 } },
              select: {
                id: true,
                campaignCode: true,
                sourceRevision: true,
                schemaVersion: true,
                snapshot: true,
                checksum: true,
                publishedAt: true,
              },
            }),
          findLatestOfferControl: offerVersionId =>
            tx.commercialOfferControlEvent.findFirst({
              where: { offerVersionId },
              orderBy: [{ revision: 'desc' }],
              select: { revision: true, action: true },
            }),
        }),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,
        timeout: 15_000,
      },
    ),
})
