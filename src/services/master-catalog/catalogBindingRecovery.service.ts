import { ActivityActorType, CatalogOperationState, CatalogVenueBindingStatus, Prisma } from '@prisma/client'
import { createHash, timingSafeEqual } from 'node:crypto'
import { ConflictError, NotFoundError } from '../../errors/AppError'
import type {
  CatalogBindingConfirmInput,
  CatalogBindingResult,
  CatalogBindingResultLine,
  CatalogCommandContext,
} from '../../types/master-catalog'
import {
  isCatalogBindingRecoveredReadinessV1,
  parseCatalogBindingDependencyAuthorityV1,
  type CatalogBindingDependencyAuthorityV1,
} from './catalogBindingRecoverySchema.service'
import { canonicalJsonV1, hashCanonicalJsonV1 } from './catalogHash.service'

const OPERATION = 'CATALOG_BINDING'
const MAX_LINES = 100
const IDEMPOTENCY_CONSTRAINT = 'CatalogIdempotencyRecord_organizationId_operation_idemp_key'
const IDEMPOTENCY_FIELDS = ['organizationId', 'operation', 'idempotencyKey']
const SNAPSHOT_CONSTRAINT = 'CatalogIdempotencyRecord_preview_snapshot_check'
const DOMAIN_UNIQUES = new Map<string, readonly string[]>([
  ['CatalogVenueBinding_organizationId_catalogItemId_venueId_key', ['organizationId', 'catalogItemId', 'venueId']],
  ['CatalogVenueBinding_productId_venueId_key', ['productId', 'venueId']],
  ['Product_venueId_sku_key', ['venueId', 'sku']],
  ['Product_venueId_gtin_key', ['venueId', 'gtin']],
])

interface AppliedBatch {
  id: string
  organizationId: string
  state: CatalogOperationState
  schemaVersion: number
  requestHash: string
  requestHashVersion: number
  targetHash: string
  previewTokenHash: string
  dependencies: Prisma.JsonValue
  actorType: ActivityActorType
  staffId: string | null
  result: Prisma.JsonValue | null
}

interface DependencyAuthority {
  target: Map<string, CatalogBindingDependencyAuthorityV1>
}

function invalidResult(message: string): never {
  throw new ConflictError(message, 'CATALOG_BINDING_RESULT_INVALID')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function fieldsMatch(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((field, index) => field === expected[index])
}

function metaTarget(error: unknown): unknown {
  return isRecord(error) && isRecord(error.meta) ? error.meta.target : undefined
}

function metaConstraint(error: unknown): unknown {
  return isRecord(error) && isRecord(error.meta) ? error.meta.constraint : undefined
}

export function isCatalogBindingIdempotencyUniqueConflict(error: unknown): boolean {
  if (!isRecord(error) || error.code !== 'P2002') return false
  const target = metaTarget(error)
  return target === IDEMPOTENCY_CONSTRAINT || metaConstraint(error) === IDEMPOTENCY_CONSTRAINT || fieldsMatch(target, IDEMPOTENCY_FIELDS)
}

export function isCatalogBindingPreviewSnapshotConstraint(error: unknown): boolean {
  return isRecord(error) && error.code === 'P2004' && isRecord(error.meta) && error.meta.constraint === SNAPSHOT_CONSTRAINT
}

export function isCatalogBindingDomainWriteConflict(error: unknown): boolean {
  if (!isRecord(error) || error.code !== 'P2002') return false
  const target = metaTarget(error)
  for (const [constraint, fields] of DOMAIN_UNIQUES) {
    if (target === constraint || metaConstraint(error) === constraint || fieldsMatch(target, fields)) return true
  }
  return false
}

export function isCatalogBindingSerializationConflict(error: unknown): boolean {
  return isRecord(error) && error.code === 'P2034'
}

function tokenMatches(raw: string, digest: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(digest)) return false
  return timingSafeEqual(createHash('sha256').update(raw).digest(), Buffer.from(digest, 'hex'))
}

function parseResultLine(value: unknown): CatalogBindingResultLine {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['catalogItemId', 'venueId', 'decision', 'status', 'productId', 'bindingId', 'readiness']) ||
    typeof value.catalogItemId !== 'string' ||
    !value.catalogItemId.trim() ||
    typeof value.venueId !== 'string' ||
    !value.venueId.trim() ||
    !['LINK', 'CREATE', 'SKIP'].includes(value.decision as string) ||
    !['APPLIED', 'SKIPPED'].includes(value.status as string) ||
    (value.readiness !== null && !isRecord(value.readiness))
  ) {
    return invalidResult('Una línea del resultado idempotente es inválida.')
  }
  const skipped = value.decision === 'SKIP' && value.status === 'SKIPPED' && value.productId === null && value.bindingId === null
  const applied =
    value.decision !== 'SKIP' &&
    value.status === 'APPLIED' &&
    typeof value.productId === 'string' &&
    value.productId.trim().length > 0 &&
    typeof value.bindingId === 'string' &&
    value.bindingId.trim().length > 0
  if (!skipped && !applied) return invalidResult('El estado de una línea idempotente es incoherente.')
  return { ...value } as unknown as CatalogBindingResultLine
}

function parseAppliedResult(value: unknown, batchId: string, authority: DependencyAuthority): CatalogBindingResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['bindingBatchId', 'state', 'lines']) ||
    value.bindingBatchId !== batchId ||
    value.state !== 'APPLIED' ||
    !Array.isArray(value.lines) ||
    value.lines.length < 1 ||
    value.lines.length > MAX_LINES
  ) {
    return invalidResult('El resultado idempotente almacenado no es válido.')
  }
  const lines = value.lines.map(parseResultLine)
  const identities = lines.map(line => `${line.catalogItemId}\u0000${line.venueId}`)
  if (
    new Set(identities).size !== identities.length ||
    lines.some(line => {
      const dependency = authority.target.get(`${line.catalogItemId}\u0000${line.venueId}`)
      return (
        !dependency ||
        dependency.decision.decision !== line.decision ||
        !isCatalogBindingRecoveredReadinessV1(line.readiness, line, dependency)
      )
    })
  ) {
    return invalidResult('El resultado idempotente no coincide con sus dependencias.')
  }
  return { bindingBatchId: batchId, state: 'APPLIED', lines }
}

function parseDependencyAuthority(batch: AppliedBatch, context: CatalogCommandContext): DependencyAuthority {
  if (
    !isRecord(batch.dependencies) ||
    !hasExactKeys(batch.dependencies, ['schemaVersion', 'lines']) ||
    batch.dependencies.schemaVersion !== 1
  ) {
    return invalidResult('El snapshot idempotente no es cerrado.')
  }
  const lines = batch.dependencies.lines
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > MAX_LINES)
    return invalidResult('El snapshot idempotente no tiene líneas válidas.')
  if (hashCanonicalJsonV1('catalog-binding-target', lines) !== batch.targetHash)
    return invalidResult('El target hash idempotente no coincide.')
  if (
    context.actor.type !== 'HUMAN' ||
    hashCanonicalJsonV1('catalog-binding-request', {
      organizationId: context.organizationId,
      staffId: context.actor.staffId,
      targetHash: batch.targetHash,
    }) !== batch.requestHash
  ) {
    return invalidResult('El request hash idempotente no coincide.')
  }
  const target = new Map<string, CatalogBindingDependencyAuthorityV1>()
  for (const line of lines) {
    const parsed = parseCatalogBindingDependencyAuthorityV1(line, context.organizationId)
    if (!parsed) return invalidResult('Una dependencia idempotente no respeta el esquema v1.')
    const identity = `${parsed.catalogItemId}\u0000${parsed.venueId}`
    if (target.has(identity)) return invalidResult('Las dependencias idempotentes repiten target.')
    target.set(identity, parsed)
  }
  return { target }
}

export async function recoverCatalogBindingAppliedTx(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  input: CatalogBindingConfirmInput,
  expectedRequestHash: string,
): Promise<CatalogBindingResult> {
  const rawBatch = await tx.catalogBindingBatch.findFirst({ where: { id: input.bindingBatchId, organizationId: context.organizationId } })
  if (!rawBatch) throw new NotFoundError('Preview de binding no encontrado')
  const batch = rawBatch as unknown as AppliedBatch
  if (
    context.actor.type !== 'HUMAN' ||
    context.actor.impersonating ||
    batch.actorType !== ActivityActorType.HUMAN ||
    batch.staffId !== context.actor.staffId ||
    !tokenMatches(input.previewToken, batch.previewTokenHash)
  ) {
    return invalidResult('El actor o bearer idempotente no coincide con el batch.')
  }
  const record = await tx.catalogIdempotencyRecord.findFirst({
    where: { organizationId: context.organizationId, operation: OPERATION, idempotencyKey: input.idempotencyKey },
  })
  if (!record || record.requestHash !== expectedRequestHash) {
    throw new ConflictError('La llave de idempotencia ya se usó con otro contenido.', 'IDEMPOTENCY_KEY_REUSED')
  }
  if (
    batch.state !== CatalogOperationState.APPLIED ||
    batch.schemaVersion !== 1 ||
    batch.requestHashVersion !== 1 ||
    batch.requestHash !== expectedRequestHash ||
    record.organizationId !== context.organizationId ||
    record.operation !== OPERATION ||
    record.idempotencyKey !== input.idempotencyKey ||
    record.state !== CatalogOperationState.APPLIED ||
    record.resourceType !== 'CatalogBindingBatch' ||
    record.resourceId !== batch.id ||
    record.targetHash !== batch.targetHash ||
    record.requestHashVersion !== 1 ||
    record.actorType !== ActivityActorType.HUMAN ||
    record.staffId !== context.actor.staffId ||
    canonicalJsonV1(record.dependencies) !== canonicalJsonV1(batch.dependencies)
  ) {
    return invalidResult('La autoridad idempotente no coincide con el batch.')
  }
  const authority = parseDependencyAuthority(batch, context)
  const batchResult = parseAppliedResult(batch.result, batch.id, authority)
  const recordResult = parseAppliedResult(record.result, batch.id, authority)
  if (canonicalJsonV1(batchResult) !== canonicalJsonV1(recordResult)) return invalidResult('Los resultados idempotentes divergen.')

  // WHY: Replay is proven by tenant-scoped staging and live provenance/Product
  // relations; matching JSON alone cannot manufacture an APPLIED outcome.
  const durableLines = await tx.catalogBindingLine.findMany({
    where: { batchId: batch.id, organizationId: context.organizationId },
    orderBy: { id: 'asc' },
    take: MAX_LINES + 1,
    select: { id: true, catalogItemId: true, venueId: true, productId: true, status: true, proposal: true, decision: true, after: true },
  })
  if (durableLines.length !== batchResult.lines.length || durableLines.length > MAX_LINES) {
    return invalidResult('Las líneas APPLIED no conservan la cardinalidad aprobada.')
  }
  const durableByTarget = new Map(durableLines.map(line => [`${line.catalogItemId}\u0000${line.venueId}`, line] as const))
  if (durableByTarget.size !== durableLines.length) return invalidResult('Las líneas APPLIED repiten targets.')
  for (const resultLine of batchResult.lines) {
    const durable = durableByTarget.get(`${resultLine.catalogItemId}\u0000${resultLine.venueId}`)
    if (
      !durable ||
      durable.decision !== resultLine.decision ||
      durable.proposal !== resultLine.decision ||
      durable.status !== resultLine.status ||
      durable.productId !== resultLine.productId ||
      canonicalJsonV1(durable.after) !==
        canonicalJsonV1(
          resultLine.status === 'SKIPPED'
            ? { decision: 'SKIP', status: 'SKIPPED' }
            : { bindingId: resultLine.bindingId, productId: resultLine.productId },
        )
    ) {
      return invalidResult('Una línea APPLIED no coincide con el resultado.')
    }
    if (resultLine.status === 'SKIPPED') continue
    const binding = await tx.catalogVenueBinding.findFirst({
      where: {
        id: resultLine.bindingId as string,
        organizationId: context.organizationId,
        catalogItemId: resultLine.catalogItemId,
        venueId: resultLine.venueId,
        productId: resultLine.productId as string,
        status: CatalogVenueBindingStatus.LINKED,
      },
      select: { id: true, productId: true, product: { select: { id: true, venueId: true } } },
    })
    if (!binding || !binding.product || binding.product.id !== resultLine.productId || binding.product.venueId !== resultLine.venueId) {
      return invalidResult('La línea APPLIED no conserva binding y Product vivos.')
    }
  }
  return batchResult
}
