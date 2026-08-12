import { Prisma } from '@prisma/client'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import AppError, { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import type {
  CatalogCommandContext,
  CatalogPublicationConfirmInput,
  CatalogPublicationInProgress,
  CatalogPublicationOperation,
  CatalogPublicationResult,
  CatalogPublicationResultLine,
} from '../../types/master-catalog'
import { writeCatalogAudit } from './catalogAudit.service'
import { canonicalJsonV1, hashCanonicalJsonV1 } from './catalogHash.service'
import { enqueueCatalogPublicationOutboxTx } from './catalogPublicationOutbox.service'
import { persistCatalogPublicationTx } from './catalogPublicationPersistence.service'
import type { CatalogPublicationApplyLine } from './catalogPublication.types'
import {
  type CatalogPublicationBatchAuthority,
  lockCatalogPublicationAuthoritiesTx,
  revalidateLockedCatalogPublicationTx,
} from './catalogPublicationAuthorityLock.service'
import { resolveMasterCatalogAccess } from './masterCatalogAccess.service'
import { isCatalogPublicationIdempotencyKey } from './catalogPublicationPreview.service'
import { validateCatalogPublicationAppliedResultTx } from './catalogPublicationRecovery.service'
import { applyCatalogProductActivationTx } from './catalogPublicationActivation.service'
import { applyCatalogPublicationReversionsTx, projectCatalogPublicationReversion } from './catalogPublicationReversion.service'
import { revalidateLockedCatalogPublicationReversionsTx } from './catalogPublicationReversionAuthority.service'
import {
  acquireCatalogPublicationAttemptLockTx,
  CATALOG_PUBLICATION_TRANSACTION_OPTIONS,
  isSupportedCatalogPublicationOperation,
  retryCatalogPublicationReservationOnce,
} from './catalogPublicationAttempt.service'

export { acquireCatalogPublicationAttemptLockTx } from './catalogPublicationAttempt.service'

type BatchAuthority = CatalogPublicationBatchAuthority

interface ConfirmationDependencies {
  prisma: typeof prisma
  assertAccessTx: (tx: Prisma.TransactionClient, context: CatalogCommandContext) => Promise<void>
  acquireAttemptLockTx: (tx: Prisma.TransactionClient, organizationId: string, batchId: string) => Promise<void>
  lockAuthoritiesTx: (tx: Prisma.TransactionClient, context: CatalogCommandContext, batch: BatchAuthority) => Promise<void>
  revalidateTx: (
    tx: Prisma.TransactionClient,
    context: CatalogCommandContext,
    batch: BatchAuthority,
  ) => Promise<CatalogPublicationApplyLine[]>
  persistTx: typeof persistCatalogPublicationTx
  applyActivationTx: typeof applyCatalogProductActivationTx
  revalidateReversionsTx: (
    tx: Prisma.TransactionClient,
    context: CatalogCommandContext,
    batch: BatchAuthority,
  ) => ReturnType<typeof revalidateLockedCatalogPublicationReversionsTx>
  applyReversionsTx: typeof applyCatalogPublicationReversionsTx
  enqueueOutboxTx: typeof enqueueCatalogPublicationOutboxTx
  writeAudit: typeof writeCatalogAudit
  now: () => Date
  randomAttemptId: () => string
}

function stale(message: string): never {
  throw new ConflictError(message, 'STALE_PREVIEW')
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))

const semanticString = (value: unknown, maxBytes: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes

function validateInput(input: unknown): asserts input is CatalogPublicationConfirmInput {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ['confirm', 'publicationBatchId', 'previewToken', 'idempotencyKey']) ||
    input.confirm !== true ||
    !semanticString(input.publicationBatchId, 256) ||
    !semanticString(input.previewToken, 512) ||
    !isCatalogPublicationIdempotencyKey(input.idempotencyKey)
  ) {
    // WHY: Reject bearer material and lookup keys before Prisma/crypto so malformed JSON cannot become an allocation DoS.
    throw new AppError('La forma de confirmación es inválida.', 422, true, 'CATALOG_PUBLICATION_INPUT_INVALID')
  }
}

function previewTokenMatches(storedHash: unknown, suppliedToken: string): boolean {
  if (typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) return false
  const suppliedHash = createHash('sha256').update(suppliedToken, 'utf8').digest('hex')
  return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(suppliedHash, 'hex'))
}

function assertDual(batch: BatchAuthority, record: Record<string, unknown>, context: CatalogCommandContext): void {
  let dependenciesMatch = false
  try {
    dependenciesMatch = canonicalJsonV1(batch.dependencies) === canonicalJsonV1(record.dependencies)
  } catch {
    dependenciesMatch = false
  }
  if (
    batch.schemaVersion !== 1 ||
    batch.requestHashVersion !== 1 ||
    record.requestHashVersion !== 1 ||
    batch.organizationId !== record.organizationId ||
    batch.operation !== record.operation ||
    batch.requestHash !== record.requestHash ||
    batch.targetHash !== record.targetHash ||
    batch.previewTokenHash !== record.previewTokenHash ||
    batch.previewExpiresAt.getTime() !== (record.previewExpiresAt as Date)?.getTime() ||
    !dependenciesMatch ||
    batch.state !== record.state ||
    batch.actorType !== record.actorType ||
    batch.staffId !== record.staffId ||
    batch.servicePrincipalId !== record.servicePrincipalId ||
    batch.actorType !== 'HUMAN' ||
    context.actor.type !== 'HUMAN' ||
    batch.staffId !== context.actor.staffId ||
    record.resourceType !== 'CatalogPublicationBatch' ||
    record.resourceId !== batch.id
  ) {
    throw new ConflictError('La autoridad dual del preview es inválida.', 'CATALOG_PUBLICATION_STAGING_INVALID')
  }
}

async function defaultAssertAccessTx(tx: Prisma.TransactionClient, context: CatalogCommandContext): Promise<void> {
  if (context.actor.type !== 'HUMAN' || context.actor.impersonating) {
    throw new ForbiddenError('La confirmación requiere OWNER/ADMIN humano no suplantado')
  }
  const access = await resolveMasterCatalogAccess({
    organizationId: context.organizationId,
    principal: context.actor,
    capability: 'MUTATE_CONTENT',
    requiredGate: 'CORE',
    prisma: tx,
  })
  if (access.reasonCode === 'DEPENDENCY_UNAVAILABLE') {
    throw new ServiceUnavailableError('No fue posible revalidar Catalog Core', 'DEPENDENCY_UNAVAILABLE')
  }
  if (!access.canMutateContent) throw new ForbiddenError('No puedes confirmar esta publicación')
}

const defaults: ConfirmationDependencies = {
  prisma,
  assertAccessTx: defaultAssertAccessTx,
  acquireAttemptLockTx: acquireCatalogPublicationAttemptLockTx,
  lockAuthoritiesTx: lockCatalogPublicationAuthoritiesTx,
  revalidateTx: revalidateLockedCatalogPublicationTx,
  persistTx: persistCatalogPublicationTx,
  applyActivationTx: applyCatalogProductActivationTx,
  revalidateReversionsTx: (tx, context, batch) =>
    revalidateLockedCatalogPublicationReversionsTx(tx, context, batch, projectCatalogPublicationReversion),
  applyReversionsTx: applyCatalogPublicationReversionsTx,
  enqueueOutboxTx: enqueueCatalogPublicationOutboxTx,
  writeAudit: writeCatalogAudit,
  now: () => new Date(),
  randomAttemptId: randomUUID,
}

async function activationAuthorityTx(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  batch: BatchAuthority,
): Promise<{
  lineId: string
  catalogItemId: string
  venueId: string
  productId: string
  bindingId: string
  expectedSourceCatalogRevision: number
  expectedSourceCatalogInvariantVersion: string
  expectedBindingRevision: number
  expectedCanonicalTargetHash: string
  expectedReadiness: unknown
}> {
  if (
    !isPlainObject(batch.dependencies) ||
    batch.dependencies.schemaVersion !== 1 ||
    !Array.isArray(batch.dependencies.targets) ||
    batch.dependencies.targets.length !== 1
  ) {
    stale('La autoridad de activación es inválida.')
  }
  const target = batch.dependencies.targets[0]
  if (!isPlainObject(target) || !isPlainObject(target.dependencies) || !isPlainObject(target.dependencies.activation)) {
    stale('El target de activación es inválido.')
  }
  const activation = target.dependencies.activation
  if (
    !hasExactKeys(activation, [
      'itemRevision',
      'itemInvariantVersion',
      'bindingRevision',
      'publicationAuthorityValid',
      'profileEvaluationValid',
      'readiness',
    ]) ||
    activation.itemRevision !== target.sourceCatalogRevision ||
    activation.itemInvariantVersion !== target.sourceCatalogInvariantVersion ||
    activation.bindingRevision !== target.bindingRevision ||
    activation.publicationAuthorityValid !== true ||
    activation.profileEvaluationValid !== true ||
    !isPlainObject(activation.readiness) ||
    !hasExactKeys(activation.readiness, ['state', 'dependencies']) ||
    activation.readiness.state !== 'READY'
  )
    stale('Los prerequisitos staged de activación son inválidos.')
  const lines = await tx.catalogPublicationLine.findMany({
    where: { batchId: batch.id, organizationId: context.organizationId },
    take: 2,
  })
  const line = lines[0]
  if (
    lines.length !== 1 ||
    !line ||
    line.organizationId !== context.organizationId ||
    line.batchId !== batch.id ||
    line.catalogItemId !== target.catalogItemId ||
    line.venueId !== target.venueId ||
    line.productId !== target.productId ||
    line.bindingId !== target.bindingId ||
    line.sourceCatalogRevision !== target.sourceCatalogRevision ||
    line.bindingRevision !== target.bindingRevision ||
    line.status !== 'READY' ||
    line.hashVersion !== 1 ||
    line.decisionSchemaVersion !== 1 ||
    line.changeKind !== 'PUBLICATION' ||
    canonicalJsonV1(line.fieldMask) !== canonicalJsonV1(['active']) ||
    canonicalJsonV1(line.before) !== canonicalJsonV1({ active: false }) ||
    canonicalJsonV1(line.after) !== canonicalJsonV1({ active: true }) ||
    line.supersedesLineId !== null ||
    line.reversesLineId !== null
  )
    stale('La línea staged de activación es inválida.')
  const expectedBatchTargetHash = hashCanonicalJsonV1('catalog-publication-targets', {
    operation: 'CATALOG_PRODUCT_ACTIVATION',
    targets: [line.canonicalTargetHash],
  })
  if (batch.targetHash !== expectedBatchTargetHash) stale('El targetHash de activación es inválido.')
  return {
    lineId: line.id,
    catalogItemId: target.catalogItemId as string,
    venueId: target.venueId as string,
    productId: target.productId as string,
    bindingId: target.bindingId as string,
    expectedSourceCatalogRevision: target.sourceCatalogRevision as number,
    expectedSourceCatalogInvariantVersion: target.sourceCatalogInvariantVersion as string,
    expectedBindingRevision: target.bindingRevision as number,
    expectedCanonicalTargetHash: line.canonicalTargetHash,
    expectedReadiness: activation.readiness,
  }
}

export function createCatalogPublicationConfirmationService(overrides: Partial<ConfirmationDependencies> = {}) {
  const dependencies = { ...defaults, ...overrides }
  return {
    async confirm(
      context: CatalogCommandContext,
      input: CatalogPublicationConfirmInput,
    ): Promise<CatalogPublicationResult | CatalogPublicationInProgress> {
      validateInput(input)
      if (context.actor.type !== 'HUMAN' || context.actor.impersonating) {
        throw new ForbiddenError('La confirmación requiere OWNER/ADMIN humano no suplantado')
      }
      const staffId = context.actor.staffId

      const reserve = () =>
        dependencies.prisma.$transaction(async tx => {
          await dependencies.assertAccessTx(tx, context)
          await dependencies.acquireAttemptLockTx(tx, context.organizationId, input.publicationBatchId)
          const batch = (await tx.catalogPublicationBatch.findFirst({
            where: { id: input.publicationBatchId, organizationId: context.organizationId },
          })) as BatchAuthority | null
          if (!batch) throw new NotFoundError('Preview de publicación no encontrado')
          if (!isSupportedCatalogPublicationOperation(batch.operation)) {
            throw new AppError('Operación de publicación no soportada.', 422, true, 'CATALOG_PUBLICATION_OPERATION_UNSUPPORTED')
          }
          const record = (await tx.catalogIdempotencyRecord.findUnique({
            where: {
              organizationId_operation_idempotencyKey: {
                organizationId: context.organizationId,
                operation: batch.operation,
                idempotencyKey: input.idempotencyKey,
              },
            },
          })) as unknown as Record<string, unknown> | null
          if (!record) stale('La key ya no pertenece a este preview.')
          assertDual(batch, record, context)
          if (!previewTokenMatches(batch.previewTokenHash, input.previewToken)) stale('El token de preview no coincide.')
          if (batch.state === 'APPLIED') {
            let durableResultsMatch = false
            try {
              durableResultsMatch = canonicalJsonV1(batch.result) === canonicalJsonV1(record.result)
            } catch {
              durableResultsMatch = false
            }
            if (!durableResultsMatch) {
              throw new ConflictError('Resultado durable inválido.', 'CATALOG_PUBLICATION_RESULT_INVALID')
            }
            const result = await validateCatalogPublicationAppliedResultTx(tx, {
              organizationId: context.organizationId,
              publicationBatchId: batch.id,
              operation: batch.operation as CatalogPublicationOperation,
              recordResult: record.result,
              batchResult: batch.result,
            })
            return { kind: 'done' as const, result }
          }
          if (batch.state === 'APPLYING') {
            const retryAfterSeconds = Math.max(
              0,
              Math.min(
                60,
                Math.ceil(((batch.leaseExpiresAt?.getTime() ?? dependencies.now().getTime()) - dependencies.now().getTime()) / 1_000),
              ),
            )
            return {
              kind: 'done' as const,
              result: {
                publicationBatchId: batch.id,
                operation: batch.operation as CatalogPublicationOperation,
                state: 'IN_PROGRESS' as const,
                retryAfterSeconds,
              },
            }
          }
          if (batch.state !== 'PREVIEWED') {
            throw new ConflictError('El preview requiere una key nueva.', 'CATALOG_PUBLICATION_NEW_PREVIEW_REQUIRED')
          }
          const startedAt = dependencies.now()
          if (batch.previewExpiresAt.getTime() <= startedAt.getTime()) stale('El preview expiró.')
          const attemptId = dependencies.randomAttemptId()
          const leaseExpiresAt = new Date(startedAt.getTime() + 120_000)
          const batchReserved = await tx.catalogPublicationBatch.updateMany({
            where: { id: batch.id, organizationId: context.organizationId, state: 'PREVIEWED' },
            data: { state: 'APPLYING', attemptId, leaseExpiresAt, heartbeatAt: startedAt },
          })
          const recordReserved = await tx.catalogIdempotencyRecord.updateMany({
            where: {
              organizationId: context.organizationId,
              operation: batch.operation,
              idempotencyKey: input.idempotencyKey,
              state: 'PREVIEWED',
            },
            data: { state: 'APPLYING', attemptId, leaseExpiresAt, heartbeatAt: startedAt },
          })
          if (batchReserved.count !== 1 || recordReserved.count !== 1) {
            throw new ConflictError('Otro confirm adquirió el preview.', 'CATALOG_PUBLICATION_IN_PROGRESS')
          }
          return { kind: 'reserved' as const, batch, attemptId, leaseExpiresAt }
        }, CATALOG_PUBLICATION_TRANSACTION_OPTIONS)
      const reservation = await retryCatalogPublicationReservationOnce(reserve)
      if (reservation.kind === 'done') return reservation.result

      return dependencies.prisma.$transaction(async tx => {
        await dependencies.acquireAttemptLockTx(tx, context.organizationId, reservation.batch.id)
        await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '5s'`)
        await tx.$executeRaw(Prisma.sql`SET LOCAL statement_timeout = '60s'`)
        const liveBatch = (await tx.catalogPublicationBatch.findFirst({
          where: {
            id: reservation.batch.id,
            organizationId: context.organizationId,
            state: 'APPLYING',
            attemptId: reservation.attemptId,
            leaseExpiresAt: reservation.leaseExpiresAt,
          },
        })) as BatchAuthority | null
        const liveRecord = await tx.catalogIdempotencyRecord.findFirst({
          where: {
            organizationId: context.organizationId,
            operation: reservation.batch.operation,
            idempotencyKey: input.idempotencyKey,
            state: 'APPLYING',
            attemptId: reservation.attemptId,
            leaseExpiresAt: reservation.leaseExpiresAt,
          },
        })
        if (!liveBatch || !liveRecord) throw new ConflictError('La reserva cambió.', 'CATALOG_PUBLICATION_STATE_CONFLICT')
        // WHY: Revalidate both durable copies after the attempt lock and before any Product write.
        assertDual(liveBatch, liveRecord as unknown as Record<string, unknown>, context)
        await dependencies.lockAuthoritiesTx(tx, context, liveBatch)
        await dependencies.assertAccessTx(tx, context)
        let resultLines: CatalogPublicationResultLine[]
        if (liveBatch.operation === 'CATALOG_PRODUCT_ACTIVATION') {
          const target = await activationAuthorityTx(tx, context, liveBatch)
          resultLines = [
            await dependencies.applyActivationTx(tx, {
              organizationId: context.organizationId,
              ...target,
              publicationBatchId: liveBatch.id,
              actor: context.actor,
            }),
          ]
        } else if (liveBatch.operation === 'CATALOG_FIELDS_REVERSION') {
          const authorities = await dependencies.revalidateReversionsTx(tx, context, liveBatch)
          resultLines = await dependencies.applyReversionsTx(tx, {
            organizationId: context.organizationId,
            publicationBatchId: liveBatch.id,
            actor: context.actor,
            authorities,
          })
        } else {
          const lines = await dependencies.revalidateTx(tx, context, liveBatch)
          resultLines = await dependencies.persistTx(tx, {
            organizationId: context.organizationId,
            staffId,
            lines,
          })
        }
        const result: CatalogPublicationResult = {
          publicationBatchId: liveBatch.id,
          operation: liveBatch.operation as CatalogPublicationOperation,
          state: 'APPLIED',
          lines: resultLines as CatalogPublicationResultLine[],
        }
        const durableResult = { schemaVersion: 1 as const, ...result }
        if (liveBatch.operation === 'CATALOG_FIELDS_PUBLISH')
          await dependencies.writeAudit(tx, {
            organizationId: context.organizationId,
            actor: context.actor,
            action: 'CATALOG_PUBLICATION_APPLIED',
            entity: 'CatalogPublicationBatch',
            entityId: liveBatch.id,
            batchId: liveBatch.id,
            idempotencyKeyHash: createHash('sha256').update(input.idempotencyKey, 'utf8').digest('hex'),
            metadata: { targetCount: resultLines.length },
          })
        if (liveBatch.operation === 'CATALOG_FIELDS_PUBLISH')
          await dependencies.enqueueOutboxTx(tx, {
            organizationId: context.organizationId,
            publicationBatchId: liveBatch.id,
            operation: liveBatch.operation,
            targets: resultLines.map(line => ({ venueId: line.venueId, productId: line.productId })),
          })
        const completedAt = dependencies.now()
        const batchApplied = await tx.catalogPublicationBatch.updateMany({
          where: {
            id: liveBatch.id,
            organizationId: context.organizationId,
            state: 'APPLYING',
            attemptId: reservation.attemptId,
            leaseExpiresAt: reservation.leaseExpiresAt,
          },
          data: {
            state: 'APPLIED',
            result: durableResult as unknown as Prisma.InputJsonValue,
            attemptId: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            appliedAt: completedAt,
            completedAt,
          },
        })
        const recordApplied = await tx.catalogIdempotencyRecord.updateMany({
          where: {
            organizationId: context.organizationId,
            operation: liveBatch.operation,
            idempotencyKey: input.idempotencyKey,
            state: 'APPLYING',
            attemptId: reservation.attemptId,
            leaseExpiresAt: reservation.leaseExpiresAt,
          },
          data: {
            state: 'APPLIED',
            result: durableResult as unknown as Prisma.InputJsonValue,
            attemptId: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            completedAt,
          },
        })
        if (batchApplied.count !== 1 || recordApplied.count !== 1) {
          throw new ConflictError('La confirmación perdió su CAS.', 'CATALOG_PUBLICATION_STATE_CONFLICT')
        }
        return result
      }, CATALOG_PUBLICATION_TRANSACTION_OPTIONS)
    },
  }
}

const service = createCatalogPublicationConfirmationService()

export async function confirmCatalogFieldsPublication(
  context: CatalogCommandContext,
  input: CatalogPublicationConfirmInput,
): Promise<CatalogPublicationResult | CatalogPublicationInProgress> {
  return service.confirm(context, input)
}
