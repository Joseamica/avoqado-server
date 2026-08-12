import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { preflightOoxmlPackage, readXmlPart } from './masterCatalogOoxmlPreflight'
import { parseSharedStringsXml, parseWorksheetXml } from './masterCatalogWorksheetXml'
import { failWorkbook } from './masterCatalogXmlSafety'

export type ParsedWorkbookCell =
  | { kind: 'TEXT'; value: string }
  | { kind: 'NUMBER'; value: string }
  | { kind: 'BOOLEAN'; value: string }
  | { kind: 'BLANK'; value: '' }

export interface ParsedWorkbookRow {
  sourceRow: number
  values: Record<string, ParsedWorkbookCell>
}

export interface ParsedWorkbookSheet {
  columns: string[]
  rows: ParsedWorkbookRow[]
}

export interface ParsedMasterCatalogWorkbook {
  sheetNames: string[]
  sheets: Record<string, ParsedWorkbookSheet>
}

export interface MasterCatalogWorkbookLimits {
  readonly maxCompressedBytes: number
  readonly maxZipEntries: number
  readonly maxExpandedBytes: number
  readonly maxCompressionRatio: number
  readonly maxSheets: number
  readonly maxTotalRows: number
  readonly maxRowsPerSheet: number
  readonly maxColumns: number
  readonly maxCellCharacters: number
}

// WHY: These frozen caps bound every attacker-controlled amplification axis
// before any worksheet value reaches catalog validation or persistence.
export const DEFAULT_MASTER_CATALOG_WORKBOOK_LIMITS: MasterCatalogWorkbookLimits = Object.freeze({
  maxCompressedBytes: 10 * 1024 * 1024,
  maxZipEntries: 128,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxSheets: 5,
  maxTotalRows: 50_000,
  maxRowsPerSheet: 20_000,
  maxColumns: 64,
  maxCellCharacters: 4_096,
})

// WHY: Import columns are a closed write contract; export-only and future
// server-owned columns cannot be smuggled into an H1A workbook.
export const MASTER_CATALOG_IMPORT_HEADERS = {
  Metadata: ['key', 'value'],
  Items: [
    'operation',
    'catalog_item_id',
    'expected_revision',
    'corporate_sku',
    'item_kind',
    'name',
    'description',
    'image_url',
    'brand',
    'manufacturer',
    'family',
    'subfamily',
    'presentation',
    'unit',
    'product_type',
    'iva_rate',
    'sat_product_key',
    'sat_unit_key',
    'objeto_imp',
    'ieps_mode',
    'ieps_rate',
    'ieps_quota',
    'ieps_quota_unit',
  ],
  OrganizationValues: ['corporate_sku', 'value_type', 'amount', 'currency', 'expected_rule_revision'],
  BusinessTypes: ['corporate_sku', 'business_type'],
  VenueBindingRequests: [
    'corporate_sku',
    'venue_id',
    'requested_action',
    'product_id',
    'local_sku',
    'category_id',
    'initial_price',
    'currency',
  ],
} as const

type MasterCatalogSheetName = keyof typeof MASTER_CATALOG_IMPORT_HEADERS

function assertExactSheets(sheets: Array<{ name: string; path: string }>, limits: MasterCatalogWorkbookLimits): void {
  const allowed = Object.keys(MASTER_CATALOG_IMPORT_HEADERS)
  const names = sheets.map(sheet => sheet.name)
  if (
    sheets.length !== allowed.length ||
    sheets.length > limits.maxSheets ||
    new Set(names).size !== names.length ||
    new Set(sheets.map(sheet => sheet.path)).size !== sheets.length ||
    names.some(name => !allowed.includes(name)) ||
    allowed.some(name => !names.includes(name))
  ) {
    failWorkbook('CATALOG_WORKBOOK_SHEET_INVALID')
  }
}

export function parseMasterCatalogXlsxBuffer(
  buffer: Buffer,
  limitOverrides: Partial<MasterCatalogWorkbookLimits> = {},
): ParsedMasterCatalogWorkbook {
  const limits = { ...DEFAULT_MASTER_CATALOG_WORKBOOK_LIMITS, ...limitOverrides }
  const ooxml = preflightOoxmlPackage(buffer, limits)
  assertExactSheets(ooxml.sheets, limits)
  const sharedStrings = ooxml.sharedStringsPath ? parseSharedStringsXml(readXmlPart(ooxml.zip, ooxml.sharedStringsPath), limits) : []
  const parsedSheets: Record<string, ParsedWorkbookSheet> = {}
  let totalRows = 0
  for (const sheet of ooxml.sheets) {
    const expectedHeaders = MASTER_CATALOG_IMPORT_HEADERS[sheet.name as MasterCatalogSheetName]
    const parsed = parseWorksheetXml(
      readXmlPart(ooxml.zip, sheet.path),
      expectedHeaders,
      sharedStrings,
      limits,
      limits.maxTotalRows - totalRows,
    )
    totalRows += parsed.physicalRows
    parsedSheets[sheet.name] = parsed.sheet
  }
  return { sheetNames: ooxml.sheets.map(sheet => sheet.name), sheets: parsedSheets }
}

interface WorkerRequest {
  task: 'parse-master-catalog-xlsx'
  bytes: ArrayBuffer
}

// WHY: Only one tagged task activates parsing, and the worker posts exactly
// one complete serializable result or one safe failure—never partial rows.
if (!isMainThread && (workerData as WorkerRequest | undefined)?.task === 'parse-master-catalog-xlsx') {
  try {
    const parsed = parseMasterCatalogXlsxBuffer(Buffer.from((workerData as WorkerRequest).bytes))
    parentPort?.postMessage({ ok: true, parsed })
  } catch (error) {
    const safe = error as { code?: string; statusCode?: number }
    parentPort?.postMessage({
      ok: false,
      error: {
        code: safe.code ?? 'CATALOG_WORKBOOK_WORKER_FAILED',
        statusCode: safe.statusCode ?? 400,
        message: 'El archivo XLSX de catálogo no es válido.',
      },
    })
  }
}
