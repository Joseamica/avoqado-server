import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import AppError from '../../errors/AppError'
import { parseCatalogImportConfirmCapacityV1 } from './catalogImportCapacity.service'
import type {
  CatalogImportDependencySnapshotV1,
  CatalogImportPreviewResult,
  CatalogImportRowError,
  CatalogImportStagedLine,
  CatalogImportTransaction,
} from './catalogImport.types'
import { CATALOG_IMPORT_STAGED_LINE_MAX_V1 } from './catalogImport.types'

export const CATALOG_IMPORT_LINE_CHUNK_SIZE = 500
export const CATALOG_IMPORT_PREVIEW_ERROR_LIMIT = 100

interface PersistCatalogImportPreviewInput {
  organizationId: string
  staffId: string
  fileSha256: string
  requestHash: string
  targetHash: string
  previewToken: string
  expiresAt: Date
  now: Date
  dependencies: CatalogImportDependencySnapshotV1
  staged: CatalogImportStagedLine[]
  errors: CatalogImportRowError[]
}

export async function persistCatalogImportPreviewTx(
  tx: CatalogImportTransaction,
  input: PersistCatalogImportPreviewInput,
): Promise<CatalogImportPreviewResult> {
  // WHY: Worker/validation normally preserve the 50k physical-row envelope,
  // but persistence is the final write boundary. Reject its sentinel before
  // creating a batch or allocating hundreds of SQL bind chunks.
  if (input.staged.length > CATALOG_IMPORT_STAGED_LINE_MAX_V1) {
    throw new AppError('El staging excede el límite total de filas V1.', 409, true, 'CATALOG_IMPORT_STAGING_INVALID')
  }
  const capacity = parseCatalogImportConfirmCapacityV1(input.dependencies.capacity, ['EXACT', 'LOWER_BOUND'])
  const capacityBlocked = !capacity.withinLimit
  const hasValidationErrors = input.errors.some(error => error.error_code !== 'CATALOG_IMPORT_CONFIRM_LIMIT_EXCEEDED')
  const failed = input.errors.length > 0 || capacityBlocked
  const failureCode = capacityBlocked ? 'CATALOG_IMPORT_CONFIRM_LIMIT_EXCEEDED' : 'CATALOG_IMPORT_VALIDATION_FAILED'
  const failureMessage = capacityBlocked
    ? `La importación requiere al menos ${capacity.workUnits} unidades de trabajo; el límite V1 es ${capacity.limit}.`
    : `La importación contiene ${input.errors.length} hallazgo(s) de validación.`
  const batch = await tx.catalogImportBatch.create({
    data: {
      organizationId: input.organizationId,
      state: failed ? 'FAILED' : 'PREVIEWED',
      schemaVersion: 1,
      fileSha256: input.fileSha256,
      requestHash: input.requestHash,
      requestHashVersion: 1,
      targetHash: input.targetHash,
      previewTokenHash: createHash('sha256').update(input.previewToken).digest('hex'),
      previewExpiresAt: input.expiresAt,
      dependencies: input.dependencies as unknown as Prisma.InputJsonValue,
      actorType: 'HUMAN',
      staffId: input.staffId,
      // WHY: FAILED previews satisfy the durable DDL shape and expose only an
      // aggregate message; full bounded findings remain on staged lines.
      ...(failed
        ? {
            failureCode,
            failureMessage,
            completedAt: input.now,
          }
        : {}),
    },
  })
  const lineData = input.staged.map(line => ({
    organizationId: input.organizationId,
    batchId: batch.id,
    sourceSheet: line.sourceSheet,
    sourceRow: line.sourceRow,
    status: line.status,
    payload: line.payload,
    errors: line.errors.length ? (line.errors as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
    catalogItemId: line.catalogItemId ?? null,
  }))
  for (let offset = 0; offset < lineData.length; offset += CATALOG_IMPORT_LINE_CHUNK_SIZE) {
    // WHY: Chunked INSERTs stay below PostgreSQL bind limits but remain in the
    // same transaction; exact counts turn partial driver results into rollback.
    const chunk = lineData.slice(offset, offset + CATALOG_IMPORT_LINE_CHUNK_SIZE)
    const inserted = await tx.catalogImportLine.createMany({ data: chunk })
    if (inserted.count !== chunk.length) {
      throw new AppError('No fue posible conservar todas las filas staged.', 409, true, 'CATALOG_IMPORT_STAGING_WRITE_CONFLICT')
    }
  }
  const responseErrors = input.errors.slice(0, CATALOG_IMPORT_PREVIEW_ERROR_LIMIT)
  const blockingReasons: CatalogImportPreviewResult['blockingReasons'] = []
  if (hasValidationErrors) {
    blockingReasons.push({
      code: 'CATALOG_IMPORT_VALIDATION_FAILED',
      message: `Corrige los ${input.errors.length} hallazgo(s) antes de confirmar.`,
    })
  }
  if (capacityBlocked) {
    blockingReasons.push({
      code: 'CATALOG_IMPORT_CONFIRM_LIMIT_EXCEEDED',
      message: `La confirmación requiere al menos ${capacity.workUnits} unidades; divide el workbook.`,
    })
  }
  // WHY: Full diagnostics are durable and Task 10 can paginate them; the
  // immediate DTO/capacity reasons cannot amplify a hostile workbook during
  // JSON serialization or conceal why no bearer was issued.
  return {
    importBatchId: batch.id,
    canConfirm: !failed,
    previewToken: failed ? null : input.previewToken,
    targetHash: input.targetHash,
    expiresAt: input.expiresAt.toISOString(),
    errors: responseErrors,
    errorCount: input.errors.length,
    errorsTruncated: responseErrors.length !== input.errors.length,
    capacity,
    blockingReasons,
  }
}
