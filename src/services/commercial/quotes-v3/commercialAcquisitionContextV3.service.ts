import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'

import { Prisma, PrismaClient, type CommercialAcquisitionChannel } from '@prisma/client'
import { z } from 'zod'

import AppError, { ConflictError } from '@/errors/AppError'
import { decodeAndVerifyStoredCommercialCatalogV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { decodeAndVerifyStoredCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  assertCommercialOfferAllowsNewAcquisitionContextV3,
  assertCommercialOfferAllowsPreviewV3,
  resolveCommercialOfferControlStateV3,
  type CommercialOfferControlLatestEventV3,
} from '@/services/commercial/quotes-v3/commercialOfferControlV3.service'
import { hashCommercialAcquisitionContextTokenV3 } from '@/services/commercial/quotes-v3/commercialAcquisitionContextTokenV3.service'
import type {
  CommercialOfferClaimV3OfferRow,
  CommercialOfferClaimV3Record,
} from '@/services/commercial/quotes-v3/commercialOfferClaimV3.service'

const OFFER_CLAIM_HASH_DOMAIN_V3 = Buffer.from('avoqado.commercial.offer-claim@3\0', 'ascii')
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const TTL_MS = 7 * 24 * 60 * 60 * 1_000
const RETRYABLE_POSTGRES_CODES = new Set(['40001', '40P01'])
const boundedReference = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9._:@/+\-=]+$/u)
const issueSchema = z
  .object({
    offerClaim: z.string().regex(TOKEN_PATTERN),
    channel: z.enum(['PAID_META', 'PAID_GOOGLE', 'SELLER', 'DISTRIBUTOR', 'ORGANIC', 'PARTNER', 'DIRECT']).optional(),
    utmSource: boundedReference.optional(),
    utmMedium: boundedReference.optional(),
    utmCampaign: boundedReference.optional(),
    utmContent: boundedReference.optional(),
    utmTerm: boundedReference.optional(),
    gclid: boundedReference.optional(),
    fbclid: boundedReference.optional(),
  })
  .strict()

export type IssueCommercialAcquisitionContextV3Input = z.infer<typeof issueSchema>

export interface CommercialAcquisitionContextV3CatalogRow {
  id: string
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

export interface CommercialAcquisitionContextV3Record {
  id: string
  tokenHash: string
  campaignVersionId: null
  offerVersionId: string
  offerSchemaVersion: 3
  reservedCatalogPublicationId: string
  reservedCatalogSchemaVersion: 2
  channel: CommercialAcquisitionChannel
  attribution: Record<string, string>
  createdAt: Date
  expiresAt: Date
}

export interface StoredCommercialAcquisitionContextV3Record extends CommercialAcquisitionContextV3Record {
  offerVersion: CommercialOfferClaimV3OfferRow | null
  reservedCatalogPublication: CommercialAcquisitionContextV3CatalogRow | null
}

export interface ResolvedCommercialAcquisitionContextV3 {
  acquisitionContextId: string
  offerVersionId: string
  offerChecksum: string
  reservedCatalogPublicationId: string
  reservedCatalogChecksum: string
  channel: CommercialAcquisitionChannel
  attribution: Readonly<Record<string, string>>
  createdAt: Date
  expiresAt: Date
}

export interface CommercialAcquisitionContextV3Transaction {
  setLocalLockTimeout(milliseconds: 1_000): Promise<unknown>
  findClaimByTokenHash(tokenHash: string): Promise<CommercialOfferClaimV3Record | null>
  lockOffer(offerVersionId: string): Promise<CommercialOfferClaimV3OfferRow | null>
  readLatestOfferControl(offerVersionId: string): Promise<CommercialOfferControlLatestEventV3 | null>
  lockActiveCatalog(): Promise<CommercialAcquisitionContextV3CatalogRow | null>
  readDatabaseClock(): Promise<Date>
  createContext(record: CommercialAcquisitionContextV3Record): Promise<void>
  findContextByTokenHash(tokenHash: string): Promise<StoredCommercialAcquisitionContextV3Record | null>
  lockReservedCatalog(publicationId: string): Promise<CommercialAcquisitionContextV3CatalogRow | null>
}

export interface CommercialAcquisitionContextV3Dependencies {
  runInTransaction<T>(
    operation: (tx: CommercialAcquisitionContextV3Transaction) => Promise<T>,
    options: {
      maxWait: number
      timeout: number
      isolationLevel: Prisma.TransactionIsolationLevel
    },
  ): Promise<T>
  randomBytes(length: 32): Buffer
  randomId(): string
  sleep(milliseconds: number): Promise<void>
  retryDelayMilliseconds(): number
}

export const COMMERCIAL_ACQUISITION_CONTEXT_V3_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 5_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
})

function contextError(message: string, statusCode: number, code: string): never {
  throw new AppError(message, statusCode, true, code)
}

function exactTokenBytes(token: string): Buffer | null {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null
  const bytes = Buffer.from(token, 'base64url')
  return bytes.length === 32 && bytes.toString('base64url') === token ? bytes : null
}

function offerClaimHash(bytes: Buffer): string {
  return createHash('sha256').update(Buffer.concat([OFFER_CLAIM_HASH_DOMAIN_V3, bytes])).digest('hex')
}

function exactDate(value: Date, code = 'COMMERCIAL_ACQUISITION_TOKEN_INVALID'): Date {
  try {
    const time = Date.prototype.getTime.call(value)
    if (!Number.isFinite(time)) return contextError('El reloj comercial no es válido.', 503, code)
    return new Date(time)
  } catch {
    return contextError('El reloj comercial no es válido.', 503, code)
  }
}

function verifyOffer(row: CommercialOfferClaimV3OfferRow) {
  try {
    const verified = decodeAndVerifyStoredCommercialOfferV3({
      rowSchemaVersion: row.schemaVersion,
      snapshot: row.snapshot,
      checksum: row.checksum,
      rowContext: {
        id: row.id,
        campaignCode: row.campaignCode,
        sourceRevision: row.sourceRevision,
        schemaVersion: row.schemaVersion,
        publishedAt: row.publishedAt,
      },
    })
    if (verified.snapshot.status !== 'ACTIVE') {
      return contextError('La oferta no está activa.', 409, 'COMMERCIAL_ACQUISITION_V3_OFFER_INVALID')
    }
    return verified
  } catch (error) {
    if (error instanceof AppError) throw error
    return contextError('La oferta reservada no es válida.', 409, 'COMMERCIAL_ACQUISITION_V3_OFFER_INVALID')
  }
}

function verifyCatalog(row: CommercialAcquisitionContextV3CatalogRow) {
  if (row.schemaVersion !== 2) {
    contextError('El catálogo reservado no es v2.', 409, 'COMMERCIAL_ACQUISITION_V3_CATALOG_INVALID')
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
    return contextError('El catálogo reservado no es válido.', 409, 'COMMERCIAL_ACQUISITION_V3_CATALOG_INVALID')
  }
}

function assertDedicatedClaim(record: CommercialOfferClaimV3Record | null): CommercialOfferClaimV3Record {
  if (
    record === null ||
    record.campaignVersionId !== null ||
    record.campaignCode !== null ||
    record.offerSchemaVersion !== 3 ||
    typeof record.offerVersionId !== 'string' ||
    record.offerVersionId.length < 1
  ) {
    contextError('El enlace de oferta no existe.', 404, 'COMMERCIAL_OFFER_CLAIM_NOT_FOUND')
  }
  return record
}

function postgresCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const candidate = error as { code?: unknown; meta?: unknown; cause?: unknown }
  const meta = typeof candidate.meta === 'object' && candidate.meta !== null ? (candidate.meta as Record<string, unknown>) : null
  const cause = typeof candidate.cause === 'object' && candidate.cause !== null ? (candidate.cause as Record<string, unknown>) : null
  for (const code of [candidate.code, meta?.code, meta?.sqlState, cause?.code]) {
    if (typeof code === 'string' && RETRYABLE_POSTGRES_CODES.has(code)) return code
  }
  return null
}

function unavailable(): ConflictError {
  return new ConflictError('La reservación comercial está ocupada. Vuelve a intentar.', 'COMMERCIAL_ACQUISITION_V3_UNAVAILABLE', {
    retryable: true,
    attempts: 2,
  })
}

function safeAttribution(input: IssueCommercialAcquisitionContextV3Input, offerCode: string, sourceRef: string) {
  const attribution: Record<string, string> = { offerCode, sourceRef }
  for (const key of ['utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm', 'gclid', 'fbclid'] as const) {
    const value = input[key]
    if (value !== undefined) attribution[key] = value
  }
  return attribution
}

export function createCommercialAcquisitionContextV3Service(dependencies: CommercialAcquisitionContextV3Dependencies) {
  async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        if (postgresCode(error) === null) throw error
        if (attempt === 2) throw unavailable()
        await dependencies.sleep(dependencies.retryDelayMilliseconds())
      }
    }
    throw unavailable()
  }

  return Object.freeze({
    async issue(input: IssueCommercialAcquisitionContextV3Input) {
      const parsed = issueSchema.safeParse(input)
      if (!parsed.success) {
        contextError('La reservación comercial contiene campos inválidos.', 422, 'COMMERCIAL_ACQUISITION_V3_INVALID')
      }
      const claimBytes = exactTokenBytes(parsed.data.offerClaim)
      if (claimBytes === null) {
        contextError('El enlace de oferta no es válido.', 422, 'COMMERCIAL_ACQUISITION_V3_INVALID')
      }
      const rawContextBytes = dependencies.randomBytes(32)
      if (!Buffer.isBuffer(rawContextBytes) || rawContextBytes.length !== 32) {
        contextError('No se pudo emitir una reservación segura.', 500, 'COMMERCIAL_ACQUISITION_ENTROPY_INVALID')
      }
      const token = rawContextBytes.toString('base64url')
      if (exactTokenBytes(token) === null) {
        contextError('No se pudo emitir una reservación segura.', 500, 'COMMERCIAL_ACQUISITION_ENTROPY_INVALID')
      }

      return withRetry(() =>
        dependencies.runInTransaction(async tx => {
          await tx.setLocalLockTimeout(1_000)
          const claim = assertDedicatedClaim(await tx.findClaimByTokenHash(offerClaimHash(claimBytes)))
          const offerRow = await tx.lockOffer(claim.offerVersionId)
          if (offerRow === null) {
            contextError('La oferta reservada no está disponible.', 409, 'COMMERCIAL_ACQUISITION_V3_OFFER_INVALID')
          }
          const verifiedOffer = verifyOffer(offerRow)
          const control = await tx.readLatestOfferControl(claim.offerVersionId)
          assertCommercialOfferAllowsNewAcquisitionContextV3(resolveCommercialOfferControlStateV3(control))
          const catalogRow = await tx.lockActiveCatalog()
          if (catalogRow === null) {
            contextError('No hay un catálogo activo.', 409, 'COMMERCIAL_ACQUISITION_V3_CATALOG_INVALID')
          }
          const verifiedCatalog = verifyCatalog(catalogRow)
          const createdAt = exactDate(await tx.readDatabaseClock(), 'COMMERCIAL_ACQUISITION_V3_CLOCK_INVALID')
          if (createdAt >= claim.expiresAt) {
            contextError('El enlace de oferta expiró.', 410, 'COMMERCIAL_OFFER_CLAIM_EXPIRED')
          }
          const claimStartsAt = Date.parse(verifiedOffer.snapshot.claimStartsAt)
          const claimEndsAt = Date.parse(verifiedOffer.snapshot.claimEndsAt)
          if (claim.createdAt.getTime() < claimStartsAt || claim.createdAt.getTime() >= claimEndsAt || createdAt.getTime() >= claimEndsAt) {
            contextError('La ventana de la oferta está cerrada.', 409, 'COMMERCIAL_OFFER_CLAIM_WINDOW_CLOSED')
          }
          const expiresAt = new Date(createdAt.getTime() + TTL_MS)
          const record: CommercialAcquisitionContextV3Record = {
            id: dependencies.randomId(),
            tokenHash: hashCommercialAcquisitionContextTokenV3(token),
            campaignVersionId: null,
            offerVersionId: verifiedOffer.snapshot.campaignVersionId,
            offerSchemaVersion: 3,
            reservedCatalogPublicationId: verifiedCatalog.snapshot.publicationId,
            reservedCatalogSchemaVersion: 2,
            channel: claim.channel,
            attribution: safeAttribution(parsed.data, verifiedOffer.snapshot.campaignCode, claim.sourceRef),
            createdAt,
            expiresAt,
          }
          await tx.createContext(record)
          return {
            token,
            acquisitionContextId: record.id,
            createdAt: createdAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          }
        }, COMMERCIAL_ACQUISITION_CONTEXT_V3_TRANSACTION_OPTIONS),
      )
    },

    async resolve(token: string, nowInput: Date): Promise<ResolvedCommercialAcquisitionContextV3> {
      if (exactTokenBytes(token) === null) {
        contextError('El contexto de adquisición no es válido.', 422, 'COMMERCIAL_ACQUISITION_TOKEN_INVALID')
      }
      const now = exactDate(nowInput)
      return withRetry(() =>
        dependencies.runInTransaction(async tx => {
          await tx.setLocalLockTimeout(1_000)
          const record = await tx.findContextByTokenHash(hashCommercialAcquisitionContextTokenV3(token))
          if (
            record === null ||
            record.campaignVersionId !== null ||
            record.offerSchemaVersion !== 3 ||
            record.reservedCatalogSchemaVersion !== 2 ||
            record.offerVersion === null ||
            record.reservedCatalogPublication === null
          ) {
            contextError('El contexto de adquisición no existe.', 404, 'COMMERCIAL_ACQUISITION_NOT_FOUND')
          }
          if (now >= record.expiresAt) {
            contextError('El contexto de adquisición venció.', 410, 'COMMERCIAL_ACQUISITION_EXPIRED')
          }
          const offerRow = await tx.lockOffer(record.offerVersionId)
          if (offerRow === null || offerRow.checksum !== record.offerVersion.checksum) {
            contextError('La oferta reservada no está disponible.', 409, 'COMMERCIAL_ACQUISITION_V3_OFFER_INVALID')
          }
          const verifiedOffer = verifyOffer(offerRow)
          const control = await tx.readLatestOfferControl(record.offerVersionId)
          assertCommercialOfferAllowsPreviewV3(resolveCommercialOfferControlStateV3(control))
          const catalogRow = await tx.lockReservedCatalog(record.reservedCatalogPublicationId)
          if (catalogRow === null || catalogRow.checksum !== record.reservedCatalogPublication.checksum) {
            contextError('El catálogo reservado no está disponible.', 409, 'COMMERCIAL_ACQUISITION_V3_CATALOG_INVALID')
          }
          const verifiedCatalog = verifyCatalog(catalogRow)
          return {
            acquisitionContextId: record.id,
            offerVersionId: record.offerVersionId,
            offerChecksum: verifiedOffer.checksum,
            reservedCatalogPublicationId: record.reservedCatalogPublicationId,
            reservedCatalogChecksum: verifiedCatalog.checksum,
            channel: record.channel,
            attribution: Object.freeze({ ...record.attribution }),
            createdAt: new Date(record.createdAt.getTime()),
            expiresAt: new Date(record.expiresAt.getTime()),
          }
        }, COMMERCIAL_ACQUISITION_CONTEXT_V3_TRANSACTION_OPTIONS),
      )
    },
  })
}

export function createPrismaCommercialAcquisitionContextV3Transaction(
  tx: Prisma.TransactionClient,
): CommercialAcquisitionContextV3Transaction {
  const lockPublication = async (publicationId: string) => {
    const rows = await tx.$queryRaw<CommercialAcquisitionContextV3CatalogRow[]>(Prisma.sql`
      SELECT "id", "schemaVersion", "snapshot", "checksum", "publishedAt"
      FROM "CommercialPublication"
      WHERE "id" = ${publicationId} AND "schemaVersion" = 2
      FOR SHARE
    `)
    return rows[0] ?? null
  }
  return {
    setLocalLockTimeout: milliseconds => tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${milliseconds}ms'`),
    findClaimByTokenHash: tokenHashValue =>
      tx.commercialCampaignClaim.findUnique({ where: { tokenHash: tokenHashValue } }) as Promise<CommercialOfferClaimV3Record | null>,
    async lockOffer(offerVersionId) {
      const rows = await tx.$queryRaw<CommercialOfferClaimV3OfferRow[]>(Prisma.sql`
        SELECT "id", "campaignCode", "sourceRevision", "schemaVersion", "snapshot", "checksum", "publishedAt"
        FROM "CommercialCampaignVersion"
        WHERE "id" = ${offerVersionId} AND "schemaVersion" = 3
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    readLatestOfferControl: offerVersionId =>
      tx.commercialOfferControlEvent.findFirst({
        where: { offerVersionId },
        orderBy: { revision: 'desc' },
        select: { revision: true, action: true },
      }),
    async lockActiveCatalog() {
      const rows = await tx.$queryRaw<CommercialAcquisitionContextV3CatalogRow[]>(Prisma.sql`
        SELECT publication."id", publication."schemaVersion", publication."snapshot", publication."checksum", publication."publishedAt"
        FROM "CommercialPublicationActivation" AS activation
        JOIN "CommercialPublication" AS publication ON publication."id" = activation."publicationId"
        WHERE activation."environment" = 'PRODUCTION'::"CommercialPublicationEnvironment"
          AND publication."schemaVersion" = 2
        FOR SHARE OF publication
      `)
      return rows[0] ?? null
    },
    async readDatabaseClock() {
      const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
        SELECT date_trunc('milliseconds', pg_catalog.clock_timestamp()) AS "now"
      `)
      if (!rows[0]) contextError('El reloj comercial no está disponible.', 503, 'COMMERCIAL_ACQUISITION_V3_CLOCK_INVALID')
      return rows[0].now
    },
    async createContext(record) {
      await tx.commercialAcquisitionContext.create({
        data: { ...record, attribution: record.attribution as Prisma.InputJsonObject },
      })
    },
    findContextByTokenHash: tokenHashValue =>
      tx.commercialAcquisitionContext.findUnique({
        where: { tokenHash: tokenHashValue },
        include: { offerVersion: true, reservedCatalogPublication: true },
      }) as Promise<StoredCommercialAcquisitionContextV3Record | null>,
    lockReservedCatalog: lockPublication,
  }
}

export function createPrismaCommercialAcquisitionContextV3Service(host: PrismaClient) {
  return createCommercialAcquisitionContextV3Service({
    runInTransaction: (operation, options) =>
      host.$transaction(tx => operation(createPrismaCommercialAcquisitionContextV3Transaction(tx)), options),
    randomBytes,
    randomId: randomUUID,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    retryDelayMilliseconds: () => randomInt(25, 76),
  })
}
