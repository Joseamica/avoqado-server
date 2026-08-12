import { ConflictError } from '../../errors/AppError'
import type { CatalogCommandContext } from '../../types/master-catalog'
import { parseCatalogImportConfirmCapacityV1, type CatalogImportConfirmCapacityV1 } from './catalogImportCapacity.service'
import { createCatalogImportCooperativeCheckpoint, type CatalogImportCooperativeCheckpoint } from './catalogImportCanonical.service'
import { exactCatalogImportJsonEqualsV1, parseCatalogImportDependencySnapshotV1 } from './catalogImportDependencySnapshot.service'
import type { CatalogImportDependencySnapshotV1 } from './catalogImport.types'
import type { CatalogImportAppliedResult, CatalogImportConfirmInput, CatalogImportTransaction } from './catalogImport.types'
import { CATALOG_IMPORT_ITEM_LINE_MAX_V1 } from './catalogImport.types'
import { parseCatalogImportBatchV1 } from './catalogImportStagedPayload.service'

const IDEMPOTENCY_CONSTRAINT = 'CatalogIdempotencyRecord_organizationId_operation_idemp_key'
const IDEMPOTENCY_FIELDS = ['organizationId', 'operation', 'idempotencyKey']

function invalidResult(message: string): never {
  throw new ConflictError(message, 'CATALOG_IMPORT_RESULT_INVALID')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseAppliedResult(value: unknown, input: CatalogImportConfirmInput): CatalogImportAppliedResult {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).length !== 3 ||
    !['importBatchId', 'state', 'appliedItemIds'].every(key => Object.prototype.hasOwnProperty.call(value, key)) ||
    value.importBatchId !== input.importBatchId ||
    value.state !== 'APPLIED' ||
    !Array.isArray(value.appliedItemIds) ||
    value.appliedItemIds.length < 1 ||
    value.appliedItemIds.length > 20_000 ||
    value.appliedItemIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256) ||
    new Set(value.appliedItemIds).size !== value.appliedItemIds.length
  ) {
    return invalidResult('El resultado idempotente almacenado no es válido.')
  }
  // WHY: Recovery returns a closed DTO projection; durable/future metadata is
  // never reflected from corrupted JSON into the API response.
  return {
    importBatchId: value.importBatchId,
    state: 'APPLIED',
    appliedItemIds: [...value.appliedItemIds],
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function parseAppliedCapacity(dependencies: unknown): CatalogImportConfirmCapacityV1 {
  if (!isPlainRecord(dependencies)) return invalidResult('La capacidad idempotente no es válida.')
  try {
    const capacity = parseCatalogImportConfirmCapacityV1(dependencies.capacity, ['EXACT'])
    if (!capacity.withinLimit) return invalidResult('La capacidad idempotente no es confirmable.')
    return capacity
  } catch {
    return invalidResult('La capacidad idempotente no es válida.')
  }
}

async function parseAppliedDependencies(
  dependencies: unknown,
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<CatalogImportDependencySnapshotV1> {
  try {
    const snapshot = await parseCatalogImportDependencySnapshotV1(dependencies, checkpoint)
    parseAppliedCapacity(snapshot)
    return snapshot
  } catch {
    return invalidResult('El snapshot idempotente de dependencias no es válido.')
  }
}

export function isCatalogImportIdempotencyUniqueConflict(error: unknown): boolean {
  if (!isRecord(error) || error.code !== 'P2002' || !isRecord(error.meta)) return false
  const target = error.meta.target
  if (target === IDEMPOTENCY_CONSTRAINT) return true
  return (
    Array.isArray(target) &&
    target.length === IDEMPOTENCY_FIELDS.length &&
    target.every((field, index) => field === IDEMPOTENCY_FIELDS[index])
  )
}

export async function recoverCatalogImportAppliedTx(
  tx: CatalogImportTransaction,
  context: CatalogCommandContext,
  input: CatalogImportConfirmInput,
  requestHash: string,
): Promise<CatalogImportAppliedResult> {
  // WHY: Recovery re-reads record, batch, and ordered lines inside one tenant
  // transaction; no single denormalized JSON result is trusted as authority.
  const record = await tx.catalogIdempotencyRecord.findUnique({
    where: {
      organizationId_operation_idempotencyKey: {
        organizationId: context.organizationId,
        operation: 'CATALOG_IMPORT',
        idempotencyKey: input.idempotencyKey,
      },
    },
  })
  if (!record || record.requestHash !== requestHash) {
    throw new ConflictError('La llave de idempotencia ya se usó con otro contenido.', 'IDEMPOTENCY_KEY_REUSED')
  }
  const rawBatch = await tx.catalogImportBatch.findFirst({
    where: { id: input.importBatchId, organizationId: context.organizationId },
  })
  if (!rawBatch) return invalidResult('El batch idempotente no existe.')
  const batch = parseCatalogImportBatchV1(rawBatch)
  const typedRecord = record as unknown as Record<string, unknown>
  if (
    typedRecord.organizationId !== context.organizationId ||
    typedRecord.operation !== 'CATALOG_IMPORT' ||
    typedRecord.idempotencyKey !== input.idempotencyKey ||
    typedRecord.state !== 'APPLIED' ||
    typedRecord.resourceType !== 'CatalogImportBatch' ||
    typedRecord.resourceId !== batch.id ||
    typedRecord.requestHash !== batch.requestHash ||
    typedRecord.targetHash !== batch.targetHash ||
    batch.state !== 'APPLIED'
  ) {
    return invalidResult('La autoridad idempotente no coincide con el batch.')
  }
  // WHY: APPLIED replay still exposes a confirmation result. Parse the full
  // bounded dependency envelope from both durable authorities cooperatively,
  // require exact equality, and retain the exact within-limit capacity gate;
  // coherent result JSON cannot mask a truncated or forged snapshot.
  const checkpoint = createCatalogImportCooperativeCheckpoint(4)
  const batchDependencies = await parseAppliedDependencies(batch.dependencies, checkpoint)
  const recordDependencies = await parseAppliedDependencies(typedRecord.dependencies, checkpoint)
  if (!(await exactCatalogImportJsonEqualsV1(recordDependencies, batchDependencies, checkpoint))) {
    return invalidResult('Las dependencias idempotentes no coinciden con el batch.')
  }
  const recordResult = parseAppliedResult(typedRecord.result, input)
  const batchResult = parseAppliedResult(batch.result, input)
  const lines = await tx.catalogImportLine.findMany({
    // WHY: Ancillary review lines intentionally remain READY after an atomic
    // apply; only Items are mutation/result authorities during replay.
    where: { batchId: batch.id, organizationId: context.organizationId, sourceSheet: 'Items' },
    orderBy: [{ sourceSheet: 'asc' }, { sourceRow: 'asc' }],
    // WHY: Replay reads one sentinel beyond the V1 Items envelope so corrupt
    // batches cannot force unbounded result hydration before authority checks.
    take: CATALOG_IMPORT_ITEM_LINE_MAX_V1 + 1,
    select: { id: true, status: true, catalogItemId: true, sourceSheet: true, sourceRow: true },
  })
  const lineIds = lines.map(line => line.catalogItemId)
  if (
    lineIds.length < 1 ||
    lineIds.length > CATALOG_IMPORT_ITEM_LINE_MAX_V1 ||
    lines.some(line => line.status !== 'APPLIED') ||
    lineIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256) ||
    new Set(lineIds).size !== lineIds.length
  ) {
    return invalidResult('Las líneas APPLIED no conservan una autoridad válida.')
  }
  const appliedLineIds = lineIds as string[]
  if (!sameIds(recordResult.appliedItemIds, batchResult.appliedItemIds) || !sameIds(batchResult.appliedItemIds, appliedLineIds)) {
    return invalidResult('El resultado idempotente no coincide con las líneas aplicadas.')
  }
  return batchResult
}
