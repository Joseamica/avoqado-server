import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/errors/AppError'
import type { CommercialPublisherActor } from '@/types/commercial'
import type { CommercialAuditInput } from './commercialAudit.service'
import { commercialActivityLogData } from './commercialAudit.service'
import type { CommercialCatalogActivationOutboxRecord, CommercialCatalogPersistedRow } from '@/types/commercialCodec'
import {
  CommercialCatalogAuthorityError,
  verifyCommercialCatalogActivationChain,
  type CommercialCatalogAuthorityPointer,
} from './commercialCatalogAuthority.service'
import {
  indexCommercialActivationEvents,
  parseCommercialPublicationOutboxEvent,
  verifyCommercialClaimedActivationRevision,
  type ClaimedCommercialOutboxRow,
  type CommercialOutboxActivationGraph,
} from './commercialOutbox.service'
import { CommercialArtifactCodecError, decodeAndVerifyCommercialArtifact } from './commercialArtifactCodecRegistry.service'
import { catalogDecodeInput } from './commercialCatalogFallbackBoundary.service'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const STABLE_ERROR_CODES = new Set([
  'COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED',
  'COMMERCIAL_OUTBOX_SCHEMA_FUTURE',
  'COMMERCIAL_OUTBOX_CONTRACT_FUTURE',
  'COMMERCIAL_OUTBOX_AUTHORITY_UNAVAILABLE',
  'COMMERCIAL_OUTBOX_DELIVERY_FAILED',
])

export type CommercialOutboxInspectionErrorCode =
  | 'COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED'
  | 'COMMERCIAL_OUTBOX_SCHEMA_FUTURE'
  | 'COMMERCIAL_OUTBOX_CONTRACT_FUTURE'
  | 'COMMERCIAL_OUTBOX_AUTHORITY_UNAVAILABLE'
  | 'COMMERCIAL_OUTBOX_DELIVERY_FAILED'
  | 'COMMERCIAL_OUTBOX_LEGACY_ERROR'

export interface CommercialOutboxFailedRow {
  id: string
  eventType: string
  publicationId: string
  previousPublicationId: string | null
  status: string
  attempts: number
  lastError: string | null
  nextAttemptAt: Date
  claimedAt: Date | null
  claimExpiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface CommercialOutboxRecoveryLockedRow extends CommercialOutboxFailedRow {
  claimedBy: string | null
  payloadVersion: number
  payload: unknown
  dedupeKey: string
  publication: CommercialCatalogPersistedRow
  previousPublication: CommercialCatalogPersistedRow | null
}

interface CommercialOutboxCursor {
  createdAt: Date
  id: string
}

export interface CommercialOutboxRecoveryDependencies {
  listFailedRows(input: { cursor: CommercialOutboxCursor | null; limit: number }): Promise<CommercialOutboxFailedRow[]>
  getFailedRow(id: string): Promise<CommercialOutboxFailedRow | null>
  runInTransaction<T>(operation: (tx: CommercialOutboxRecoveryTransaction) => Promise<T>): Promise<T>
  now(): Date
}

export interface CommercialOutboxRecoveryTransaction {
  lockFailedRow(id: string): Promise<CommercialOutboxRecoveryLockedRow | null>
  verifyCurrentAuthority(row: CommercialOutboxRecoveryLockedRow): Promise<void>
  requeue(row: CommercialOutboxRecoveryLockedRow, now: Date): Promise<boolean>
  writeAudit(input: CommercialAuditInput): Promise<void>
}

function normalizedErrorCode(value: string | null): CommercialOutboxInspectionErrorCode {
  return value !== null && STABLE_ERROR_CODES.has(value) ? (value as CommercialOutboxInspectionErrorCode) : 'COMMERCIAL_OUTBOX_LEGACY_ERROR'
}

function projectFailedRow(row: CommercialOutboxFailedRow, operationNow: Date) {
  return {
    id: row.id,
    eventType: row.eventType,
    publicationId: row.publicationId,
    previousPublicationId: row.previousPublicationId,
    status: row.status,
    attempts: row.attempts,
    lastErrorCode: normalizedErrorCode(row.lastError),
    nextAttemptAt: row.nextAttemptAt,
    leaseActive: row.claimExpiresAt !== null && row.claimExpiresAt.getTime() > operationNow.getTime(),
    claimedAt: row.claimedAt,
    claimExpiresAt: row.claimExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function encodeCursor(row: CommercialOutboxFailedRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }), 'utf8').toString('base64url')
}

function decodeCursor(value: string | undefined): CommercialOutboxCursor | null {
  if (!value) return null
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw new Error('invalid')
    const keys = Object.keys(decoded)
    const createdAt = (decoded as Record<string, unknown>).createdAt
    const id = (decoded as Record<string, unknown>).id
    if (keys.length !== 2 || typeof createdAt !== 'string' || typeof id !== 'string' || id.length === 0) throw new Error('invalid')
    const date = new Date(createdAt)
    if (Number.isNaN(date.getTime()) || date.toISOString() !== createdAt) throw new Error('invalid')
    return { createdAt: date, id }
  } catch {
    throw new ValidationError('El cursor del outbox comercial no es válido.')
  }
}

const failedRowSelect = {
  id: true,
  eventType: true,
  publicationId: true,
  previousPublicationId: true,
  status: true,
  attempts: true,
  lastError: true,
  nextAttemptAt: true,
  claimedAt: true,
  claimExpiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const

export const prismaCommercialOutboxRecoveryDependencies: CommercialOutboxRecoveryDependencies = {
  now: () => new Date(),
  listFailedRows: ({ cursor, limit }) =>
    prisma.commercialPublicationOutbox.findMany({
      where: {
        status: 'FAILED',
        ...(cursor
          ? {
              OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: failedRowSelect,
    }),
  getFailedRow: id =>
    prisma.commercialPublicationOutbox.findFirst({
      where: { id, status: 'FAILED' },
      select: failedRowSelect,
    }),
  runInTransaction: operation =>
    prisma.$transaction(
      async tx => {
        const adapter: CommercialOutboxRecoveryTransaction = {
          async lockFailedRow(id) {
            await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id"
              FROM "CommercialPublicationOutbox"
              WHERE "id" = ${id}
              FOR UPDATE
            `
            return tx.commercialPublicationOutbox.findUnique({
              where: { id },
              include: { publication: true, previousPublication: true },
            }) as Promise<CommercialOutboxRecoveryLockedRow | null>
          },
          async verifyCurrentAuthority(row) {
            const event = parseCommercialPublicationOutboxEvent(row as unknown as ClaimedCommercialOutboxRow)
            if (
              row.publication.id !== event.publicationId ||
              row.publication.schemaVersion !== event.schemaVersion ||
              row.publication.checksum !== event.checksum
            ) {
              throw new Error('COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED')
            }
            if (event.type === 'PUBLICATION_CREATED') {
              const decoded = decodeAndVerifyCommercialArtifact(catalogDecodeInput(row.publication))
              if (decoded.kind !== 'CATALOG') throw new Error('COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED')
              return
            }
            const pointer = (await tx.commercialPublicationActivation.findUnique({
              where: { environment: 'PRODUCTION' },
              include: { publication: true },
            })) as CommercialCatalogAuthorityPointer | null
            const activationEvents = (await tx.commercialPublicationOutbox.findMany({
              where: { eventType: { in: ['PUBLICATION_ACTIVATED', 'PUBLICATION_ROLLED_BACK'] } },
              include: { publication: true, previousPublication: true },
            })) as CommercialCatalogActivationOutboxRecord[]
            const graph: CommercialOutboxActivationGraph = { pointer, activationEvents }
            if (!pointer) throw new Error('COMMERCIAL_OUTBOX_AUTHORITY_UNAVAILABLE')
            const decision = verifyCommercialCatalogActivationChain({ pointer, activationEvents })
            const verified = verifyCommercialClaimedActivationRevision({
              row: row as unknown as ClaimedCommercialOutboxRow,
              event,
              graph,
              decision,
              eventsByRevision: indexCommercialActivationEvents(activationEvents),
            })
            const decoded = decodeAndVerifyCommercialArtifact(catalogDecodeInput(verified.publication))
            if (decoded.kind !== 'CATALOG') throw new Error('COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED')
          },
          async requeue(row, transactionNow) {
            const updated = await tx.commercialPublicationOutbox.updateMany({
              where: {
                id: row.id,
                status: 'FAILED',
                attempts: row.attempts,
                lastError: row.lastError,
              },
              data: {
                status: 'PENDING',
                attempts: 0,
                nextAttemptAt: transactionNow,
                claimedBy: null,
                claimedAt: null,
                claimExpiresAt: null,
                lastError: null,
              },
            })
            return updated.count === 1
          },
          async writeAudit(input) {
            await tx.activityLog.create({ data: commercialActivityLogData(input) })
          },
        }
        return operation(adapter)
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 5_000,
        timeout: 30_000,
      },
    ),
}

export interface RequeueFailedCommercialOutboxInput {
  observedAttempts: number
  observedLastErrorCode: CommercialOutboxInspectionErrorCode
  reason: string
  confirm: true
}

function requirePublisher(actor: CommercialPublisherActor): void {
  if (!actor.permissions.includes('commercial:publish') && !actor.permissions.includes('*')) {
    throw new ForbiddenError('No tienes permiso para recuperar el outbox comercial.', 'COMMERCIAL_PUBLISH_FORBIDDEN')
  }
}

function recoveryConflict(): never {
  throw new ConflictError('El evento fallido cambió o todavía no tiene autoridad comercial válida.', 'COMMERCIAL_OUTBOX_RECOVERY_CONFLICT')
}

function isCommercialAuthorityRejection(error: unknown): boolean {
  if (error instanceof CommercialArtifactCodecError || error instanceof CommercialCatalogAuthorityError) return true
  return (
    error instanceof Error && ['COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED', 'COMMERCIAL_OUTBOX_AUTHORITY_UNAVAILABLE'].includes(error.message)
  )
}

export function createCommercialOutboxRecoveryService(
  dependencies: CommercialOutboxRecoveryDependencies = prismaCommercialOutboxRecoveryDependencies,
) {
  return {
    async listFailed(input: { cursor?: string; limit?: number } = {}) {
      const limit = input.limit ?? DEFAULT_LIMIT
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new ValidationError('El límite del outbox comercial debe estar entre 1 y 100.')
      }
      const rows = await dependencies.listFailedRows({ cursor: decodeCursor(input.cursor), limit: limit + 1 })
      const hasMore = rows.length > limit
      const visible = hasMore ? rows.slice(0, limit) : rows
      const operationNow = dependencies.now()
      return {
        items: visible.map(row => projectFailedRow(row, operationNow)),
        nextCursor: hasMore ? encodeCursor(visible[visible.length - 1]) : null,
      }
    },
    async getFailed(id: string) {
      const row = await dependencies.getFailedRow(id)
      if (!row) throw new NotFoundError('Evento fallido del outbox comercial no encontrado.')
      return projectFailedRow(row, dependencies.now())
    },
    async requeueFailed(id: string, input: RequeueFailedCommercialOutboxInput, actor: CommercialPublisherActor) {
      requirePublisher(actor)
      if (input.confirm !== true) throw new ValidationError('Confirma explícitamente la recuperación del outbox comercial.')
      if (!Number.isInteger(input.observedAttempts) || input.observedAttempts < 0 || input.observedAttempts > 2_147_483_647) {
        throw new ValidationError('El número observado de intentos no es válido.')
      }
      if (!STABLE_ERROR_CODES.has(input.observedLastErrorCode) && input.observedLastErrorCode !== 'COMMERCIAL_OUTBOX_LEGACY_ERROR') {
        throw new ValidationError('El código observado del outbox comercial no es válido.')
      }
      const reason = input.reason.trim()
      if (reason.length < 3 || reason.length > 500) throw new ValidationError('Se requiere un motivo de recuperación.')
      return dependencies.runInTransaction(async tx => {
        const row = await tx.lockFailedRow(id)
        const transactionNow = dependencies.now()
        if (
          !row ||
          row.status !== 'FAILED' ||
          row.attempts !== input.observedAttempts ||
          normalizedErrorCode(row.lastError) !== input.observedLastErrorCode ||
          (row.claimExpiresAt !== null && row.claimExpiresAt.getTime() > transactionNow.getTime())
        ) {
          return recoveryConflict()
        }
        try {
          await tx.verifyCurrentAuthority(row)
        } catch (error) {
          if (isCommercialAuthorityRejection(error)) return recoveryConflict()
          throw error
        }
        if (!(await tx.requeue(row, transactionNow))) return recoveryConflict()
        await tx.writeAudit({
          action: 'COMMERCIAL_OUTBOX_FAILURE_REQUEUED',
          entity: 'CommercialPublicationOutbox',
          entityId: row.id,
          actor: { ...actor, reason },
          before: { attempts: row.attempts, lastErrorCode: normalizedErrorCode(row.lastError) },
          after: { status: 'PENDING', attempts: 0, nextAttemptAt: transactionNow.toISOString() },
        })
        return { id: row.id, status: 'PENDING' as const, attempts: 0, nextAttemptAt: transactionNow }
      })
    },
  }
}

export const commercialOutboxRecoveryService = createCommercialOutboxRecoveryService()
