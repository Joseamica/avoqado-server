import { createHash, randomInt, randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

import AppError, { ConflictError, ForbiddenError } from '@/errors/AppError'

export type CommercialOfferControlStateV3 = 'OPEN' | 'SUSPEND_NEW_CLAIMS' | 'SUSPEND_ALL_PENDING'
export type CommercialOfferControlActionV3 = 'SUSPEND_NEW_CLAIMS' | 'SUSPEND_ALL_PENDING' | 'RESUME'

export interface CreateCommercialOfferControlEventV3Input {
  offerVersionId: string
  action: CommercialOfferControlActionV3
  reason: string
  confirmedById: string
  confirm: true
}

export interface CommercialOfferControlActorV3 {
  staffId: string
  permissions: readonly string[]
  ipAddress?: string
  userAgent?: string
}

export interface CommercialOfferControlLatestEventV3 {
  revision: number
  action: CommercialOfferControlActionV3
}

export interface CommercialOfferControlEventV3 extends CommercialOfferControlLatestEventV3 {
  id: string
  offerVersionId: string
  offerSchemaVersion: 3
  reason: string
  confirmedById: string
}

export interface CommercialOfferControlResultV3 extends CommercialOfferControlEventV3 {
  state: CommercialOfferControlStateV3
}

export interface CommercialOfferControlAuditV3 {
  staffId: string
  actorType: null
  organizationId: null
  venueId: null
  action: 'COMMERCIAL_OFFER_CONTROL_CHANGED' | 'COMMERCIAL_OFFER_CONTROL_FAILED'
  entity: 'CommercialCampaignVersion'
  entityId: string
  ipAddress?: string
  userAgent?: string
  data: {
    offerSchemaVersion: 3
    revision?: number
    controlAction?: CommercialOfferControlActionV3
    state?: CommercialOfferControlStateV3
    attemptedAction?: CommercialOfferControlActionV3
    code?: 'COMMERCIAL_OFFER_CONTROL_UNAVAILABLE'
    attempts?: 3
  }
}

export interface CommercialOfferControlTransactionV3 {
  setLocalLockTimeout(milliseconds: number): Promise<void>
  lockOffer(offerVersionId: string, mode: 'FOR_SHARE' | 'FOR_UPDATE'): Promise<{ id: string; schemaVersion: number } | null>
  readLatestEvent(offerVersionId: string): Promise<CommercialOfferControlLatestEventV3 | null>
  createEvent(input: CommercialOfferControlEventV3): Promise<CommercialOfferControlEventV3>
  writeControlOutbox(input: {
    eventId: string
    sourceType: 'OFFER_CONTROL_EVENT'
    sourceId: string
    sourceRevision: number
    eventType: 'COMMERCIAL_OFFER_CONTROL_CHANGED'
    payload: {
      schemaVersion: 1
      offerVersionId: string
      offerSchemaVersion: 3
      controlEventId: string
      controlAction: CommercialOfferControlActionV3
      state: CommercialOfferControlStateV3
    }
  }): Promise<void>
  writeChangedAudit(input: CommercialOfferControlAuditV3): Promise<void>
}

export interface CommercialOfferControlV3Dependencies {
  runInTransaction<T>(
    operation: (tx: CommercialOfferControlTransactionV3) => Promise<T>,
    options: {
      maxWait: number
      timeout: number
      isolationLevel: Prisma.TransactionIsolationLevel
    },
  ): Promise<T>
  writeFailedAudit(input: CommercialOfferControlAuditV3): Promise<void>
  randomId(): string
  sleep(milliseconds: number): Promise<void>
}

export const COMMERCIAL_OFFER_CONTROL_V3_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 15_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
})

const OFFER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CONTROL_ACTIONS = new Set<CommercialOfferControlActionV3>(['SUSPEND_NEW_CLAIMS', 'SUSPEND_ALL_PENDING', 'RESUME'])
const RETRYABLE_POSTGRES_CODES = new Set(['55P03', '57014', '40001', '40P01'])

function controlError(message: string, statusCode: number, code: string, details?: unknown): AppError {
  return new AppError(message, statusCode, true, code, details)
}

function postgresCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const candidate = error as { code?: unknown; meta?: unknown }
  if (typeof candidate.code === 'string' && RETRYABLE_POSTGRES_CODES.has(candidate.code)) return candidate.code
  if (candidate.code !== 'P2010' || typeof candidate.meta !== 'object' || candidate.meta === null) return null
  const nested = (candidate.meta as { code?: unknown }).code
  return typeof nested === 'string' && RETRYABLE_POSTGRES_CODES.has(nested) ? nested : null
}

function unavailable(): ConflictError {
  return new ConflictError('El control de la oferta está ocupado. Vuelve a intentar.', 'COMMERCIAL_OFFER_CONTROL_UNAVAILABLE', {
    retryable: true,
    attempts: 3,
  })
}

function validateCreateInput(input: CreateCommercialOfferControlEventV3Input, actor: CommercialOfferControlActorV3): string {
  if (!actor.permissions.includes('commercial:publish') && !actor.permissions.includes('*')) {
    throw new ForbiddenError('No tienes permiso para controlar ofertas.', 'COMMERCIAL_OFFER_CONTROL_FORBIDDEN')
  }
  if (input.confirm !== true) {
    throw controlError('Confirma el cambio de control.', 422, 'COMMERCIAL_OFFER_CONTROL_CONFIRMATION_REQUIRED')
  }
  if (input.confirmedById !== actor.staffId) {
    throw controlError('El actor confirmado no coincide.', 422, 'COMMERCIAL_OFFER_CONTROL_ACTOR_MISMATCH')
  }
  if (
    typeof input.offerVersionId !== 'string' ||
    !OFFER_ID_PATTERN.test(input.offerVersionId) ||
    typeof input.action !== 'string' ||
    !CONTROL_ACTIONS.has(input.action) ||
    typeof input.reason !== 'string'
  ) {
    throw controlError('El cambio de control no es válido.', 422, 'COMMERCIAL_OFFER_CONTROL_INPUT_INVALID')
  }
  const reason = input.reason.trim()
  if (reason.length < 3 || reason.length > 500) {
    throw controlError('Se requiere un motivo válido.', 422, 'COMMERCIAL_OFFER_CONTROL_REASON_INVALID')
  }
  return reason
}

export function resolveCommercialOfferControlStateV3(latest: CommercialOfferControlLatestEventV3 | null): CommercialOfferControlStateV3 {
  if (latest === null || latest.action === 'RESUME') return 'OPEN'
  if (latest.action === 'SUSPEND_NEW_CLAIMS') return 'SUSPEND_NEW_CLAIMS'
  if (latest.action === 'SUSPEND_ALL_PENDING') return 'SUSPEND_ALL_PENDING'
  throw controlError(
    'El estado de control de la oferta no es compatible.',
    409,
    'COMMERCIAL_OFFER_CONTROL_STATE_INVALID',
  )
}

function assertPendingAllowed(state: CommercialOfferControlStateV3): void {
  if (state === 'SUSPEND_ALL_PENDING') {
    throw new ConflictError('La oferta suspendió operaciones pendientes.', 'COMMERCIAL_OFFER_PENDING_SUSPENDED')
  }
}

function assertNewAcquisitionAllowed(state: CommercialOfferControlStateV3): void {
  if (state !== 'OPEN') {
    throw new ConflictError(
      'La oferta suspendió nuevas adquisiciones.',
      'COMMERCIAL_OFFER_NEW_ACQUISITION_SUSPENDED',
    )
  }
}

function offerControlOutboxEventId(controlEventId: string, revision: number): string {
  return createHash('sha256')
    .update(`avoqado:commercial-offer-control:${controlEventId}:revision:${revision}`)
    .digest('hex')
}

export function assertCommercialOfferAllowsNewClaimV3(state: CommercialOfferControlStateV3): void {
  assertNewAcquisitionAllowed(state)
}

export function assertCommercialOfferAllowsNewAcquisitionContextV3(state: CommercialOfferControlStateV3): void {
  assertNewAcquisitionAllowed(state)
}

export function assertCommercialOfferAllowsPreviewV3(state: CommercialOfferControlStateV3): void {
  assertPendingAllowed(state)
}

export function assertCommercialOfferAllowsBridgeV3(state: CommercialOfferControlStateV3): void {
  assertPendingAllowed(state)
}

export function assertCommercialOfferAllowsDirectQuoteV3(state: CommercialOfferControlStateV3): void {
  assertPendingAllowed(state)
}

export function assertCommercialOfferAllowsAcceptanceV3(state: CommercialOfferControlStateV3): void {
  assertPendingAllowed(state)
}

function changedAudit(
  input: CreateCommercialOfferControlEventV3Input,
  actor: CommercialOfferControlActorV3,
  revision: number,
  state: CommercialOfferControlStateV3,
): CommercialOfferControlAuditV3 {
  return {
    staffId: actor.staffId,
    actorType: null,
    organizationId: null,
    venueId: null,
    action: 'COMMERCIAL_OFFER_CONTROL_CHANGED',
    entity: 'CommercialCampaignVersion',
    entityId: input.offerVersionId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    data: {
      offerSchemaVersion: 3,
      revision,
      controlAction: input.action,
      state,
    },
  }
}

function failedAudit(input: CreateCommercialOfferControlEventV3Input, actor: CommercialOfferControlActorV3): CommercialOfferControlAuditV3 {
  return {
    staffId: actor.staffId,
    actorType: null,
    organizationId: null,
    venueId: null,
    action: 'COMMERCIAL_OFFER_CONTROL_FAILED',
    entity: 'CommercialCampaignVersion',
    entityId: input.offerVersionId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    data: {
      offerSchemaVersion: 3,
      attemptedAction: input.action,
      code: 'COMMERCIAL_OFFER_CONTROL_UNAVAILABLE',
      attempts: 3,
    },
  }
}

export function createCommercialOfferControlV3Service(dependencies: CommercialOfferControlV3Dependencies) {
  return {
    async create(
      input: CreateCommercialOfferControlEventV3Input,
      actor: CommercialOfferControlActorV3,
    ): Promise<CommercialOfferControlResultV3> {
      const reason = validateCreateInput(input, actor)
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          return await dependencies.runInTransaction(async tx => {
            await tx.setLocalLockTimeout(5_000)
            const offer = await tx.lockOffer(input.offerVersionId, 'FOR_UPDATE')
            if (offer === null || offer.schemaVersion !== 3) {
              throw controlError('Oferta v3 no encontrada.', 404, 'COMMERCIAL_OFFER_CONTROL_OFFER_NOT_FOUND')
            }
            const latest = await tx.readLatestEvent(input.offerVersionId)
            const revision = (latest?.revision ?? 0) + 1
            if (revision > 2_147_483_647) {
              throw new ConflictError('Se agotó la secuencia de control.', 'COMMERCIAL_OFFER_CONTROL_REVISION_EXHAUSTED')
            }
            const event: CommercialOfferControlEventV3 = {
              id: dependencies.randomId(),
              offerVersionId: input.offerVersionId,
              offerSchemaVersion: 3,
              revision,
              action: input.action,
              reason,
              confirmedById: actor.staffId,
            }
            const created = await tx.createEvent(event)
            const state = resolveCommercialOfferControlStateV3(created)
            await tx.writeControlOutbox({
              eventId: offerControlOutboxEventId(created.id, revision),
              sourceType: 'OFFER_CONTROL_EVENT',
              sourceId: created.id,
              sourceRevision: revision,
              eventType: 'COMMERCIAL_OFFER_CONTROL_CHANGED',
              payload: {
                schemaVersion: 1,
                offerVersionId: input.offerVersionId,
                offerSchemaVersion: 3,
                controlEventId: created.id,
                controlAction: created.action,
                state,
              },
            })
            await tx.writeChangedAudit(changedAudit(input, actor, revision, state))
            return { ...created, state }
          }, COMMERCIAL_OFFER_CONTROL_V3_TRANSACTION_OPTIONS)
        } catch (error) {
          if (postgresCode(error) === null) throw error
          if (attempt < 3) {
            await dependencies.sleep(randomInt(25, 76))
            continue
          }
          await dependencies.writeFailedAudit(failedAudit(input, actor)).catch(() => undefined)
          throw unavailable()
        }
      }
      throw unavailable()
    },
  }
}

export function createPrismaCommercialOfferControlTransactionV3(tx: Prisma.TransactionClient): CommercialOfferControlTransactionV3 {
  return {
    async setLocalLockTimeout(milliseconds) {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${milliseconds}ms'`)
    },
    async lockOffer(offerVersionId, mode) {
      const clause = mode === 'FOR_UPDATE' ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`
      const rows = await tx.$queryRaw<Array<{ id: string; schemaVersion: number }>>(Prisma.sql`
        SELECT "id", "schemaVersion"
        FROM "CommercialCampaignVersion"
        WHERE "id" = ${offerVersionId} AND "schemaVersion" = 3
        ${clause}
      `)
      return rows[0] ?? null
    },
    readLatestEvent: offerVersionId =>
      tx.commercialOfferControlEvent.findFirst({
        where: { offerVersionId },
        orderBy: { revision: 'desc' },
        select: { revision: true, action: true },
      }),
    async createEvent(input) {
      await tx.commercialOfferControlEvent.create({ data: input })
      return input
    },
    async writeControlOutbox(input) {
      await tx.commercialEventOutbox.create({
        data: {
          eventId: input.eventId,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          sourceRevision: input.sourceRevision,
          eventType: input.eventType,
          payload: input.payload,
          status: 'PENDING',
          attemptCount: 0,
          availableAt: new Date(),
        },
      })
    },
    async writeChangedAudit(input) {
      await tx.activityLog.create({
        data: {
          staffId: input.staffId,
          actorType: input.actorType,
          organizationId: input.organizationId,
          venueId: input.venueId,
          action: input.action,
          entity: input.entity,
          entityId: input.entityId,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          data: input.data as Prisma.InputJsonValue,
        },
      })
    },
  }
}

export function createPrismaCommercialOfferControlV3Service(host: PrismaClient) {
  return createCommercialOfferControlV3Service({
    runInTransaction: (operation, options) =>
      host.$transaction(tx => operation(createPrismaCommercialOfferControlTransactionV3(tx)), options),
    async writeFailedAudit(input) {
      await host.activityLog.create({
        data: {
          staffId: input.staffId,
          actorType: input.actorType,
          organizationId: input.organizationId,
          venueId: input.venueId,
          action: input.action,
          entity: input.entity,
          entityId: input.entityId,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          data: input.data as Prisma.InputJsonValue,
        },
      })
    },
    randomId: randomUUID,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  })
}
