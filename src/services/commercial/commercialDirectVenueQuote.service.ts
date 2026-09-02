import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import type { PersistedCommercialQuoteV2, CommercialQuotePersistenceTransaction } from './commercialQuotePersistence.service'
import { persistCommercialQuoteV2 } from './commercialQuotePersistence.service'
import type { VerifiedStoredCommercialCatalogV2 } from './commercialArtifactCodecRegistry.service'
import { evaluateCommercialQuoteV2, type CommercialQuoteSelectionV2 } from './commercialQuoteEngineV2.service'
import { buildCommercialQuoteV2 } from './commercialQuoteV2Builder.service'
import { withVerifiedActiveCatalogV2 } from './commercialQuoteV2Authority.service'

interface LockedDirectVenueAuthority {
  now: Date
  publicationId: string | null
  catalogChecksum: string | null
  venueOrganizationId: string | null
}

interface DirectCatalogContext {
  catalog: VerifiedStoredCommercialCatalogV2
}

export interface CommercialDirectVenueQuoteInput {
  organizationId: string
  venueId: string
  actorId: string
  lines: CommercialQuoteSelectionV2[]
}

export interface CommercialDirectVenueQuoteDependencies {
  randomId(): string
  withVerifiedActiveCatalogV2<T>(operation: (context: DirectCatalogContext) => Promise<T>): Promise<T>
  runInReadCommitted<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>
  loadLockedAuthority(
    tx: Prisma.TransactionClient,
    input: { organizationId: string; venueId: string; expectedPublicationId: string },
  ): Promise<LockedDirectVenueAuthority>
  persistQuote(result: Parameters<typeof persistCommercialQuoteV2>[0], tx: Prisma.TransactionClient): Promise<PersistedCommercialQuoteV2>
}

function scopeMismatch(): never {
  throw new AppError('La sucursal no pertenece a la organización autenticada.', 403, true, 'COMMERCIAL_QUOTE_SCOPE_MISMATCH')
}

function superseded(): never {
  throw new AppError('La autoridad comercial cambió durante la cotización. Intenta nuevamente.', 409, true, 'COMMERCIAL_PREVIEW_SUPERSEDED')
}

const prismaCommercialDirectVenueQuoteDependencies: CommercialDirectVenueQuoteDependencies = {
  randomId: randomUUID,
  withVerifiedActiveCatalogV2,
  runInReadCommitted: operation =>
    prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 30_000,
    }),
  async loadLockedAuthority(tx, input) {
    const pointer = await tx.$queryRaw<Array<{ publicationId: string; catalogChecksum: string }>>`
      SELECT activation."publicationId", publication."checksum" AS "catalogChecksum"
      FROM "CommercialPublicationActivation" AS activation
      INNER JOIN "CommercialPublication" AS publication
        ON publication."id" = activation."publicationId"
      WHERE activation."environment" = 'PRODUCTION'
      FOR SHARE OF activation, publication
    `
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`
    const venue = await tx.$queryRaw<Array<{ organizationId: string }>>(Prisma.sql`
      SELECT "organizationId"
      FROM "Venue"
      WHERE "id" = ${input.venueId}
      FOR SHARE
    `)
    return {
      now: clock[0]?.now ?? new Date(Number.NaN),
      publicationId: pointer[0]?.publicationId ?? null,
      catalogChecksum: pointer[0]?.catalogChecksum ?? null,
      venueOrganizationId: venue[0]?.organizationId ?? null,
    }
  },
  persistQuote: (result, tx) => persistCommercialQuoteV2(result, tx as unknown as CommercialQuotePersistenceTransaction),
}

export function createCommercialDirectVenueQuoteService(
  dependencies: CommercialDirectVenueQuoteDependencies = prismaCommercialDirectVenueQuoteDependencies,
) {
  return {
    create(input: CommercialDirectVenueQuoteInput): Promise<PersistedCommercialQuoteV2> {
      return dependencies.withVerifiedActiveCatalogV2(async ({ catalog }) =>
        dependencies.runInReadCommitted(async tx => {
          const locked = await dependencies.loadLockedAuthority(tx, {
            organizationId: input.organizationId,
            venueId: input.venueId,
            expectedPublicationId: catalog.snapshot.publicationId,
          })
          if (locked.publicationId !== catalog.snapshot.publicationId || locked.catalogChecksum !== catalog.checksum) superseded()
          if (locked.venueOrganizationId !== input.organizationId) scopeMismatch()

          const quotedAt = locked.now
          const expiresAt = new Date(Date.prototype.getTime.call(quotedAt) + 15 * 60 * 1000)
          const evaluation = evaluateCommercialQuoteV2({
            catalog: catalog.snapshot,
            campaign: null,
            lines: input.lines,
            now: quotedAt,
          })
          const emitted = buildCommercialQuoteV2({
            quoteId: dependencies.randomId(),
            subject: {
              kind: 'VENUE',
              organizationId: input.organizationId,
              venueId: input.venueId,
              actorId: input.actorId,
            },
            acquisitionContextId: null,
            derivedFromPreview: null,
            quotedAt,
            expiresAt,
            evaluation,
            authorities: { catalog, campaign: null },
          })
          return dependencies.persistQuote(emitted, tx)
        }),
      )
    },
  }
}

export const commercialDirectVenueQuoteService = createCommercialDirectVenueQuoteService()
