import type { Prisma } from '@prisma/client'
import AppError, { ForbiddenError, NotFoundError, ServiceUnavailableError } from '../../errors/AppError'
import type { CatalogCommandContext } from '../../types/master-catalog'
import prisma from '../../utils/prismaClient'
import { parseCatalogImportConfirmCapacitySqlRowV1, type CatalogImportConfirmCapacityV1 } from './catalogImportCapacity.service'
import { CATALOG_IMPORT_PREVIEW_TRANSACTION_OPTIONS } from './catalogImport.types'
import {
  queryCatalogImportPreviewBatchTx,
  queryCatalogImportPreviewItemDetailTx,
  queryCatalogImportProfileVersionsTx,
  queryCatalogImportPreviewSectionPageTx,
  type CatalogImportReadQueryTransaction,
} from './catalogImportReadQueries.service'
import {
  catalogImportPreviewPositionV1,
  decodeCatalogImportPreviewCursorV1,
  encodeCatalogImportPreviewCursorV1,
  normalizeCatalogImportPreviewPageSize,
  projectCatalogImportPreviewItemDetailV1,
  projectCatalogImportPreviewRowV1,
  type CatalogImportPreviewItemDetailV1,
  type CatalogImportPreviewProjectedRowV1,
  type CatalogImportPreviewSection,
} from './catalogImportPreviewProjection.service'
import { resolveMasterCatalogAccess } from './masterCatalogAccess.service'
import { CATALOG_IMPORT_PROFILE_SNAPSHOT_CAP_V1 } from './catalogImportDependencySnapshot.service'

export type { CatalogImportPreviewSection } from './catalogImportPreviewProjection.service'
export {
  queryCatalogImportPreviewBatchTx,
  queryCatalogImportPreviewItemDetailTx,
  queryCatalogImportPreviewSectionPageTx,
} from './catalogImportReadQueries.service'
export type {
  CatalogImportBatchQueryV1,
  CatalogImportItemDetailQueryV1,
  CatalogImportSectionQueryV1,
} from './catalogImportReadQueries.service'

interface CatalogImportBatchReadV1 {
  id: string
  organizationId: string
  schemaVersion: 1
  targetHash: string
  previewTokenHash: string
  staffId: string
  state: 'PREVIEWED' | 'FAILED' | 'APPLIED'
  previewExpiresAt: Date
  capacity: CatalogImportConfirmCapacityV1
  lineCount: number
  itemCount: number
  capacityIntegrityValid: true
  invalidLineCount: 0
  invalidPayloadCount: 0
  oversizedSheetCount: 0
}

export interface CatalogImportPreviewPageInput {
  importBatchId: string
  section: CatalogImportPreviewSection
  cursor?: string | null
  pageSize?: number
}

export interface CatalogImportPreviewItemDetailInput {
  importBatchId: string
  sourceRow: number
}

export interface CatalogImportPreviewBatchSummaryV1 {
  state: 'PREVIEWED' | 'FAILED' | 'APPLIED'
  targetHash: string
  expiresAt: string
  canConfirm: boolean
  capacity: CatalogImportConfirmCapacityV1
}

export interface CatalogImportPreviewPageV1 {
  schemaVersion: 1
  importBatchId: string
  section: CatalogImportPreviewSection
  pageSize: number
  batch: CatalogImportPreviewBatchSummaryV1
  rows: CatalogImportPreviewProjectedRowV1[]
  nextCursor: string | null
}

export interface CatalogImportPreviewItemDetailResultV1 {
  schemaVersion: 1
  importBatchId: string
  batch: CatalogImportPreviewBatchSummaryV1
  row: CatalogImportPreviewItemDetailV1
}

export type CatalogImportReadTransaction = CatalogImportReadQueryTransaction

export interface CatalogImportReadPrisma {
  $transaction<T>(work: (tx: CatalogImportReadTransaction) => Promise<T>, options?: unknown): Promise<T>
}

export interface CatalogImportReadDependencies {
  prisma: CatalogImportReadPrisma
  assertLiveAccessTx(tx: CatalogImportReadTransaction, context: CatalogCommandContext): Promise<void>
  queryBatchTx?: typeof queryCatalogImportPreviewBatchTx
  querySectionPageTx?: typeof queryCatalogImportPreviewSectionPageTx
  queryItemDetailTx?: typeof queryCatalogImportPreviewItemDetailTx
  queryProfileVersionsTx?: typeof queryCatalogImportProfileVersionsTx
  now?: () => Date
}

const SHA256_HEX = /^[a-f0-9]{64}$/u
const BATCH_STATES = new Set(['PREVIEWED', 'FAILED', 'APPLIED'])
const MAX_DURABLE_LINES = 50_000
const MAX_ITEM_LINES = 20_000
const VALID_SECTIONS = new Set<CatalogImportPreviewSection>([
  'ITEMS',
  'ORGANIZATION_VALUES',
  'BUSINESS_TYPES',
  'REFERENCE_PROPOSALS',
  'VENUE_BINDING_REQUESTS',
  'ERRORS',
])

function failData(): never {
  throw new AppError('El preview durable contiene datos inválidos.', 409, true, 'CATALOG_IMPORT_PREVIEW_DATA_INVALID')
}

function failInput(code: string, message: string): never {
  throw new AppError(message, 422, true, code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
}

function boundedCount(value: unknown): number {
  const normalized = typeof value === 'string' && /^(0|[1-9][0-9]{0,8})$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 0 || (normalized as number) > 50_000_000) return failData()
  return normalized as number
}

function requireHuman(context: CatalogCommandContext): string {
  // WHY: Proposed commercial values remain visible only to the original
  // non-impersonating human editor, even within the same organization.
  if (context.actor.type !== 'HUMAN' || context.actor.impersonating || !context.actor.staffId.trim()) {
    throw new AppError('La lectura del import requiere un actor humano activo.', 403, true, 'CATALOG_HUMAN_ACTOR_REQUIRED')
  }
  return context.actor.staffId
}

function parseBatch(value: unknown, context: CatalogCommandContext, actorId: string): CatalogImportBatchReadV1 {
  const keys = [
    'id',
    'organizationId',
    'schemaVersion',
    'targetHash',
    'previewTokenHash',
    'staffId',
    'state',
    'previewExpiresAt',
    'capacity',
    'lineCount',
    'itemCount',
    'capacityIntegrityValid',
    'invalidLineCount',
    'invalidPayloadCount',
    'oversizedSheetCount',
  ]
  if (!isRecord(value) || !exactKeys(value, keys)) return failData()
  const lineCount = boundedCount(value.lineCount)
  const itemCount = boundedCount(value.itemCount)
  // WHY: A preview bearer needs Items, each sheet is capped at 20k, and the
  // workbook-wide durable envelope is independently capped at 50k lines.
  if (
    !validId(value.id) ||
    value.organizationId !== context.organizationId ||
    value.schemaVersion !== 1 ||
    typeof value.targetHash !== 'string' ||
    !SHA256_HEX.test(value.targetHash) ||
    typeof value.previewTokenHash !== 'string' ||
    !SHA256_HEX.test(value.previewTokenHash) ||
    !validId(value.staffId) ||
    typeof value.state !== 'string' ||
    !BATCH_STATES.has(value.state) ||
    !(value.previewExpiresAt instanceof Date) ||
    !Number.isFinite(value.previewExpiresAt.getTime()) ||
    lineCount < 1 ||
    lineCount > MAX_DURABLE_LINES ||
    itemCount < 1 ||
    itemCount > MAX_ITEM_LINES ||
    itemCount > lineCount ||
    value.capacityIntegrityValid !== true ||
    boundedCount(value.invalidLineCount) !== 0 ||
    boundedCount(value.invalidPayloadCount) !== 0 ||
    boundedCount(value.oversizedSheetCount) !== 0
  )
    return failData()
  let capacity: CatalogImportConfirmCapacityV1
  try {
    capacity = parseCatalogImportConfirmCapacitySqlRowV1(value.capacity)
  } catch {
    return failData()
  }
  const batch = { ...value, capacity } as unknown as CatalogImportBatchReadV1
  // WHY: Only a FAILED preview may persist the bounded limit+1 lower bound;
  // every readable successful/terminal snapshot must retain an exact measure.
  if ((batch.state === 'PREVIEWED' || batch.state === 'APPLIED') && batch.capacity.measurement !== 'EXACT') return failData()
  if (batch.staffId !== actorId) throw new AppError('El preview pertenece a otro actor.', 403, true, 'CATALOG_IMPORT_ACTOR_MISMATCH')
  return batch
}

function validatePageInput(input: CatalogImportPreviewPageInput): number {
  if (!validId(input.importBatchId)) failInput('CATALOG_IMPORT_BATCH_ID_INVALID', 'importBatchId no es válido.')
  if (!VALID_SECTIONS.has(input.section)) failInput('CATALOG_IMPORT_SECTION_INVALID', 'La sección del preview no es válida.')
  if (input.cursor !== undefined && input.cursor !== null && typeof input.cursor !== 'string') {
    failInput('CATALOG_IMPORT_CURSOR_INVALID', 'El cursor del preview no es válido.')
  }
  return normalizeCatalogImportPreviewPageSize(input.pageSize)
}

function validateDetailInput(input: CatalogImportPreviewItemDetailInput): void {
  if (!validId(input.importBatchId)) failInput('CATALOG_IMPORT_BATCH_ID_INVALID', 'importBatchId no es válido.')
  if (!Number.isInteger(input.sourceRow) || input.sourceRow < 1 || input.sourceRow > 2_147_483_647) {
    failInput('CATALOG_IMPORT_SOURCE_ROW_INVALID', 'sourceRow no es válido.')
  }
}

function summarizeBatch(batch: CatalogImportBatchReadV1, now: Date): CatalogImportPreviewBatchSummaryV1 {
  return {
    state: batch.state,
    targetHash: batch.targetHash,
    expiresAt: batch.previewExpiresAt.toISOString(),
    canConfirm: batch.state === 'PREVIEWED' && batch.capacity.withinLimit && batch.previewExpiresAt.getTime() > now.getTime(),
    capacity: batch.capacity,
  }
}

function parseSnapshotProfileVersions(rows: Array<Record<string, unknown>>, batchId: string): number[] {
  if (rows.length < 1 || rows.length > CATALOG_IMPORT_PROFILE_SNAPSHOT_CAP_V1 + 1) return failData()
  const versions: number[] = []
  for (const row of rows) {
    if (
      !isRecord(row) ||
      !exactKeys(row, ['batchId', 'collectionShapeValid', 'ordinal', 'rowShapeValid', 'profileVersion']) ||
      row.batchId !== batchId ||
      row.collectionShapeValid !== true ||
      row.rowShapeValid !== true
    )
      return failData()
    if (row.profileVersion === null) {
      if (rows.length !== 1 || row.ordinal !== 0) return failData()
      continue
    }
    if (typeof row.profileVersion !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(row.profileVersion)) return failData()
    const version = Number(row.profileVersion)
    if (!Number.isSafeInteger(version) || version > 2_147_483_647 || !Number.isInteger(row.ordinal) || (row.ordinal as number) < 1)
      return failData()
    versions.push(version)
  }
  return [...new Set(versions)].sort((left, right) => left - right)
}

export function createCatalogImportReadService(dependencies: CatalogImportReadDependencies) {
  const queryBatch = dependencies.queryBatchTx ?? queryCatalogImportPreviewBatchTx
  const queryPage = dependencies.querySectionPageTx ?? queryCatalogImportPreviewSectionPageTx
  const queryDetail = dependencies.queryItemDetailTx ?? queryCatalogImportPreviewItemDetailTx
  const queryProfileVersions = dependencies.queryProfileVersionsTx ?? queryCatalogImportProfileVersionsTx
  const clock = dependencies.now ?? (() => new Date())

  const loadBatch = async (tx: CatalogImportReadTransaction, context: CatalogCommandContext, id: string, actorId: string) => {
    const raw = await queryBatch(tx, { organizationId: context.organizationId, importBatchId: id })
    if (!raw) throw new NotFoundError('Preview de importación no encontrado.')
    return parseBatch(raw, context, actorId)
  }

  return {
    async listPage(context: CatalogCommandContext, input: CatalogImportPreviewPageInput): Promise<CatalogImportPreviewPageV1> {
      const actorId = requireHuman(context)
      const pageSize = validatePageInput(input)
      return dependencies.prisma.$transaction(
        async tx => {
          await dependencies.assertLiveAccessTx(tx, context)
          const batch = await loadBatch(tx, context, input.importBatchId, actorId)
          const after = input.cursor
            ? decodeCatalogImportPreviewCursorV1(
                input.cursor,
                { batchId: batch.id, section: input.section, targetHash: batch.targetHash },
                batch.previewTokenHash,
              )
            : null
          const rawRows = await queryPage(tx, {
            organizationId: context.organizationId,
            importBatchId: batch.id,
            section: input.section,
            after,
            take: pageSize + 1,
          })
          if (rawRows.length > pageSize + 1) return failData()
          const visible = rawRows.slice(0, pageSize)
          const rows = visible.map(row => projectCatalogImportPreviewRowV1(input.section, row))
          const last = rawRows.length > pageSize ? visible[visible.length - 1] : undefined
          const nextCursor = last
            ? encodeCatalogImportPreviewCursorV1(
                {
                  schemaVersion: 1,
                  batchId: batch.id,
                  section: input.section,
                  targetHash: batch.targetHash,
                  ...catalogImportPreviewPositionV1(last, input.section),
                },
                batch.previewTokenHash,
              )
            : null
          return {
            schemaVersion: 1,
            importBatchId: batch.id,
            section: input.section,
            pageSize,
            batch: summarizeBatch(batch, clock()),
            rows,
            nextCursor,
          }
        },
        { ...CATALOG_IMPORT_PREVIEW_TRANSACTION_OPTIONS, isolationLevel: 'RepeatableRead' },
      )
    },
    async getItemDetail(
      context: CatalogCommandContext,
      input: CatalogImportPreviewItemDetailInput,
    ): Promise<CatalogImportPreviewItemDetailResultV1> {
      const actorId = requireHuman(context)
      validateDetailInput(input)
      return dependencies.prisma.$transaction(
        async tx => {
          await dependencies.assertLiveAccessTx(tx, context)
          const batch = await loadBatch(tx, context, input.importBatchId, actorId)
          const raw = await queryDetail(tx, { organizationId: context.organizationId, importBatchId: batch.id, sourceRow: input.sourceRow })
          if (!raw) throw new NotFoundError('Fila del preview no encontrada.')
          return {
            schemaVersion: 1,
            importBatchId: batch.id,
            batch: summarizeBatch(batch, clock()),
            row: projectCatalogImportPreviewItemDetailV1(raw),
          }
        },
        { ...CATALOG_IMPORT_PREVIEW_TRANSACTION_OPTIONS, isolationLevel: 'RepeatableRead' },
      )
    },
    async getSnapshotProfileVersions(context: CatalogCommandContext, importBatchId: string): Promise<number[]> {
      const actorId = requireHuman(context)
      if (!validId(importBatchId)) failInput('CATALOG_IMPORT_BATCH_ID_INVALID', 'importBatchId no es válido.')
      return dependencies.prisma.$transaction(
        async tx => {
          await dependencies.assertLiveAccessTx(tx, context)
          const batch = await loadBatch(tx, context, importBatchId, actorId)
          const rows = await queryProfileVersions(tx, { organizationId: context.organizationId, importBatchId: batch.id })
          return parseSnapshotProfileVersions(rows, batch.id)
        },
        { ...CATALOG_IMPORT_PREVIEW_TRANSACTION_OPTIONS, isolationLevel: 'RepeatableRead' },
      )
    },
  }
}

async function assertDefaultLiveAccessTx(tx: CatalogImportReadTransaction, context: CatalogCommandContext): Promise<void> {
  const access = await resolveMasterCatalogAccess({
    organizationId: context.organizationId,
    principal: context.actor,
    capability: 'MUTATE_CONTENT',
    requiredGate: 'CORE',
    prisma: tx as Prisma.TransactionClient,
  })
  if (access.reasonCode === 'DEPENDENCY_UNAVAILABLE') {
    throw new ServiceUnavailableError('No fue posible revalidar acceso al catálogo.', 'CATALOG_ACCESS_UNAVAILABLE')
  }
  if (!access.canMutateContent) throw new ForbiddenError('Acceso al preview del import denegado.', access.reasonCode)
}

// WHY: Controllers share this production boundary and contain no Prisma,
// cursor-signing, tenant, or authorization logic.
const defaultCatalogImportReadService = createCatalogImportReadService({
  prisma: prisma as unknown as CatalogImportReadPrisma,
  assertLiveAccessTx: assertDefaultLiveAccessTx,
})

export const listCatalogImportPreviewPage = (context: CatalogCommandContext, input: CatalogImportPreviewPageInput) =>
  defaultCatalogImportReadService.listPage(context, input)

export const getCatalogImportPreviewItemDetail = (context: CatalogCommandContext, input: CatalogImportPreviewItemDetailInput) =>
  defaultCatalogImportReadService.getItemDetail(context, input)

export const getCatalogImportSnapshotProfileVersions = (context: CatalogCommandContext, importBatchId: string) =>
  defaultCatalogImportReadService.getSnapshotProfileVersions(context, importBatchId)
