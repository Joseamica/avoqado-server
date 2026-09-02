import { randomInt, randomUUID } from 'node:crypto'

import { Prisma, PrismaClient, StaffRole } from '@prisma/client'

import AppError, { ConflictError } from '@/errors/AppError'
import { decodeAndVerifyStoredCommercialCatalogV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import {
  assertCommercialOfferAllowsDirectQuoteV3,
  resolveCommercialOfferControlStateV3,
  type CommercialOfferControlLatestEventV3,
} from '@/services/commercial/quotes-v3/commercialOfferControlV3.service'
import { buildCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Builder.service'
import {
  evaluateCommercialQuoteV3,
  materializeCommercialQuoteV3Selections,
  type CommercialHardwareSelectionV3,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Engine.service'
import {
  assertLockedCommercialQuoteV3ActorAuthority,
  type LockedCommercialQuoteV3ActorAuthority,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Authority.service'
import {
  persistCommercialQuoteV3,
  type CommercialQuoteV3PersistenceTransaction,
  type PersistedCommercialQuoteV3,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Persistence.service'
import { decodeAndVerifyStoredCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import type { CommercialQuoteSelectionV2 } from '@/services/commercial/commercialQuoteEngineV2.service'
import type { CommercialRateBlockerV3 } from '@/types/commercialOfferV3'
import type { CommercialQuoteV3CatalogAuthority, CommercialQuoteV3OfferAuthority } from '@/types/commercialQuoteV3'

const REQUIRED_PERMISSION = 'billing:subscriptions:manage'
const QUOTE_WINDOW_MS = 15 * 60 * 1_000

export interface CommercialDirectQuoteV3Input {
  organizationId: string
  venueId: string
  actorId: string
  offerVersionId: string
  saasSelections: readonly CommercialQuoteSelectionV2[]
  hardwareSelections: readonly CommercialHardwareSelectionV3[]
  rateBlockers: readonly CommercialRateBlockerV3[]
  correlationId: string
}

export interface LockedCommercialOfferV3Row {
  id: string
  campaignCode: string
  sourceRevision: number
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

export interface LockedCommercialCatalogV2Row {
  id: string
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

export interface CommercialDirectQuoteV3Transaction
  extends Pick<CommercialQuoteV3PersistenceTransaction, 'commercialQuote' | 'activityLog'> {
  setLocalLockTimeout(milliseconds: 1_000): Promise<void>
  lockOffer(offerVersionId: string): Promise<LockedCommercialOfferV3Row | null>
  readLatestOfferControl(offerVersionId: string): Promise<CommercialOfferControlLatestEventV3 | null>
  lockActiveCatalog(): Promise<LockedCommercialCatalogV2Row | null>
  lockOrganization(organizationId: string): Promise<{ id: string } | null>
  lockVenue(venueId: string): Promise<{ id: string; organizationId: string } | null>
  lockStaff(staffId: string): Promise<{ id: string; active: boolean } | null>
  lockMembership(
    staffId: string,
    venueId: string,
  ): Promise<{
    staffId: string
    venueId: string
    active: boolean
    role: StaffRole
    permissionSetId: string | null
  } | null>
  lockPermissionSet(permissionSetId: string | null): Promise<{
    id: string
    venueId: string
    permissions: string[]
  } | null>
  lockRoleOverride(
    venueId: string,
    role: StaffRole,
  ): Promise<{
    permissions: string[]
    deniedPermissions: string[]
  } | null>
  readDatabaseClock(): Promise<Date>
}

export interface CommercialDirectQuoteV3Dependencies {
  runInTransaction<T>(
    operation: (tx: CommercialDirectQuoteV3Transaction) => Promise<T>,
    options: {
      maxWait: number
      timeout: number
      isolationLevel: Prisma.TransactionIsolationLevel
    },
  ): Promise<T>
  randomId(): string
  sleep(milliseconds: number): Promise<void>
  retryDelayMilliseconds(): number
}

export const COMMERCIAL_DIRECT_QUOTE_V3_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 5_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
})

function directError(message: string, statusCode: number, code: string): never {
  throw new AppError(message, statusCode, true, code)
}

type CommercialDirectQuoteV3DatabaseFailure = 'RETRYABLE_CONCURRENCY' | 'LOCK_TIMEOUT' | 'TRANSACTION_TIMEOUT' | null

function databaseFailure(error: unknown): CommercialDirectQuoteV3DatabaseFailure {
  if (typeof error !== 'object' || error === null) return null
  const candidate = error as { code?: unknown; meta?: unknown; cause?: unknown }
  if (candidate.code === 'P2028') return 'TRANSACTION_TIMEOUT'
  if (candidate.code === 'P2034') return 'RETRYABLE_CONCURRENCY'

  const meta = typeof candidate.meta === 'object' && candidate.meta !== null ? (candidate.meta as Record<string, unknown>) : null
  const cause = typeof candidate.cause === 'object' && candidate.cause !== null ? (candidate.cause as Record<string, unknown>) : null
  const codes = [candidate.code, meta?.code, meta?.sqlState, cause?.code]
  if (codes.includes('55P03')) return 'LOCK_TIMEOUT'
  if (codes.includes('57014')) return 'TRANSACTION_TIMEOUT'
  return codes.some(code => code === '40P01' || code === '40001') ? 'RETRYABLE_CONCURRENCY' : null
}

function unavailable(attempts: number): ConflictError {
  return new ConflictError('La autoridad comercial está ocupada. Vuelve a intentar.', 'COMMERCIAL_DIRECT_QUOTE_V3_UNAVAILABLE', {
    retryable: true,
    attempts,
  })
}

function transactionTimeout(attempts: number): AppError {
  return new AppError('La cotización tardó más de lo permitido. Vuelve a intentar.', 503, true, 'COMMERCIAL_DIRECT_QUOTE_V3_TIMEOUT', {
    retryable: true,
    attempts,
  })
}

function verifyOffer(row: LockedCommercialOfferV3Row): CommercialQuoteV3OfferAuthority {
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
    if (verified.snapshot.status !== 'ACTIVE') {
      directError('La oferta no está activa.', 409, 'COMMERCIAL_DIRECT_QUOTE_V3_OFFER_INVALID')
    }
    return {
      rowSchemaVersion: row.schemaVersion,
      rowContext,
      snapshot: verified.snapshot,
      checksum: verified.checksum,
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    return directError('La oferta no es válida.', 409, 'COMMERCIAL_DIRECT_QUOTE_V3_OFFER_INVALID')
  }
}

function verifyCatalog(row: LockedCommercialCatalogV2Row): CommercialQuoteV3CatalogAuthority {
  if (row.schemaVersion !== 2) {
    return directError('El catálogo activo cambió.', 409, 'COMMERCIAL_DIRECT_QUOTE_V3_CATALOG_INVALID')
  }
  try {
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
  } catch {
    return directError('El catálogo activo no es válido.', 409, 'COMMERCIAL_DIRECT_QUOTE_V3_CATALOG_INVALID')
  }
}

function exactDatabaseClock(value: Date): Date {
  try {
    const time = Date.prototype.getTime.call(value)
    if (!Number.isFinite(time)) return directError('El reloj comercial no es válido.', 503, 'COMMERCIAL_DIRECT_QUOTE_V3_CLOCK_INVALID')
    return new Date(time)
  } catch {
    return directError('El reloj comercial no es válido.', 503, 'COMMERCIAL_DIRECT_QUOTE_V3_CLOCK_INVALID')
  }
}

function lockedActorAuthority(
  input: CommercialDirectQuoteV3Input,
  organization: { id: string },
  venue: { id: string; organizationId: string },
  staff: { id: string; active: boolean } | null,
  membership: Awaited<ReturnType<CommercialDirectQuoteV3Transaction['lockMembership']>>,
  permissionSet: Awaited<ReturnType<CommercialDirectQuoteV3Transaction['lockPermissionSet']>>,
  roleOverride: Awaited<ReturnType<CommercialDirectQuoteV3Transaction['lockRoleOverride']>>,
): LockedCommercialQuoteV3ActorAuthority {
  const assignedPermissionSet = membership?.permissionSetId
    ? permissionSet?.id === membership.permissionSetId && permissionSet.venueId === input.venueId
      ? { permissions: permissionSet.permissions }
      : { permissions: [] }
    : null
  return {
    organizationId: organization.id,
    venueOrganizationId: venue.organizationId,
    staffActive: staff?.id === input.actorId && staff.active === true,
    membershipActive: membership?.staffId === input.actorId && membership.venueId === input.venueId && membership.active === true,
    role: membership?.role ?? StaffRole.VIEWER,
    permissionSet: assignedPermissionSet,
    roleOverride,
  }
}

export function createCommercialDirectQuoteV3Service(dependencies: CommercialDirectQuoteV3Dependencies) {
  return Object.freeze({
    async create(input: CommercialDirectQuoteV3Input): Promise<PersistedCommercialQuoteV3> {
      if (typeof input.correlationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.correlationId)) {
        directError('La correlación comercial no es válida.', 422, 'COMMERCIAL_DIRECT_QUOTE_V3_INPUT_INVALID')
      }
      const selections = materializeCommercialQuoteV3Selections(input)

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return await dependencies.runInTransaction(async tx => {
            await tx.setLocalLockTimeout(1_000)

            const offerRow = await tx.lockOffer(input.offerVersionId)
            if (offerRow === null) {
              directError('La oferta no está disponible.', 404, 'COMMERCIAL_DIRECT_QUOTE_V3_OFFER_UNAVAILABLE')
            }
            const offer = verifyOffer(offerRow)

            const latestControl = await tx.readLatestOfferControl(input.offerVersionId)
            assertCommercialOfferAllowsDirectQuoteV3(resolveCommercialOfferControlStateV3(latestControl))

            const catalogRow = await tx.lockActiveCatalog()
            if (catalogRow === null) {
              directError('No hay un catálogo activo.', 409, 'COMMERCIAL_DIRECT_QUOTE_V3_CATALOG_UNAVAILABLE')
            }
            const catalog = verifyCatalog(catalogRow)

            const organization = await tx.lockOrganization(input.organizationId)
            if (organization === null) {
              directError('La organización no está disponible.', 404, 'COMMERCIAL_DIRECT_QUOTE_V3_ORGANIZATION_UNAVAILABLE')
            }
            const venue = await tx.lockVenue(input.venueId)
            if (venue === null) {
              directError('La sucursal no está disponible.', 404, 'COMMERCIAL_DIRECT_QUOTE_V3_VENUE_UNAVAILABLE')
            }
            const staff = await tx.lockStaff(input.actorId)
            const membership = await tx.lockMembership(input.actorId, input.venueId)
            const permissionSet = await tx.lockPermissionSet(membership?.permissionSetId ?? null)
            const role = membership?.role ?? StaffRole.VIEWER
            const roleOverride = await tx.lockRoleOverride(input.venueId, role)

            assertLockedCommercialQuoteV3ActorAuthority(
              lockedActorAuthority(input, organization, venue, staff, membership, permissionSet, roleOverride),
              REQUIRED_PERMISSION,
            )

            const quotedAt = exactDatabaseClock(await tx.readDatabaseClock())
            const authorities = { catalog, offer, acquisitionContext: null }
            const evaluation = evaluateCommercialQuoteV3({
              authorities: { catalog, offer },
              ...selections,
              resolvedAt: quotedAt,
            })
            const emitted = buildCommercialQuoteV3({
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
              expiresAt: new Date(quotedAt.getTime() + QUOTE_WINDOW_MS),
              evaluation,
              authorities,
            })

            const persistenceTx: CommercialQuoteV3PersistenceTransaction = {
              // These exact authority rows were decoded after their locks were
              // acquired. Persistence re-verifies checksum and identity against
              // this local snapshot; it must not re-enter global Prisma here.
              loadAuthorities: async expected =>
                expected.catalogPublicationId === catalog.snapshot.publicationId &&
                expected.offerVersionId === offer.snapshot.campaignVersionId &&
                expected.organizationId === input.organizationId &&
                expected.venueId === input.venueId
                  ? authorities
                  : null,
              commercialQuote: tx.commercialQuote,
              activityLog: tx.activityLog,
            }
            return persistCommercialQuoteV3(emitted, persistenceTx, { correlationId: input.correlationId })
          }, COMMERCIAL_DIRECT_QUOTE_V3_TRANSACTION_OPTIONS)
        } catch (error) {
          const failure = databaseFailure(error)
          if (failure === 'TRANSACTION_TIMEOUT') throw transactionTimeout(attempt)
          if (failure === 'LOCK_TIMEOUT') throw unavailable(attempt)
          if (failure !== 'RETRYABLE_CONCURRENCY') throw error
          if (attempt < 2) {
            await dependencies.sleep(dependencies.retryDelayMilliseconds())
            continue
          }
          throw unavailable(attempt)
        }
      }
      throw unavailable(2)
    },
  })
}

export function createPrismaCommercialDirectQuoteV3Transaction(tx: Prisma.TransactionClient): CommercialDirectQuoteV3Transaction {
  return {
    async setLocalLockTimeout(milliseconds) {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${milliseconds}ms'`)
    },
    async lockOffer(offerVersionId) {
      const rows = await tx.$queryRaw<LockedCommercialOfferV3Row[]>(Prisma.sql`
        SELECT "id", "campaignCode", "sourceRevision", "schemaVersion", "snapshot", "checksum", "publishedAt"
        FROM "CommercialCampaignVersion"
        WHERE "id" = ${offerVersionId} AND "schemaVersion" = 3
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async readLatestOfferControl(offerVersionId) {
      const row = await tx.commercialOfferControlEvent.findFirst({
        where: { offerVersionId },
        orderBy: { revision: 'desc' },
        select: { revision: true, action: true },
      })
      return row as CommercialOfferControlLatestEventV3 | null
    },
    async lockActiveCatalog() {
      const rows = await tx.$queryRaw<LockedCommercialCatalogV2Row[]>(Prisma.sql`
        SELECT publication."id", publication."schemaVersion", publication."snapshot",
               publication."checksum", publication."publishedAt"
        FROM "CommercialPublicationActivation" AS activation
        INNER JOIN "CommercialPublication" AS publication
          ON publication."id" = activation."publicationId"
        WHERE activation."environment" = 'PRODUCTION'
        FOR SHARE OF activation, publication
      `)
      return rows[0] ?? null
    },
    async lockOrganization(organizationId) {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockVenue(venueId) {
      const rows = await tx.$queryRaw<Array<{ id: string; organizationId: string }>>(Prisma.sql`
        -- FOR SHARE keeps tenant ownership stable while allowing normal FK
        -- inserts (orders, payments, shifts and later role overrides) to proceed.
        SELECT "id", "organizationId" FROM "Venue" WHERE "id" = ${venueId} FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockStaff(staffId) {
      const rows = await tx.$queryRaw<Array<{ id: string; active: boolean }>>(Prisma.sql`
        SELECT "id", "active" FROM "Staff" WHERE "id" = ${staffId} FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockMembership(staffId, venueId) {
      const rows = await tx.$queryRaw<
        Array<{
          staffId: string
          venueId: string
          active: boolean
          role: StaffRole
          permissionSetId: string | null
        }>
      >(Prisma.sql`
        SELECT "staffId", "venueId", "active", "role", "permissionSetId"
        FROM "StaffVenue"
        WHERE "staffId" = ${staffId} AND "venueId" = ${venueId}
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockPermissionSet(permissionSetId) {
      if (permissionSetId === null) return null
      const rows = await tx.$queryRaw<Array<{ id: string; venueId: string; permissions: string[] }>>(Prisma.sql`
        SELECT "id", "venueId", "permissions"
        FROM "PermissionSet"
        WHERE "id" = ${permissionSetId}
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockRoleOverride(venueId, role) {
      const rows = await tx.$queryRaw<Array<{ permissions: string[]; deniedPermissions: string[] }>>(Prisma.sql`
        SELECT "permissions", "deniedPermissions"
        FROM "VenueRolePermission"
        WHERE "venueId" = ${venueId} AND "role" = CAST(${role} AS "StaffRole")
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async readDatabaseClock() {
      const rows = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT date_trunc('milliseconds', clock_timestamp()) AS "now"
      `
      return rows[0]?.now ?? new Date(Number.NaN)
    },
    commercialQuote: tx.commercialQuote,
    activityLog: tx.activityLog,
  }
}

export function createPrismaCommercialDirectQuoteV3Service(host: PrismaClient) {
  return createCommercialDirectQuoteV3Service({
    runInTransaction: (operation, options) =>
      host.$transaction(tx => operation(createPrismaCommercialDirectQuoteV3Transaction(tx)), options),
    randomId: randomUUID,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    retryDelayMilliseconds: () => randomInt(25, 76),
  })
}
