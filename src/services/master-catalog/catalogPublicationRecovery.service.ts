import type { Prisma } from '@prisma/client'
import AppError, { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import type {
  CatalogPublicationInProgress,
  CatalogPublicationOperation,
  CatalogPublicationPreviewed,
  CatalogPublicationResult,
  CatalogPublicationResultLine,
  CatalogReadContext,
} from '../../types/master-catalog'
import { CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1, CATALOG_RETAIL_MANAGED_FIELD_MASK_V1 } from '../../types/master-catalog'
import { canonicalJsonV1 } from './catalogHash.service'
import { resolveMasterCatalogAccess } from './masterCatalogAccess.service'

const OPERATIONS: readonly CatalogPublicationOperation[] = [
  'CATALOG_FIELDS_PUBLISH',
  'CATALOG_FIELDS_REVERSION',
  'CATALOG_PRODUCT_ACTIVATION',
]
const SHA256_HEX = /^[0-9a-f]{64}$/
const MAX_RESULT_LINES = 10_000
const MANAGED_FIELDS = new Set<string>([...CATALOG_RETAIL_MANAGED_FIELD_MASK_V1, ...CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1])

interface RecoveryDependencies {
  prisma: typeof prisma
  assertAccess: (context: CatalogReadContext, db?: typeof prisma) => Promise<void>
  now: () => Date
}

interface DurableResultV1 {
  schemaVersion: 1
  publicationBatchId: string
  operation: CatalogPublicationOperation
  state: 'APPLIED'
  lines: CatalogPublicationResultLine[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function semanticId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
}

function validDependencies(value: unknown): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, ['schemaVersion', 'targets'])) return false
  if (value.schemaVersion !== 1 || !Array.isArray(value.targets) || value.targets.length === 0 || value.targets.length > MAX_RESULT_LINES) {
    return false
  }
  return value.targets.every(target => {
    if (!isPlainObject(target)) return false
    if (
      !hasExactKeys(target, [
        'catalogItemId',
        'venueId',
        'productId',
        'bindingId',
        'sourceCatalogRevision',
        'sourceCatalogInvariantVersion',
        'bindingRevision',
        'dependencies',
      ])
    ) {
      return false
    }
    return (
      [target.catalogItemId, target.venueId, target.productId, target.bindingId].every(semanticId) &&
      Number.isSafeInteger(target.sourceCatalogRevision) &&
      typeof target.sourceCatalogInvariantVersion === 'string' &&
      /^\d{1,20}$/u.test(target.sourceCatalogInvariantVersion) &&
      Number.isSafeInteger(target.bindingRevision) &&
      isPlainObject(target.dependencies)
    )
  })
}

function parseLine(value: unknown): CatalogPublicationResultLine | null {
  if (!isPlainObject(value)) return null
  if (!hasExactKeys(value, ['lineId', 'catalogItemId', 'venueId', 'productId', 'status'])) return null
  if (![value.lineId, value.catalogItemId, value.venueId, value.productId].every(semanticId)) return null
  if (value.status !== 'APPLIED' && value.status !== 'NO_CHANGE') return null
  return {
    lineId: value.lineId as string,
    catalogItemId: value.catalogItemId as string,
    venueId: value.venueId as string,
    productId: value.productId as string,
    status: value.status,
  }
}

function parseDurableResult(value: unknown, operation: CatalogPublicationOperation): DurableResultV1 | null {
  if (!isPlainObject(value)) return null
  if (!hasExactKeys(value, ['schemaVersion', 'publicationBatchId', 'operation', 'state', 'lines'])) return null
  if (
    value.schemaVersion !== 1 ||
    !semanticId(value.publicationBatchId) ||
    value.operation !== operation ||
    value.state !== 'APPLIED' ||
    !Array.isArray(value.lines) ||
    value.lines.length === 0 ||
    value.lines.length > MAX_RESULT_LINES
  ) {
    return null
  }
  const lines = value.lines.map(parseLine)
  if (lines.some(line => line === null)) return null
  const typedLines = lines as CatalogPublicationResultLine[]
  if (new Set(typedLines.map(line => line.lineId)).size !== typedLines.length) return null
  return {
    schemaVersion: 1,
    publicationBatchId: value.publicationBatchId,
    operation,
    state: 'APPLIED',
    lines: typedLines,
  }
}

function invalidResult(): never {
  throw new ConflictError('El resultado durable de publicación es inválido.', 'CATALOG_PUBLICATION_RESULT_INVALID')
}

function validRelationalLine(operation: CatalogPublicationOperation, line: Record<string, unknown>): boolean {
  const fieldMask = line.fieldMask
  if (
    line.hashVersion !== 1 ||
    line.decisionSchemaVersion !== 1 ||
    !Array.isArray(fieldMask) ||
    fieldMask.length === 0 ||
    new Set(fieldMask).size !== fieldMask.length ||
    !Array.isArray(line.decisions)
  )
    return false
  const decisions = line.decisions as Array<Record<string, unknown>>
  if (
    decisions.length !== fieldMask.length ||
    new Set(decisions.map(decision => decision.field)).size !== decisions.length ||
    decisions.some(decision => !fieldMask.includes(decision.field) || decision.decision === 'UNDECIDED')
  )
    return false
  if (operation === 'CATALOG_PRODUCT_ACTIVATION') {
    const decision = decisions[0]
    return (
      line.status === 'APPLIED' &&
      line.changeKind === 'PUBLICATION' &&
      canonicalJsonV1(fieldMask) === canonicalJsonV1(['active']) &&
      canonicalJsonV1(line.before) === canonicalJsonV1({ active: false }) &&
      canonicalJsonV1(line.after) === canonicalJsonV1({ active: true }) &&
      line.supersedesLineId === null &&
      line.reversesLineId === null &&
      decision.field === 'active' &&
      decision.decision === 'PUBLISH_CORPORATE' &&
      decision.before === false &&
      decision.proposed === true &&
      decision.after === true &&
      decision.overrideId === null
    )
  }
  if (fieldMask.some((field: unknown) => typeof field !== 'string' || !MANAGED_FIELDS.has(field))) return false
  const before = Object.fromEntries(decisions.map(decision => [decision.field as string, decision.before]))
  const after = Object.fromEntries(decisions.map(decision => [decision.field as string, decision.after]))
  if (canonicalJsonV1(line.before) !== canonicalJsonV1(before) || canonicalJsonV1(line.after) !== canonicalJsonV1(after)) return false
  if (operation === 'CATALOG_FIELDS_REVERSION') {
    return (
      line.status === 'APPLIED' &&
      line.changeKind === 'REVERSION' &&
      semanticId(line.supersedesLineId) &&
      semanticId(line.reversesLineId) &&
      decisions.every(decision => decision.decision === 'PUBLISH_CORPORATE' && decision.overrideId === null)
    )
  }
  return (
    line.changeKind === 'PUBLICATION' &&
    line.reversesLineId === null &&
    (line.supersedesLineId === null || semanticId(line.supersedesLineId))
  )
}

export async function validateCatalogPublicationAppliedResultTx(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    publicationBatchId: string
    operation: CatalogPublicationOperation
    recordResult: unknown
    batchResult: unknown
  },
): Promise<CatalogPublicationResult> {
  const recordResult = parseDurableResult(input.recordResult, input.operation)
  const batchResult = parseDurableResult(input.batchResult, input.operation)
  if (
    !recordResult ||
    !batchResult ||
    recordResult.publicationBatchId !== input.publicationBatchId ||
    canonicalJsonV1(recordResult) !== canonicalJsonV1(batchResult)
  )
    invalidResult()
  const relationalLines = await tx.catalogPublicationLine.findMany({
    // WHY: Confirmation replay and recovery share this relational authority;
    // a matching pair of forged JSON envelopes can never invent an APPLIED line.
    where: { batchId: input.publicationBatchId, organizationId: input.organizationId },
    select: {
      id: true,
      organizationId: true,
      batchId: true,
      bindingId: true,
      catalogItemId: true,
      venueId: true,
      productId: true,
      status: true,
      fieldMask: true,
      decisionSchemaVersion: true,
      changeKind: true,
      hashVersion: true,
      before: true,
      after: true,
      supersedesLineId: true,
      reversesLineId: true,
      decisions: {
        select: { field: true, decision: true, before: true, proposed: true, after: true, overrideId: true },
        orderBy: { field: 'asc' },
      },
    },
    orderBy: { id: 'asc' },
    take: MAX_RESULT_LINES + 1,
  })
  if (
    relationalLines.length !== recordResult.lines.length ||
    relationalLines.some(
      line =>
        (line.status !== 'APPLIED' && line.status !== 'NO_CHANGE') ||
        !validRelationalLine(input.operation, line as unknown as Record<string, unknown>),
    )
  )
    invalidResult()
  const relational = relationalLines.map(line => ({
    lineId: line.id,
    catalogItemId: line.catalogItemId,
    venueId: line.venueId,
    productId: line.productId,
    status: line.status as 'APPLIED' | 'NO_CHANGE',
  }))
  const durableLines = [...recordResult.lines].sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0))
  if (canonicalJsonV1(durableLines) !== canonicalJsonV1(relational)) invalidResult()
  return {
    publicationBatchId: input.publicationBatchId,
    operation: input.operation,
    state: 'APPLIED',
    lines: recordResult.lines,
  }
}

function sameNullableDate(left: unknown, right: unknown): boolean {
  if (left === null && right === null) return true
  return left instanceof Date && right instanceof Date && left.getTime() === right.getTime()
}

function boundedFailure(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1_024
}

function validStateShape(record: Record<string, unknown>, batch: Record<string, unknown>): boolean {
  if (
    !sameNullableDate(record.leaseExpiresAt, batch.leaseExpiresAt) ||
    !sameNullableDate(record.heartbeatAt, batch.heartbeatAt) ||
    !sameNullableDate(record.completedAt, batch.completedAt) ||
    record.failureCode !== batch.failureCode ||
    record.failureMessage !== batch.failureMessage
  )
    return false
  const noAttempt =
    record.attemptId === null &&
    batch.attemptId === null &&
    record.leaseExpiresAt === null &&
    batch.leaseExpiresAt === null &&
    record.heartbeatAt === null &&
    batch.heartbeatAt === null
  const noFailure =
    record.failureCode === null && batch.failureCode === null && record.failureMessage === null && batch.failureMessage === null
  if (record.state === 'PREVIEWED') {
    return (
      noAttempt &&
      noFailure &&
      record.result === null &&
      batch.result === null &&
      record.completedAt === null &&
      batch.completedAt === null &&
      batch.appliedAt === null
    )
  }
  if (record.state === 'APPLYING') {
    return (
      semanticId(record.attemptId) &&
      record.attemptId === batch.attemptId &&
      record.leaseExpiresAt instanceof Date &&
      record.heartbeatAt instanceof Date &&
      record.leaseExpiresAt.getTime() > record.heartbeatAt.getTime() &&
      noFailure &&
      record.result === null &&
      batch.result === null &&
      record.completedAt === null &&
      batch.completedAt === null &&
      batch.appliedAt === null
    )
  }
  if (record.state === 'APPLIED') {
    return (
      noAttempt &&
      noFailure &&
      record.result !== null &&
      batch.result !== null &&
      record.completedAt instanceof Date &&
      batch.completedAt instanceof Date &&
      batch.appliedAt instanceof Date &&
      batch.appliedAt.getTime() === batch.completedAt.getTime()
    )
  }
  if (record.state === 'FAILED') {
    return (
      noAttempt &&
      record.result === null &&
      batch.result === null &&
      boundedFailure(record.failureCode) &&
      boundedFailure(record.failureMessage) &&
      record.completedAt instanceof Date &&
      batch.completedAt instanceof Date &&
      batch.appliedAt === null
    )
  }
  if (record.state === 'EXPIRED' || record.state === 'SUPERSEDED') {
    return (
      noAttempt &&
      noFailure &&
      record.result === null &&
      batch.result === null &&
      record.completedAt instanceof Date &&
      batch.completedAt instanceof Date &&
      batch.appliedAt === null
    )
  }
  return false
}

async function defaultAssertAccess(context: CatalogReadContext, db: typeof prisma = prisma): Promise<void> {
  if (context.actor.type !== 'HUMAN' || context.actor.impersonating) {
    throw new ForbiddenError('La recuperación requiere OWNER/ADMIN humano no suplantado')
  }
  const access = await resolveMasterCatalogAccess({
    organizationId: context.organizationId,
    principal: context.actor,
    capability: 'MUTATE_CONTENT',
    requiredGate: 'CORE',
    prisma: db,
  })
  if (access.reasonCode === 'DEPENDENCY_UNAVAILABLE') {
    // WHY: Recovery is an authenticated read of mutation authority; a provider
    // outage remains 503 so callers retry rather than treating access as lost.
    throw new ServiceUnavailableError('No fue posible revalidar Catalog Core', 'DEPENDENCY_UNAVAILABLE')
  }
  if (!access.canMutateContent) throw new ForbiddenError('No puedes recuperar esta publicación')
}

const defaults: RecoveryDependencies = { prisma, assertAccess: defaultAssertAccess, now: () => new Date() }

export function createCatalogPublicationRecoveryService(overrides: Partial<RecoveryDependencies> = {}) {
  const dependencies = { ...defaults, ...overrides }
  return {
    async getByIdempotencyKey(
      context: CatalogReadContext,
      input: { operation: CatalogPublicationOperation; idempotencyKey: string },
    ): Promise<CatalogPublicationResult | CatalogPublicationInProgress | CatalogPublicationPreviewed> {
      const runtimeInput = input as unknown
      if (!isPlainObject(runtimeInput) || !hasExactKeys(runtimeInput, ['operation', 'idempotencyKey'])) {
        throw new AppError('La forma de recuperación es inválida', 422, true, 'CATALOG_PUBLICATION_INPUT_INVALID')
      }
      // WHY: Operation validation precedes access and resource lookup so an
      // unknown route cannot collide with a known idempotency namespace.
      if (!OPERATIONS.includes(runtimeInput.operation as CatalogPublicationOperation)) {
        throw new AppError('Operación de publicación no soportada', 422, true, 'CATALOG_PUBLICATION_OPERATION_UNSUPPORTED')
      }
      if (!semanticId(runtimeInput.idempotencyKey)) {
        throw new AppError('idempotencyKey de publicación inválida', 422, true, 'CATALOG_PUBLICATION_INPUT_INVALID')
      }
      await dependencies.assertAccess(context, dependencies.prisma)
      const record = await dependencies.prisma.catalogIdempotencyRecord.findUnique({
        where: {
          organizationId_operation_idempotencyKey: {
            organizationId: context.organizationId,
            operation: input.operation,
            idempotencyKey: input.idempotencyKey,
          },
        },
      })
      if (!record) throw new NotFoundError('Publicación no encontrada')
      if (record.resourceType !== 'CatalogPublicationBatch' || !semanticId(record.resourceId)) invalidResult()
      const batch = await dependencies.prisma.catalogPublicationBatch.findFirst({
        where: { id: record.resourceId, organizationId: context.organizationId, operation: input.operation },
      })
      if (!batch) invalidResult()

      // WHY: Recovery trusts neither JSON copy independently; relational
      // resource linkage, operation, actor, hashes, state and attempt must agree.
      if (
        batch.id !== record.resourceId ||
        batch.organizationId !== record.organizationId ||
        batch.operation !== record.operation ||
        batch.schemaVersion !== 1 ||
        batch.requestHash !== record.requestHash ||
        batch.requestHashVersion !== 1 ||
        record.requestHashVersion !== 1 ||
        !SHA256_HEX.test(batch.requestHash) ||
        batch.targetHash !== record.targetHash ||
        !SHA256_HEX.test(batch.targetHash) ||
        batch.previewTokenHash !== record.previewTokenHash ||
        !SHA256_HEX.test(batch.previewTokenHash) ||
        !(batch.previewExpiresAt instanceof Date) ||
        !(record.previewExpiresAt instanceof Date) ||
        batch.previewExpiresAt.getTime() !== record.previewExpiresAt.getTime() ||
        !validDependencies(batch.dependencies) ||
        !validDependencies(record.dependencies) ||
        canonicalJsonV1(batch.dependencies) !== canonicalJsonV1(record.dependencies) ||
        batch.state !== record.state ||
        batch.attemptId !== record.attemptId ||
        batch.actorType !== record.actorType ||
        batch.staffId !== record.staffId ||
        batch.servicePrincipalId !== record.servicePrincipalId ||
        record.actorType !== 'HUMAN' ||
        context.actor.type !== 'HUMAN' ||
        record.staffId !== context.actor.staffId ||
        record.servicePrincipalId !== null ||
        !validStateShape(record as unknown as Record<string, unknown>, batch as unknown as Record<string, unknown>)
      ) {
        invalidResult()
      }

      if (record.state === 'PREVIEWED') {
        if (record.result !== null || batch.result !== null || record.attemptId !== null || batch.attemptId !== null) invalidResult()
        return {
          publicationBatchId: batch.id,
          operation: input.operation,
          state: 'PREVIEWED',
          expiresAt: record.previewExpiresAt.toISOString(),
        }
      }
      if (record.state === 'APPLYING') {
        if (record.result !== null || batch.result !== null) invalidResult()
        const retryAfterSeconds = Math.max(
          0,
          Math.min(
            60,
            Math.ceil(((record.leaseExpiresAt?.getTime() ?? dependencies.now().getTime()) - dependencies.now().getTime()) / 1_000),
          ),
        )
        return { publicationBatchId: batch.id, operation: input.operation, state: 'IN_PROGRESS', retryAfterSeconds }
      }
      if (record.state === 'FAILED' || record.state === 'EXPIRED' || record.state === 'SUPERSEDED') {
        throw new ConflictError('La publicación requiere un preview y una key nuevos.', 'CATALOG_PUBLICATION_NEW_PREVIEW_REQUIRED')
      }
      if (record.state !== 'APPLIED' || batch.state !== 'APPLIED') invalidResult()
      return validateCatalogPublicationAppliedResultTx(dependencies.prisma, {
        organizationId: context.organizationId,
        publicationBatchId: batch.id,
        operation: input.operation,
        recordResult: record.result,
        batchResult: batch.result,
      })
    },
  }
}

const service = createCatalogPublicationRecoveryService()

export async function getCatalogPublicationByIdempotencyKey(
  context: CatalogReadContext,
  input: { operation: CatalogPublicationOperation; idempotencyKey: string },
): Promise<CatalogPublicationResult | CatalogPublicationInProgress | CatalogPublicationPreviewed> {
  return service.getByIdempotencyKey(context, input)
}
