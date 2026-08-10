import { ActivityActorType, CatalogItemKind, CatalogOperationState, CatalogVenueBindingStatus, Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { createHash, timingSafeEqual } from 'node:crypto'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError'
import type {
  CatalogBindingConfirmInput,
  CatalogBindingDecisionInput,
  CatalogBindingPreviewInput,
  CatalogBindingResult,
  CatalogBindingResultLine,
  CatalogCommandContext,
  PreparedDishReadiness,
} from '../../types/master-catalog'
import type { writeCatalogAudit } from './catalogAudit.service'
import { evaluateCatalogBindingTargetTx, type EvaluatedBindingLine } from './catalogBindingPreview.service'
import { createPrivateCatalogProductTx, managedFieldMaskForCatalogKind } from './catalogBindingProductWriter.service'
import { parseCatalogBindingDependencyAuthorityV1 } from './catalogBindingRecoverySchema.service'
import {
  isCatalogBindingDomainWriteConflict,
  isCatalogBindingIdempotencyUniqueConflict,
  isCatalogBindingPreviewSnapshotConstraint,
  isCatalogBindingSerializationConflict,
  recoverCatalogBindingAppliedTx,
} from './catalogBindingRecovery.service'
import { canonicalJsonV1, hashCanonicalJsonV1 } from './catalogHash.service'
import type { acquireCatalogMutationLock } from './catalogMutationLock.service'
import type { evaluatePreparedDishBinding } from './catalogRecipeCost.service'

const OPERATION = 'CATALOG_BINDING'
const MAX_LINES = 100
const ID_MAX = 200
const TOKEN_MAX = 512
const CONFIRM_LEASE_MS = 60_000
const TRANSACTION_OPTIONS = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 30_000 } as const

type CatalogBindingTransaction = Prisma.TransactionClient

export interface CatalogBindingConfirmationDependencies {
  prisma: Pick<PrismaClient, '$transaction' | 'catalogIdempotencyRecord'>
  assertLiveAccessTx(tx: CatalogBindingTransaction, context: CatalogCommandContext): Promise<void>
  acquireMutationLockTx: typeof acquireCatalogMutationLock
  writeCatalogAudit: typeof writeCatalogAudit
  evaluatePreparedDishBinding: typeof evaluatePreparedDishBinding
  now(): Date
  randomAttemptId(): string
}

interface StoredBindingBatch {
  id: string
  organizationId: string
  state: CatalogOperationState
  schemaVersion: number
  requestHash: string
  requestHashVersion: number
  targetHash: string
  previewTokenHash: string
  previewExpiresAt: Date
  dependencies: Prisma.JsonValue
  actorType: ActivityActorType
  staffId: string | null
  result: Prisma.JsonValue | null
  createdAt: Date
  updatedAt: Date
}

interface StoredBindingLine {
  id: string
  catalogItemId: string
  venueId: string
  productId: string | null
  status: string
  proposal: string
  decision: string | null
  after: Prisma.JsonValue | null
}

interface BindingAuthority {
  input: CatalogBindingPreviewInput
  lines: StoredBindingLine[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function validateConfirmInput(input: CatalogBindingConfirmInput): void {
  if (!isRecord(input) || !hasExactKeys(input, ['bindingBatchId', 'previewToken', 'confirm', 'idempotencyKey'])) {
    throw new ValidationError('Confirmación de binding inválida')
  }
  if (input.confirm !== true) throw new ValidationError('confirm debe ser true')
  if (typeof input.bindingBatchId !== 'string' || !/\S/u.test(input.bindingBatchId) || input.bindingBatchId.length > ID_MAX) {
    throw new ValidationError('bindingBatchId inválido')
  }
  if (typeof input.previewToken !== 'string' || input.previewToken.length < 1 || input.previewToken.length > TOKEN_MAX) {
    throw new ValidationError('previewToken inválido')
  }
  if (typeof input.idempotencyKey !== 'string' || !/\S/u.test(input.idempotencyKey) || input.idempotencyKey.length > ID_MAX) {
    throw new ValidationError('idempotencyKey inválido')
  }
}

function tokenMatches(raw: string, digest: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(digest)) return false
  return timingSafeEqual(createHash('sha256').update(raw).digest(), Buffer.from(digest, 'hex'))
}

async function readBatchTx(tx: CatalogBindingTransaction, organizationId: string, batchId: string): Promise<StoredBindingBatch | null> {
  return tx.catalogBindingBatch.findFirst({ where: { id: batchId, organizationId } }) as unknown as Promise<StoredBindingBatch | null>
}

async function readLinesTx(tx: CatalogBindingTransaction, organizationId: string, batchId: string): Promise<StoredBindingLine[]> {
  const lines = (await tx.catalogBindingLine.findMany({
    where: { batchId, organizationId },
    orderBy: { id: 'asc' },
    take: MAX_LINES + 1,
  })) as unknown as StoredBindingLine[]
  if (!lines.length || lines.length > MAX_LINES) throw new ConflictError('Líneas de binding inválidas', 'CATALOG_BINDING_STAGING_INVALID')
  return lines
}

function assertBatchCaller(batch: StoredBindingBatch, context: CatalogCommandContext, input: CatalogBindingConfirmInput): void {
  if (context.actor.type !== 'HUMAN' || batch.actorType !== ActivityActorType.HUMAN || batch.staffId !== context.actor.staffId) {
    throw new ForbiddenError('El actor no coincide con el preview', 'CATALOG_BINDING_ACTOR_MISMATCH')
  }
  if (!tokenMatches(input.previewToken, batch.previewTokenHash)) {
    throw new ForbiddenError('Preview token inválido', 'CATALOG_BINDING_PREVIEW_TOKEN_INVALID')
  }
}

function assertSupportedBatchVersion(batch: StoredBindingBatch): void {
  if (batch.schemaVersion !== 1 || batch.requestHashVersion !== 1) {
    throw new ConflictError('Versión de staging de binding no soportada', 'CATALOG_BINDING_STAGING_INVALID')
  }
}

function parseAuthority(batch: StoredBindingBatch, lines: StoredBindingLine[], organizationId: string): BindingAuthority {
  if (
    !isRecord(batch.dependencies) ||
    !hasExactKeys(batch.dependencies, ['schemaVersion', 'lines']) ||
    batch.dependencies.schemaVersion !== 1
  ) {
    throw new ConflictError('Snapshot de binding inválido', 'CATALOG_BINDING_STAGING_INVALID')
  }
  const dependencies = batch.dependencies.lines
  if (!Array.isArray(dependencies) || dependencies.length !== lines.length || dependencies.length > MAX_LINES) {
    throw new ConflictError('Snapshot de binding inválido', 'CATALOG_BINDING_STAGING_INVALID')
  }
  if (hashCanonicalJsonV1('catalog-binding-target', dependencies) !== batch.targetHash) {
    throw new ConflictError('El snapshot de binding cambió', 'CATALOG_BINDING_STAGING_HASH_MISMATCH')
  }
  const byTarget = new Map(lines.map(line => [`${line.catalogItemId}\u0000${line.venueId}`, line] as const))
  if (byTarget.size !== lines.length) throw new ConflictError('Líneas de binding duplicadas', 'CATALOG_BINDING_STAGING_INVALID')

  const orderedLines: StoredBindingLine[] = []
  const inputLines = dependencies.map(dependency => {
    const parsed = parseCatalogBindingDependencyAuthorityV1(dependency, organizationId)
    if (!parsed) throw new ConflictError('Decisión durable inválida', 'CATALOG_BINDING_STAGING_INVALID')
    const { catalogItemId, venueId, decision } = parsed
    const line = byTarget.get(`${catalogItemId}\u0000${venueId}`)
    const selectedProductId = decision.decision === 'LINK' && typeof decision.productId === 'string' ? decision.productId : null
    if (
      !line ||
      line.status !== 'READY' ||
      line.proposal !== decision.decision ||
      line.decision !== decision.decision ||
      line.productId !== selectedProductId ||
      canonicalJsonV1(line.after) !== canonicalJsonV1(decision)
    ) {
      throw new ConflictError('La línea durable no coincide con el preview', 'CATALOG_BINDING_STAGING_INVALID')
    }
    orderedLines.push(line)
    return { catalogItemId, venueId, decision: decision as unknown as CatalogBindingDecisionInput }
  })
  return { input: { lines: inputLines }, lines: orderedLines }
}

async function applyLineTx(
  tx: CatalogBindingTransaction,
  dependencies: CatalogBindingConfirmationDependencies,
  context: CatalogCommandContext & { actor: { type: 'HUMAN'; staffId: string; impersonating: false } },
  durable: StoredBindingLine,
  evaluated: EvaluatedBindingLine,
): Promise<CatalogBindingResultLine> {
  const decision = evaluated.publicLine.decision as CatalogBindingDecisionInput
  if (decision.decision === 'SKIP') {
    const skipped = await tx.catalogBindingLine.updateMany({
      where: { id: durable.id, organizationId: context.organizationId, status: 'READY' },
      data: { status: 'SKIPPED', productId: null, after: { decision: 'SKIP', status: 'SKIPPED' } },
    })
    if (skipped.count !== 1) throw new ConflictError('La línea cambió', 'CATALOG_BINDING_STATE_CONFLICT')
    return {
      catalogItemId: durable.catalogItemId,
      venueId: durable.venueId,
      decision: 'SKIP',
      status: 'SKIPPED',
      productId: null,
      bindingId: null,
      readiness: null,
    }
  }

  const item = evaluated.application.item
  const mask = managedFieldMaskForCatalogKind(item.kind)
  let product: { id: string; updatedAt: Date }
  let published: { revision: number | null; snapshot?: Prisma.InputJsonObject; hashVersion: number | null; hash: string | null }
  if (decision.decision === 'LINK') {
    if (!evaluated.application.selectedProduct) throw new ConflictError('Candidato no disponible', 'CATALOG_BINDING_STALE')
    // WHY: LINK writes provenance only. The operational Product and all of its
    // lifecycle fields remain untouched, including an explicit inactive state.
    product = evaluated.application.selectedProduct
    published = { revision: null, hashVersion: null, hash: null }
  } else {
    const created = await createPrivateCatalogProductTx(tx, {
      staffId: context.actor.staffId,
      venueId: durable.venueId,
      decision,
      evaluated,
    })
    product = created.product
    published = created.published
  }

  const binding = await tx.catalogVenueBinding.create({
    data: {
      organizationId: context.organizationId,
      catalogItemId: durable.catalogItemId,
      venueId: durable.venueId,
      productId: product.id,
      status: CatalogVenueBindingStatus.LINKED,
      lastPublishedCatalogRevision: published.revision,
      ...(published.snapshot ? { lastPublishedManagedSnapshot: published.snapshot } : {}),
      managedFieldMask: [...mask],
      managedHashVersion: published.hashVersion,
      lastPublishedManagedHash: published.hash,
      productUpdatedAtObserved: product.updatedAt,
      createdById: context.actor.staffId,
      updatedById: context.actor.staffId,
    },
    select: { id: true, revision: true },
  })
  // WHY: Task 6 requires persisted LINKED provenance. Evaluating inside this
  // transaction observes the new binding and any failure rolls back its Product.
  const readiness: PreparedDishReadiness | null =
    item.kind === CatalogItemKind.PREPARED_DISH
      ? await dependencies.evaluatePreparedDishBinding(tx, {
          organizationId: context.organizationId,
          venueId: durable.venueId,
          productId: product.id,
        })
      : null
  const applied = await tx.catalogBindingLine.updateMany({
    where: { id: durable.id, organizationId: context.organizationId, status: 'READY' },
    data: { status: 'APPLIED', productId: product.id, after: { bindingId: binding.id, productId: product.id } },
  })
  if (applied.count !== 1) throw new ConflictError('La línea cambió', 'CATALOG_BINDING_STATE_CONFLICT')
  return {
    catalogItemId: durable.catalogItemId,
    venueId: durable.venueId,
    decision: decision.decision,
    status: 'APPLIED',
    productId: product.id,
    bindingId: binding.id,
    readiness,
  }
}

export async function confirmCatalogBindingsWithDependencies(
  dependencies: CatalogBindingConfirmationDependencies,
  context: CatalogCommandContext,
  input: CatalogBindingConfirmInput,
): Promise<CatalogBindingResult> {
  validateConfirmInput(input)
  if (context.actor.type !== 'HUMAN' || context.actor.impersonating) throw new ForbiddenError('Binding requiere actor humano')
  const humanActor = context.actor
  const humanContext = context as CatalogCommandContext & { actor: { type: 'HUMAN'; staffId: string; impersonating: false } }
  let requestHash: string | null = null
  try {
    return await dependencies.prisma.$transaction(async tx => {
      await dependencies.assertLiveAccessTx(tx, context)
      const batch = await readBatchTx(tx, context.organizationId, input.bindingBatchId)
      if (!batch) throw new NotFoundError('Preview de binding no encontrado')
      requestHash = batch.requestHash
      assertBatchCaller(batch, context, input)
      assertSupportedBatchVersion(batch)
      if (batch.state === CatalogOperationState.APPLIED) return recoverCatalogBindingAppliedTx(tx, context, input, batch.requestHash)
      if (batch.state !== CatalogOperationState.PREVIEWED) throw new ConflictError('Preview no confirmable', 'CATALOG_BINDING_IN_PROGRESS')
      if (batch.previewExpiresAt.getTime() <= dependencies.now().getTime())
        throw new ConflictError('Preview expirado', 'CATALOG_BINDING_PREVIEW_EXPIRED')

      await dependencies.acquireMutationLockTx(tx, context.organizationId)
      await dependencies.assertLiveAccessTx(tx, context)
      const locked = await readBatchTx(tx, context.organizationId, input.bindingBatchId)
      if (!locked) throw new NotFoundError('Preview de binding no encontrado')
      assertBatchCaller(locked, context, input)
      assertSupportedBatchVersion(locked)
      if (locked.state === CatalogOperationState.APPLIED) return recoverCatalogBindingAppliedTx(tx, context, input, batch.requestHash)
      if (
        locked.state !== CatalogOperationState.PREVIEWED ||
        locked.requestHash !== batch.requestHash ||
        locked.targetHash !== batch.targetHash ||
        locked.createdAt.getTime() !== batch.createdAt.getTime() ||
        locked.updatedAt.getTime() !== batch.updatedAt.getTime() ||
        canonicalJsonV1(locked.dependencies) !== canonicalJsonV1(batch.dependencies)
      ) {
        throw new ConflictError('La autoridad del preview cambió', 'CATALOG_BINDING_STALE')
      }
      const attemptStartedAt = dependencies.now()
      if (locked.previewExpiresAt.getTime() <= attemptStartedAt.getTime())
        throw new ConflictError('Preview expirado', 'CATALOG_BINDING_PREVIEW_EXPIRED')
      const authority = parseAuthority(locked, await readLinesTx(tx, context.organizationId, locked.id), context.organizationId)
      const evaluated = await evaluateCatalogBindingTargetTx(tx, context.organizationId, authority.input)
      if (evaluated.targetHash !== locked.targetHash || evaluated.lines.some(line => line.publicLine.status !== 'READY')) {
        throw new ConflictError('Las dependencias cambiaron después del preview', 'CATALOG_BINDING_STALE')
      }
      const expectedRequestHash = hashCanonicalJsonV1('catalog-binding-request', {
        organizationId: context.organizationId,
        staffId: humanActor.staffId,
        targetHash: locked.targetHash,
      })
      if (locked.requestHash !== expectedRequestHash) throw new ConflictError('Request hash inválido', 'CATALOG_BINDING_STAGING_INVALID')

      const attemptId = dependencies.randomAttemptId()
      const leaseExpiresAt = new Date(attemptStartedAt.getTime() + CONFIRM_LEASE_MS)
      await tx.catalogIdempotencyRecord.create({
        data: {
          organizationId: context.organizationId,
          operation: OPERATION,
          idempotencyKey: input.idempotencyKey,
          requestHash: locked.requestHash,
          requestHashVersion: 1,
          state: CatalogOperationState.APPLYING,
          resourceType: 'CatalogBindingBatch',
          resourceId: locked.id,
          targetHash: locked.targetHash,
          previewTokenHash: locked.previewTokenHash,
          previewExpiresAt: locked.previewExpiresAt,
          dependencies: locked.dependencies as Prisma.InputJsonValue,
          actorType: ActivityActorType.HUMAN,
          staffId: humanActor.staffId,
          attemptId,
          leaseExpiresAt,
          heartbeatAt: attemptStartedAt,
          createdAt: attemptStartedAt,
        },
      })
      const acquired = await tx.catalogBindingBatch.updateMany({
        where: { id: locked.id, organizationId: context.organizationId, state: CatalogOperationState.PREVIEWED },
        data: { state: CatalogOperationState.APPLYING, attemptId, leaseExpiresAt, heartbeatAt: attemptStartedAt },
      })
      if (acquired.count !== 1) throw new ConflictError('Otro confirm adquirió el preview', 'CATALOG_BINDING_IN_PROGRESS')

      const resultLines: CatalogBindingResultLine[] = []
      for (let index = 0; index < evaluated.lines.length; index += 1) {
        resultLines.push(
          await applyLineTx(
            tx,
            dependencies,
            humanContext,
            authority.lines[index] as StoredBindingLine,
            evaluated.lines[index] as EvaluatedBindingLine,
          ),
        )
      }
      const result: CatalogBindingResult = { bindingBatchId: locked.id, state: 'APPLIED', lines: resultLines }
      await dependencies.writeCatalogAudit(tx, {
        organizationId: context.organizationId,
        actor: humanActor,
        action: 'CATALOG_BINDING_APPLIED',
        entity: 'CatalogBindingBatch',
        entityId: locked.id,
        batchId: locked.id,
        idempotencyKeyHash: createHash('sha256').update(input.idempotencyKey).digest('hex'),
        metadata: {
          appliedCount: resultLines.filter(line => line.status === 'APPLIED').length,
          skippedCount: resultLines.filter(line => line.status === 'SKIPPED').length,
          createdCount: resultLines.filter(line => line.decision === 'CREATE').length,
          linkedCount: resultLines.filter(line => line.decision === 'LINK').length,
        },
      })
      const completedAt = dependencies.now()
      const batchApplied = await tx.catalogBindingBatch.updateMany({
        where: { id: locked.id, organizationId: context.organizationId, state: CatalogOperationState.APPLYING, attemptId },
        data: {
          state: CatalogOperationState.APPLIED,
          result: result as unknown as Prisma.InputJsonValue,
          attemptId: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          appliedAt: completedAt,
          completedAt,
        },
      })
      const idempotencyApplied = await tx.catalogIdempotencyRecord.updateMany({
        where: {
          organizationId: context.organizationId,
          operation: OPERATION,
          idempotencyKey: input.idempotencyKey,
          state: CatalogOperationState.APPLYING,
          attemptId,
        },
        data: {
          state: CatalogOperationState.APPLIED,
          result: result as unknown as Prisma.InputJsonValue,
          attemptId: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          completedAt,
        },
      })
      if (batchApplied.count !== 1 || idempotencyApplied.count !== 1)
        throw new ConflictError('La confirmación cambió', 'CATALOG_BINDING_STATE_CONFLICT')
      return result
    }, TRANSACTION_OPTIONS)
  } catch (error) {
    if (isCatalogBindingPreviewSnapshotConstraint(error)) {
      throw new ConflictError('Preview expirado', 'CATALOG_BINDING_PREVIEW_EXPIRED')
    }
    if (isCatalogBindingIdempotencyUniqueConflict(error)) {
      return dependencies.prisma.$transaction(async tx => {
        await dependencies.assertLiveAccessTx(tx, context)
        const winner = await readBatchTx(tx, context.organizationId, input.bindingBatchId)
        if (!winner) throw new NotFoundError('Preview de binding no encontrado')
        assertBatchCaller(winner, context, input)
        const record = await tx.catalogIdempotencyRecord.findFirst({
          where: { organizationId: context.organizationId, operation: OPERATION, idempotencyKey: input.idempotencyKey },
        })
        const expectedRequestHash = requestHash ?? winner.requestHash
        if (
          record &&
          (record.resourceType !== 'CatalogBindingBatch' || record.resourceId !== winner.id || record.requestHash !== expectedRequestHash)
        ) {
          throw new ConflictError('La llave de idempotencia ya pertenece a otro batch.', 'IDEMPOTENCY_KEY_REUSED')
        }
        if (winner.state !== CatalogOperationState.APPLIED) {
          throw new ConflictError('Conflicto concurrente de binding', 'CATALOG_BINDING_CONCURRENT_CHANGE')
        }
        return recoverCatalogBindingAppliedTx(tx, context, input, expectedRequestHash)
      }, TRANSACTION_OPTIONS)
    }
    if (isCatalogBindingSerializationConflict(error)) {
      return dependencies.prisma.$transaction(async tx => {
        await dependencies.assertLiveAccessTx(tx, context)
        const winner = await readBatchTx(tx, context.organizationId, input.bindingBatchId)
        if (!winner) throw new NotFoundError('Preview de binding no encontrado')
        assertBatchCaller(winner, context, input)
        if (winner.state !== CatalogOperationState.APPLIED) {
          throw new ConflictError('Conflicto concurrente de binding', 'CATALOG_BINDING_CONCURRENT_CHANGE')
        }
        return recoverCatalogBindingAppliedTx(tx, context, input, requestHash ?? winner.requestHash)
      }, TRANSACTION_OPTIONS)
    }
    if (isCatalogBindingDomainWriteConflict(error)) {
      throw new ConflictError('Conflicto concurrente de binding', 'CATALOG_BINDING_CONCURRENT_CHANGE')
    }
    throw error
  }
}
