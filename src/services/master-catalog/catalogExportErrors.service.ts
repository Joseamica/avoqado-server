import AppError from '@/errors/AppError'
import type { CatalogCommandContext, CatalogReadContext } from '@/types/master-catalog'
import {
  getCatalogImportSnapshotProfileVersions,
  listCatalogImportPreviewPage,
  type CatalogImportPreviewPageV1,
} from './catalogImportRead.service'
import { type CatalogWorkbookSheetV1, type CatalogWorkbookValueV1, writeCatalogWorkbookV1 } from './catalogExportWorkbook.service'
import { CATALOG_EXPORT_HYDRATED_ROW_CAP_V1 } from './catalogExportContract.service'
import { CATALOG_IMPORT_PROFILE_SNAPSHOT_CAP_V1 } from './catalogImportDependencySnapshot.service'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const
const ERROR_EXPORT_CAP_V1 = CATALOG_EXPORT_HYDRATED_ROW_CAP_V1
const PAGE_SIZE = 50
const REJECTED_VALUE_SCALARS = 128

type ListErrorsPage = (
  context: CatalogCommandContext,
  input: { importBatchId: string; section: 'ERRORS'; pageSize: 50; cursor: string | null },
) => Promise<CatalogImportPreviewPageV1>
type ReadSnapshotProfileVersions = (context: CatalogCommandContext, importBatchId: string) => Promise<number[]>

interface CatalogExportErrorsDependenciesV1 {
  listErrorsPage?: ListErrorsPage
  readSnapshotProfileVersions?: ReadSnapshotProfileVersions
  writeWorkbook?: typeof writeCatalogWorkbookV1
  now?: () => Date
}

function failData(message = 'Los errores durables del import no son válidos.'): never {
  throw new AppError(message, 409, true, 'CATALOG_IMPORT_ERRORS_DATA_INVALID')
}

function failCapacity(): never {
  throw new AppError(
    `La exportación de errores excede ${ERROR_EXPORT_CAP_V1} filas hidratadas; corrige el import por secciones.`,
    413,
    true,
    'CATALOG_EXPORT_CAP_EXCEEDED',
    { maxRows: ERROR_EXPORT_CAP_V1 },
  )
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string') return failData()
  return value
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return requiredText(value)
}

function truncateRejectedValue(value: unknown): string | null {
  const text = optionalText(value)
  return text === null ? null : Array.from(text).slice(0, REJECTED_VALUE_SCALARS).join('')
}

function profileVersionText(versions: number[]): string {
  if (!Array.isArray(versions) || versions.length > CATALOG_IMPORT_PROFILE_SNAPSHOT_CAP_V1) {
    return failData('El snapshot de perfiles del import no es válido.')
  }
  const unique = [...new Set(versions)]
  if (unique.some(version => !Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647)) {
    return failData('El snapshot de perfiles del import no es válido.')
  }
  unique.sort((left, right) => left - right)
  return unique.length ? unique.join(',') : '1'
}

export function createCatalogExportErrorsService(dependencies: CatalogExportErrorsDependenciesV1 = {}) {
  const listErrorsPage = dependencies.listErrorsPage ?? listCatalogImportPreviewPage
  const readSnapshotProfileVersions = dependencies.readSnapshotProfileVersions ?? getCatalogImportSnapshotProfileVersions
  const writeWorkbook = dependencies.writeWorkbook ?? writeCatalogWorkbookV1
  const now = dependencies.now ?? (() => new Date())

  return {
    async catalogImportErrors(context: CatalogReadContext, importBatchId: string) {
      if (typeof importBatchId !== 'string' || !importBatchId.trim() || importBatchId.length > 256) {
        throw new AppError('importBatchId no es válido.', 422, true, 'CATALOG_IMPORT_BATCH_ID_INVALID')
      }
      const commandContext = context as CatalogCommandContext
      const versions = await readSnapshotProfileVersions(commandContext, importBatchId)
      const versionText = profileVersionText(versions)
      if (versions.length > ERROR_EXPORT_CAP_V1) failCapacity()
      const rows: Array<Record<string, CatalogWorkbookValueV1>> = []
      const grains = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | null = null
      do {
        const page = await listErrorsPage(commandContext, { importBatchId, section: 'ERRORS', pageSize: PAGE_SIZE, cursor })
        if (!Array.isArray(page.rows) || page.rows.length > PAGE_SIZE || (page.rows.length === 0 && page.nextCursor)) return failData()
        for (const error of page.rows) {
          if (error.section !== 'ERRORS' || error.status !== 'INVALID') return failData()
          const sourceSheet = requiredText(error.sourceSheet)
          const sourceRow = error.sourceRow
          const column = requiredText(error.column)
          const errorCode = requiredText(error.errorCode)
          if (!Number.isSafeInteger(sourceRow) || (sourceRow as number) < 1 || (sourceRow as number) > 2_147_483_647) return failData()
          const grain = JSON.stringify([sourceSheet, sourceRow, column, errorCode])
          if (grains.has(grain)) return failData('El import contiene un grano de error durable duplicado.')
          grains.add(grain)
          rows.push({
            source_sheet: sourceSheet,
            source_row: sourceRow as number,
            column,
            error_code: errorCode,
            message: requiredText(error.message),
            rejected_value: truncateRejectedValue(error.rejectedValue),
            suggestion: optionalText(error.suggestion),
          })
          if (rows.length > ERROR_EXPORT_CAP_V1 - versions.length) failCapacity()
        }
        const next = page.nextCursor
        if (next !== null && (typeof next !== 'string' || !next || cursors.has(next))) return failData()
        if (next) cursors.add(next)
        cursor = next
      } while (cursor !== null)

      const errors: CatalogWorkbookSheetV1 = {
        name: 'Errors',
        grain: ['source_sheet', 'source_row', 'column', 'error_code'],
        columns: [
          { key: 'source_sheet', type: 'text' },
          { key: 'source_row', type: 'integer' },
          { key: 'column', type: 'text' },
          { key: 'error_code', type: 'enum' },
          { key: 'message', type: 'text' },
          { key: 'rejected_value', type: 'text' },
          { key: 'suggestion', type: 'text' },
        ],
        rows,
      }
      return {
        filename: 'import-errors-v1.xlsx',
        contentType: XLSX_MIME,
        buffer: await writeWorkbook({
          metadata: {
            schemaVersion: '1',
            organizationId: context.organizationId,
            generatedAt: now().toISOString(),
            timezone: 'America/Mexico_City',
            filters: JSON.stringify({ importBatchId }),
            profileVersion: versionText,
          },
          sheets: [errors],
        }),
      }
    },
  }
}

const catalogExportErrorsService = createCatalogExportErrorsService()
export const exportCatalogImportErrorsV1 = catalogExportErrorsService.catalogImportErrors
