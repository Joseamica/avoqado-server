import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'

import { Prisma, PrismaClient, type CommercialAcquisitionChannel } from '@prisma/client'

import AppError, { ConflictError, ForbiddenError } from '@/errors/AppError'
import { decodeAndVerifyStoredCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  assertCommercialOfferAllowsNewAcquisitionContextV3,
  assertCommercialOfferAllowsNewClaimV3,
  resolveCommercialOfferControlStateV3,
  type CommercialOfferControlLatestEventV3,
} from '@/services/commercial/quotes-v3/commercialOfferControlV3.service'

const OFFER_CLAIM_HASH_DOMAIN_V3 = Buffer.from('avoqado.commercial.offer-claim@3\0', 'ascii')
const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const OFFER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SOURCE_REF_PATTERN = /^[A-Za-z0-9._:@/+\-=]{1,255}$/u
const CHANNELS = new Set<CommercialAcquisitionChannel>(['PAID_META', 'PAID_GOOGLE', 'SELLER', 'DISTRIBUTOR', 'PARTNER'])
const RETRYABLE_POSTGRES_CODES = new Set(['40001', '40P01'])

export interface IssueCommercialOfferClaimV3Input {
  offerVersionId: string
  channel: CommercialAcquisitionChannel
  sourceRef: string
  expiresAt: Date
  reason: string
  confirm: true
}

export interface CommercialOfferClaimPublisherV3 {
  staffId: string
  permissions: readonly string[]
  ipAddress?: string
  userAgent?: string
}

export interface ResolvedCommercialOfferClaimV3 {
  claimId: string
  offerVersionId: string
  offerCode: string
  offerChecksum: string
  channel: CommercialAcquisitionChannel
  sourceRef: string
  createdAt: Date
  expiresAt: Date
}

export interface CommercialOfferClaimV3OfferRow {
  id: string
  campaignCode: string
  sourceRevision: number
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

export interface CommercialOfferClaimV3Record {
  id: string
  tokenHash: string
  campaignVersionId: null
  campaignCode: null
  offerVersionId: string
  offerSchemaVersion: 3
  channel: CommercialAcquisitionChannel
  sourceRef: string
  issuedById: string
  reason: string
  createdAt: Date
  expiresAt: Date
}

export interface StoredCommercialOfferClaimV3Record extends CommercialOfferClaimV3Record {
  offerVersion: CommercialOfferClaimV3OfferRow | null
}

export interface CommercialOfferClaimV3Audit {
  staffId: string
  actorType: null
  organizationId: null
  venueId: null
  action: 'COMMERCIAL_OFFER_CLAIM_ISSUED'
  entity: 'CommercialCampaignClaim'
  entityId: string
  ipAddress?: string
  userAgent?: string
  data: {
    offerVersionId: string
    offerSchemaVersion: 3
    offerCode: string
    channel: CommercialAcquisitionChannel
    sourceRef: string
    expiresAt: string
    reason: string
  }
}

export interface CommercialOfferClaimV3Transaction {
  setLocalLockTimeout(milliseconds: 1_000): Promise<unknown>
  readDatabaseClock(): Promise<Date>
  lockOffer(offerVersionId: string): Promise<CommercialOfferClaimV3OfferRow | null>
  readLatestOfferControl(offerVersionId: string): Promise<CommercialOfferControlLatestEventV3 | null>
  createClaim(record: CommercialOfferClaimV3Record): Promise<void>
  writeAudit(audit: CommercialOfferClaimV3Audit): Promise<void>
  findClaimByTokenHash(tokenHash: string): Promise<StoredCommercialOfferClaimV3Record | null>
}

export interface CommercialOfferClaimV3Dependencies {
  runInTransaction<T>(
    operation: (tx: CommercialOfferClaimV3Transaction) => Promise<T>,
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

export const COMMERCIAL_OFFER_CLAIM_V3_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 5_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
})

function claimError(message: string, statusCode: number, code: string): never {
  throw new AppError(message, statusCode, true, code)
}

function exactDate(value: Date, code = 'COMMERCIAL_OFFER_CLAIM_INVALID'): Date {
  try {
    const time = Date.prototype.getTime.call(value)
    if (!Number.isFinite(time)) return claimError('La fecha del enlace no es válida.', 422, code)
    return new Date(time)
  } catch {
    return claimError('La fecha del enlace no es válida.', 422, code)
  }
}

function exactTokenBytes(token: string): Buffer | null {
  if (typeof token !== 'string' || !CLAIM_TOKEN_PATTERN.test(token)) return null
  const bytes = Buffer.from(token, 'base64url')
  if (bytes.length !== 32 || bytes.toString('base64url') !== token) return null
  return bytes
}

function tokenHash(bytes: Buffer): string {
  return createHash('sha256').update(Buffer.concat([OFFER_CLAIM_HASH_DOMAIN_V3, bytes])).digest('hex')
}

function requirePublisher(actor: CommercialOfferClaimPublisherV3): void {
  if (!actor.permissions.includes('commercial:publish') && !actor.permissions.includes('*')) {
    throw new ForbiddenError('No tienes permiso para emitir enlaces de oferta.', 'COMMERCIAL_OFFER_CLAIM_FORBIDDEN')
  }
}

function validateIssueInput(input: IssueCommercialOfferClaimV3Input): { expiresAt: Date; reason: string } {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (
    input.confirm !== true ||
    typeof input.offerVersionId !== 'string' ||
    !OFFER_ID_PATTERN.test(input.offerVersionId) ||
    !CHANNELS.has(input.channel) ||
    typeof input.sourceRef !== 'string' ||
    !SOURCE_REF_PATTERN.test(input.sourceRef) ||
    reason.length < 3 ||
    reason.length > 500
  ) {
    return claimError('La solicitud del enlace de oferta no es válida.', 422, 'COMMERCIAL_OFFER_CLAIM_INVALID')
  }
  return { expiresAt: exactDate(input.expiresAt), reason }
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
      return claimError('La oferta no está activa.', 409, 'COMMERCIAL_OFFER_CLAIM_OFFER_INVALID')
    }
    return verified
  } catch (error) {
    if (error instanceof AppError) throw error
    return claimError('La oferta no es válida.', 409, 'COMMERCIAL_OFFER_CLAIM_OFFER_INVALID')
  }
}

function assertClaimWindow(claimStartsAt: string, claimEndsAt: string, now: Date): void {
  const nowTime = now.getTime()
  const startsAt = Date.parse(claimStartsAt)
  const endsAt = Date.parse(claimEndsAt)
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || nowTime < startsAt || nowTime >= endsAt) {
    claimError('La ventana de la oferta está cerrada.', 409, 'COMMERCIAL_OFFER_CLAIM_WINDOW_CLOSED')
  }
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
  return new ConflictError('La autoridad de la oferta está ocupada. Vuelve a intentar.', 'COMMERCIAL_OFFER_CLAIM_UNAVAILABLE', {
    retryable: true,
    attempts: 2,
  })
}

export function createCommercialOfferClaimV3Service(dependencies: CommercialOfferClaimV3Dependencies) {
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
    async issue(input: IssueCommercialOfferClaimV3Input, actor: CommercialOfferClaimPublisherV3) {
      requirePublisher(actor)
      const { expiresAt, reason } = validateIssueInput(input)
      const rawBytes = dependencies.randomBytes(32)
      if (!Buffer.isBuffer(rawBytes) || rawBytes.length !== 32) {
        claimError('No se pudo emitir un enlace seguro.', 500, 'COMMERCIAL_OFFER_CLAIM_ENTROPY_INVALID')
      }
      const claim = rawBytes.toString('base64url')
      if (exactTokenBytes(claim) === null) {
        claimError('No se pudo emitir un enlace seguro.', 500, 'COMMERCIAL_OFFER_CLAIM_ENTROPY_INVALID')
      }

      return withRetry(() =>
        dependencies.runInTransaction(async tx => {
          await tx.setLocalLockTimeout(1_000)
          const now = exactDate(await tx.readDatabaseClock(), 'COMMERCIAL_OFFER_CLAIM_CLOCK_INVALID')
          const offerRow = await tx.lockOffer(input.offerVersionId)
          if (offerRow === null) {
            claimError('La oferta no existe.', 404, 'COMMERCIAL_OFFER_CLAIM_OFFER_NOT_FOUND')
          }
          const offer = verifyOffer(offerRow)
          assertClaimWindow(offer.snapshot.claimStartsAt, offer.snapshot.claimEndsAt, now)
          if (expiresAt <= now || expiresAt.getTime() > Date.parse(offer.snapshot.claimEndsAt)) {
            claimError('El enlace no puede exceder la ventana de la oferta.', 422, 'COMMERCIAL_OFFER_CLAIM_EXPIRY_INVALID')
          }
          const latestControl = await tx.readLatestOfferControl(input.offerVersionId)
          assertCommercialOfferAllowsNewClaimV3(resolveCommercialOfferControlStateV3(latestControl))

          const record: CommercialOfferClaimV3Record = {
            id: dependencies.randomId(),
            tokenHash: tokenHash(rawBytes),
            campaignVersionId: null,
            campaignCode: null,
            offerVersionId: offer.snapshot.campaignVersionId,
            offerSchemaVersion: 3,
            channel: input.channel,
            sourceRef: input.sourceRef,
            issuedById: actor.staffId,
            reason,
            createdAt: now,
            expiresAt,
          }
          await tx.createClaim(record)
          await tx.writeAudit({
            staffId: actor.staffId,
            actorType: null,
            organizationId: null,
            venueId: null,
            action: 'COMMERCIAL_OFFER_CLAIM_ISSUED',
            entity: 'CommercialCampaignClaim',
            entityId: record.id,
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
            data: {
              offerVersionId: record.offerVersionId,
              offerSchemaVersion: 3,
              offerCode: offer.snapshot.campaignCode,
              channel: record.channel,
              sourceRef: record.sourceRef,
              expiresAt: expiresAt.toISOString(),
              reason,
            },
          })
          return { claim, expiresAt: expiresAt.toISOString() }
        }, COMMERCIAL_OFFER_CLAIM_V3_TRANSACTION_OPTIONS),
      )
    },

    async resolve(claim: string, nowInput: Date): Promise<ResolvedCommercialOfferClaimV3> {
      const bytes = exactTokenBytes(claim)
      if (bytes === null) {
        claimError('El enlace de oferta no es válido.', 422, 'COMMERCIAL_OFFER_CLAIM_INVALID')
      }
      const now = exactDate(nowInput)
      return withRetry(() =>
        dependencies.runInTransaction(async tx => {
          await tx.setLocalLockTimeout(1_000)
          const record = await tx.findClaimByTokenHash(tokenHash(bytes))
          if (
            record === null ||
            record.campaignVersionId !== null ||
            record.campaignCode !== null ||
            record.offerSchemaVersion !== 3 ||
            record.offerVersionId.length < 1 ||
            record.offerVersion === null ||
            record.offerVersion.id !== record.offerVersionId
          ) {
            claimError('El enlace de oferta no existe.', 404, 'COMMERCIAL_OFFER_CLAIM_NOT_FOUND')
          }
          if (now >= record.expiresAt) {
            claimError('El enlace de oferta expiró.', 410, 'COMMERCIAL_OFFER_CLAIM_EXPIRED')
          }
          const lockedOffer = await tx.lockOffer(record.offerVersionId)
          if (lockedOffer === null || lockedOffer.id !== record.offerVersion.id || lockedOffer.checksum !== record.offerVersion.checksum) {
            claimError('La oferta reservada no está disponible.', 409, 'COMMERCIAL_OFFER_CLAIM_OFFER_INVALID')
          }
          const offer = verifyOffer(lockedOffer)
          const latestControl = await tx.readLatestOfferControl(record.offerVersionId)
          assertCommercialOfferAllowsNewAcquisitionContextV3(resolveCommercialOfferControlStateV3(latestControl))
          return {
            claimId: record.id,
            offerVersionId: record.offerVersionId,
            offerCode: offer.snapshot.campaignCode,
            offerChecksum: offer.checksum,
            channel: record.channel,
            sourceRef: record.sourceRef,
            createdAt: new Date(record.createdAt.getTime()),
            expiresAt: new Date(record.expiresAt.getTime()),
          }
        }, COMMERCIAL_OFFER_CLAIM_V3_TRANSACTION_OPTIONS),
      )
    },
  })
}

export function createPrismaCommercialOfferClaimV3Transaction(tx: Prisma.TransactionClient): CommercialOfferClaimV3Transaction {
  return {
    setLocalLockTimeout: milliseconds => tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${milliseconds}ms'`),
    async readDatabaseClock() {
      const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
        SELECT date_trunc('milliseconds', pg_catalog.clock_timestamp()) AS "now"
      `)
      if (!rows[0]) claimError('El reloj comercial no está disponible.', 503, 'COMMERCIAL_OFFER_CLAIM_CLOCK_INVALID')
      return rows[0].now
    },
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
    async createClaim(record) {
      await tx.commercialCampaignClaim.create({ data: record })
    },
    async writeAudit(audit) {
      await tx.activityLog.create({
        data: {
          staffId: audit.staffId,
          actorType: audit.actorType,
          organizationId: audit.organizationId,
          venueId: audit.venueId,
          action: audit.action,
          entity: audit.entity,
          entityId: audit.entityId,
          ipAddress: audit.ipAddress,
          userAgent: audit.userAgent,
          data: audit.data as Prisma.InputJsonValue,
        },
      })
    },
    findClaimByTokenHash: tokenHashValue =>
      tx.commercialCampaignClaim.findUnique({
        where: { tokenHash: tokenHashValue },
        include: { offerVersion: true },
      }) as Promise<StoredCommercialOfferClaimV3Record | null>,
  }
}

export function createPrismaCommercialOfferClaimV3Service(host: PrismaClient) {
  return createCommercialOfferClaimV3Service({
    runInTransaction: (operation, options) =>
      host.$transaction(tx => operation(createPrismaCommercialOfferClaimV3Transaction(tx)), options),
    randomBytes,
    randomId: randomUUID,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    retryDelayMilliseconds: () => randomInt(25, 76),
  })
}
