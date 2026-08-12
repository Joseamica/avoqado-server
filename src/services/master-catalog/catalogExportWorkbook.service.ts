import AdmZip from 'adm-zip'
import AppError from '@/errors/AppError'
import { assertSafeXmlValue } from '@/workers/masterCatalogXmlSafety'

export const CATALOG_EXPORT_WORKBOOK_LIMITS_V1 = Object.freeze({
  maxSheets: 12,
  maxColumnsPerSheet: 40,
  maxDataRows: 5_000,
  maxCells: 180_000,
  maxTextLength: 32_767,
  maxXmlPartBytes: 8 * 1024 * 1024,
  maxAggregateXmlBytes: 32 * 1024 * 1024,
  maxZipBytes: 16 * 1024 * 1024,
  yieldEveryRows: 128,
})
export const CATALOG_EXPORT_METADATA_GRAIN_V1 = Object.freeze(['key', 'value'] as const)

export type CatalogWorkbookCellTypeV1 = 'text' | 'enum' | 'timestamp' | 'integer' | 'decimal2' | 'decimal4' | 'decimal6' | 'boolean'
export type CatalogWorkbookValueV1 = string | number | boolean | null

type CatalogWorkbookDecimalTypeV1 = Extract<CatalogWorkbookCellTypeV1, `decimal${number}`>
export type CatalogWorkbookColumnV1 =
  | { key: string; type: CatalogWorkbookDecimalTypeV1; precision: number }
  | { key: string; type: Exclude<CatalogWorkbookCellTypeV1, CatalogWorkbookDecimalTypeV1>; precision?: never }

export interface CatalogWorkbookSheetV1 {
  name: string
  grain: string[]
  columns: CatalogWorkbookColumnV1[]
  rows: Array<Record<string, CatalogWorkbookValueV1>>
}

export interface CatalogWorkbookMetadataV1 {
  documentType?: 'catalog-master-import'
  schemaVersion: string
  organizationId: string
  generatedAt: string
  timezone: string
  filters: string
  profileVersion: string
}

export interface CatalogWorkbookInputV1 {
  metadata: CatalogWorkbookMetadataV1
  sheets: CatalogWorkbookSheetV1[]
}

type CatalogWorkbookLimitsV1 = Record<keyof typeof CATALOG_EXPORT_WORKBOOK_LIMITS_V1, number>
interface CatalogZipAdapterV1 {
  addFile(name: string, content: Buffer): { header: { time: Date } }
  toBufferPromise(): Promise<Buffer>
}
export interface CatalogWorkbookWriterDependenciesV1 {
  limits?: Partial<CatalogWorkbookLimitsV1>
  createArchive?: () => CatalogZipAdapterV1
  yieldNow?: () => Promise<void>
}

const metadataKeys = [
  'schemaVersion',
  'organizationId',
  'generatedAt',
  'timezone',
  'filters',
  'profileVersion',
] as const satisfies ReadonlyArray<Exclude<keyof CatalogWorkbookMetadataV1, 'documentType'>>
const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

function exportError(message: string, code = 'CATALOG_EXPORT_INVALID', statusCode = 422, details?: unknown): AppError {
  return new AppError(message, statusCode, true, code, details)
}

function resolveLimits(overrides: Partial<CatalogWorkbookLimitsV1> = {}): CatalogWorkbookLimitsV1 {
  const limits = { ...CATALOG_EXPORT_WORKBOOK_LIMITS_V1, ...overrides }
  for (const key of Object.keys(CATALOG_EXPORT_WORKBOOK_LIMITS_V1) as Array<keyof CatalogWorkbookLimitsV1>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > CATALOG_EXPORT_WORKBOOK_LIMITS_V1[key]) {
      throw exportError('La configuración de límites XLSX no es válida.')
    }
  }
  return limits
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function safeText(value: CatalogWorkbookValueV1, limits: CatalogWorkbookLimitsV1): string {
  if (typeof value !== 'string') throw exportError('Una celda de texto del catálogo no es válida.')
  const neutralizesFormula = /^[=+\-@]/u.test(value)
  try {
    // WHY: Export and Task 7 import share one Unicode authority so generated
    // workbooks cannot carry XML noncharacters, lone surrogates, or bidi spoofing.
    // The leading apostrophe is emitted cell text, so it consumes one of
    // Excel's 32,767 Unicode-scalar slots.
    assertSafeXmlValue(value, limits.maxTextLength - (neutralizesFormula ? 1 : 0))
  } catch (error) {
    if ((error as { code?: unknown }).code === 'CATALOG_WORKBOOK_CELL_LIMIT') {
      throw exportError('Una celda de texto excede 32767 caracteres.', 'CATALOG_EXPORT_CELL_TOO_LARGE', 413)
    }
    throw exportError('Una celda contiene texto Unicode no permitido.')
  }
  return neutralizesFormula ? `'${value}` : value
}

function numericLexical(value: CatalogWorkbookValueV1, precision: number | null, scale: number | null): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw exportError('Una celda numérica del catálogo no es válida.')
  const raw = String(value)
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(raw)) throw exportError('Una celda numérica del catálogo no es válida.')
  const [integer, fraction = ''] = raw.split('.')
  if (scale === null) {
    if (fraction || !Number.isSafeInteger(Number(integer))) throw exportError('Una celda entera del catálogo no es válida.')
    return integer
  }
  if (precision === null || integer.replace(/^-/, '').length > precision - scale) {
    throw exportError(`Una celda excede la precisión decimal ${precision ?? 'declarada'}.`)
  }
  if (fraction.length > scale) throw exportError(`Una celda excede la escala decimal ${scale}.`)
  return `${integer}.${fraction.padEnd(scale, '0')}`
}

function columnReference(index: number): string {
  let current = index + 1
  let reference = ''
  while (current > 0) {
    current -= 1
    reference = String.fromCharCode(65 + (current % 26)) + reference
    current = Math.floor(current / 26)
  }
  return reference
}

function compareValue(left: CatalogWorkbookValueV1, right: CatalogWorkbookValueV1, type: CatalogWorkbookCellTypeV1): number {
  if (left === null || right === null) throw exportError('El grano de una hoja no puede contener valores vacíos.')
  if (type === 'integer' || type.startsWith('decimal')) return Number(left) - Number(right)
  if (typeof left !== typeof right) throw exportError('El grano de una hoja contiene tipos inconsistentes.')
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0
}

function validateSheetDefinition(sheet: CatalogWorkbookSheetV1, limits: CatalogWorkbookLimitsV1): void {
  if (!/^[^\\/?*[\]]{1,31}$/u.test(sheet.name)) throw exportError('El nombre de una hoja XLSX no es válido.')
  if (!sheet.columns.length || sheet.columns.length > limits.maxColumnsPerSheet) {
    throw exportError('La hoja excede el límite de 40 columnas.', 'CATALOG_EXPORT_CAP_EXCEEDED', 413)
  }
  const keys = sheet.columns.map(column => column.key)
  if (
    sheet.columns.some(column => {
      const scale = column.type === 'decimal2' ? 2 : column.type === 'decimal4' ? 4 : column.type === 'decimal6' ? 6 : null
      if (scale === null) return column.precision !== undefined
      const precision = column.precision
      return precision === undefined || !Number.isSafeInteger(precision) || precision <= scale || precision > 38
    })
  ) {
    throw exportError('La precisión de una columna decimal no es válida.')
  }
  if (new Set(keys).size !== keys.length || sheet.grain.length === 0 || sheet.grain.some(key => !keys.includes(key))) {
    throw exportError('Las columnas o el grano de la hoja no son válidos.')
  }
}

function validateAndSortSheet(sheet: CatalogWorkbookSheetV1, limits: CatalogWorkbookLimitsV1): CatalogWorkbookSheetV1 {
  validateSheetDefinition(sheet, limits)
  const keys = sheet.columns.map(column => column.key)
  const allowed = new Set(keys)
  const columnByKey = new Map(sheet.columns.map(column => [column.key, column]))
  const rows = sheet.rows.map(row => {
    if (Object.keys(row).some(key => !allowed.has(key))) throw exportError('Una fila contiene columnas no declaradas.')
    return { ...row }
  })
  rows.sort((left, right) => {
    for (const key of sheet.grain) {
      const comparison = compareValue(left[key] ?? null, right[key] ?? null, columnByKey.get(key)!.type)
      if (comparison !== 0) return comparison
    }
    return 0
  })
  const grains = rows.map(row => JSON.stringify(sheet.grain.map(key => row[key])))
  if (new Set(grains).size !== grains.length) throw exportError('La hoja contiene granos duplicados.')
  return { ...sheet, rows }
}

async function preflightSheets(
  sheets: CatalogWorkbookSheetV1[],
  metadata: CatalogWorkbookSheetV1,
  limits: CatalogWorkbookLimitsV1,
  yieldNow: () => Promise<void>,
): Promise<void> {
  let dataRows = 0
  let cells = (metadata.rows.length + 1) * metadata.columns.length
  for (const sheet of sheets) {
    dataRows += sheet.rows.length
    cells += (sheet.rows.length + 1) * sheet.columns.length
    if (dataRows > limits.maxDataRows || cells > limits.maxCells) {
      throw exportError(
        `La exportación excede el límite de ${limits.maxDataRows} filas; reduce el filtro y vuelve a intentar.`,
        'CATALOG_EXPORT_CAP_EXCEEDED',
        413,
        { maxRows: limits.maxDataRows, maxCells: limits.maxCells },
      )
    }
  }

  let rowsScanned = 0
  for (const sheet of [metadata, ...sheets]) {
    safeText(sheet.name, limits)
    for (let columnIndex = 0; columnIndex < sheet.columns.length; columnIndex += 1) {
      safeText(sheet.columns[columnIndex].key, limits)
    }
    // WHY: Index loops deliberately avoid caller-controlled map/iterators;
    // every text cap is classified before clone/sort/XML allocation.
    for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
      const row = sheet.rows[rowIndex]
      for (let columnIndex = 0; columnIndex < sheet.columns.length; columnIndex += 1) {
        const column = sheet.columns[columnIndex]
        const value = row[column.key] ?? null
        if (value !== null && (column.type === 'text' || column.type === 'enum' || column.type === 'timestamp')) safeText(value, limits)
      }
      rowsScanned += 1
      if (rowsScanned % limits.yieldEveryRows === 0) await yieldNow()
    }
  }
}

function cellXml(
  column: CatalogWorkbookColumnV1,
  value: CatalogWorkbookValueV1,
  reference: string,
  limits: CatalogWorkbookLimitsV1,
): string {
  if (value === null) return `<c r="${reference}"/>`
  if (column.type === 'text' || column.type === 'enum' || column.type === 'timestamp') {
    return `<c r="${reference}" s="5" t="inlineStr"><is><t xml:space="preserve">${escapeXml(safeText(value, limits))}</t></is></c>`
  }
  if (column.type === 'boolean') {
    if (typeof value !== 'boolean') throw exportError('Una celda booleana del catálogo no es válida.')
    return `<c r="${reference}" t="b"><v>${value ? '1' : '0'}</v></c>`
  }
  const scale = column.type === 'integer' ? null : column.type === 'decimal2' ? 2 : column.type === 'decimal4' ? 4 : 6
  const style = column.type === 'integer' ? 1 : column.type === 'decimal2' ? 2 : column.type === 'decimal4' ? 3 : 4
  return `<c r="${reference}" s="${style}"><v>${numericLexical(value, column.type === 'integer' ? null : (column.precision ?? null), scale)}</v></c>`
}

async function worksheetXml(
  sheet: CatalogWorkbookSheetV1,
  limits: CatalogWorkbookLimitsV1,
  yieldNow: () => Promise<void>,
): Promise<string> {
  const lastColumn = columnReference(sheet.columns.length - 1)
  const prefix = `${xmlDeclaration}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${sheet.rows.length + 1}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>`
  const suffix = '</sheetData></worksheet>'
  const rowXml = [
    `<row r="1">${sheet.columns
      .map((column, index) => cellXml({ key: column.key, type: 'text' }, column.key, `${columnReference(index)}1`, limits))
      .join('')}</row>`,
  ]
  let xmlBytes = Buffer.byteLength(prefix) + Buffer.byteLength(rowXml[0]) + Buffer.byteLength(suffix)
  for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
    const number = rowIndex + 2
    const row = sheet.rows[rowIndex]
    const xml = `<row r="${number}">${sheet.columns
      .map((column, columnIndex) => cellXml(column, row[column.key] ?? null, `${columnReference(columnIndex)}${number}`, limits))
      .join('')}</row>`
    xmlBytes += Buffer.byteLength(xml)
    if (xmlBytes > limits.maxXmlPartBytes) {
      throw exportError(`La hoja ${sheet.name} excede el límite XML permitido.`, 'CATALOG_EXPORT_CAP_EXCEEDED', 413)
    }
    rowXml.push(xml)
    if ((rowIndex + 1) % limits.yieldEveryRows === 0) await yieldNow()
  }
  return `${prefix}${rowXml.join('')}${suffix}`
}

function stylesXml(): string {
  return `${xmlDeclaration}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="0.00"/><numFmt numFmtId="165" formatCode="0.0000"/><numFmt numFmtId="166" formatCode="0.000000"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
}

function workbookParts(sheetNames: string[], generatedAt: string): Record<string, string> {
  const sheets = sheetNames
    .map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('')
  const relationships = sheetNames
    .map(
      (_name, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join('')
  const overrides = sheetNames
    .map(
      (_name, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('')
  return {
    '[Content_Types].xml': `${xmlDeclaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${overrides}</Types>`,
    '_rels/.rels': `${xmlDeclaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    'docProps/core.xml': `${xmlDeclaration}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/"><dcterms:created xsi:type="dcterms:W3CDTF" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${escapeXml(generatedAt)}</dcterms:created></cp:coreProperties>`,
    'xl/workbook.xml': `${xmlDeclaration}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets><calcPr calcMode="manual"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `${xmlDeclaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}<Relationship Id="rId${sheetNames.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': stylesXml(),
  }
}

export function createCatalogWorkbookWriterV1(dependencies: CatalogWorkbookWriterDependenciesV1 = {}) {
  const limits = resolveLimits(dependencies.limits)
  const createArchive = dependencies.createArchive ?? (() => new AdmZip() as unknown as CatalogZipAdapterV1)
  const yieldNow = dependencies.yieldNow ?? (() => new Promise<void>(resolve => setImmediate(resolve)))

  return async (input: CatalogWorkbookInputV1): Promise<Buffer> => {
    const generatedAt = new Date(input.metadata.generatedAt)
    if (Number.isNaN(generatedAt.getTime()) || generatedAt.toISOString() !== input.metadata.generatedAt) {
      throw exportError('generatedAt debe ser RFC3339 UTC.')
    }
    const allowedMetadataKeys = new Set<string>([...metadataKeys, 'documentType'])
    if (
      input.metadata.timezone !== 'America/Mexico_City' ||
      metadataKeys.some(key => typeof input.metadata[key] !== 'string') ||
      Object.keys(input.metadata).some(key => !allowedMetadataKeys.has(key)) ||
      (input.metadata.documentType !== undefined && input.metadata.documentType !== 'catalog-master-import')
    ) {
      throw exportError('Los metadatos del libro no son válidos.')
    }
    if (input.sheets.length > limits.maxSheets - 1) {
      throw exportError('El libro excede el límite de 12 hojas.', 'CATALOG_EXPORT_CAP_EXCEEDED', 413)
    }
    // WHY: Length/cell guards precede row cloning, sorting, or XML allocation;
    // a caller can never make an over-cap request expensive before its 413.
    const metadataRows: Array<Record<string, CatalogWorkbookValueV1>> = [
      ...(input.metadata.documentType ? [{ key: 'documentType', value: input.metadata.documentType }] : []),
      ...metadataKeys.map(key => ({ key, value: input.metadata[key] })),
    ]
    const metadata: CatalogWorkbookSheetV1 = {
      name: 'Metadata',
      grain: [...CATALOG_EXPORT_METADATA_GRAIN_V1],
      columns: [
        { key: 'key', type: 'text' },
        { key: 'value', type: 'text' },
      ],
      rows: metadataRows,
    }
    const sheets = [metadata, ...input.sheets]
    for (const sheet of sheets) validateSheetDefinition(sheet, limits)
    if (new Set(sheets.map(sheet => sheet.name)).size !== sheets.length) {
      throw exportError('El libro contiene nombres de hoja duplicados.')
    }
    await preflightSheets(input.sheets, metadata, limits, yieldNow)
    const parts = workbookParts(
      sheets.map(sheet => sheet.name),
      input.metadata.generatedAt,
    )
    let aggregateXmlBytes = 0
    for (const [name, xml] of Object.entries(parts)) {
      const bytes = Buffer.byteLength(xml)
      if (bytes > limits.maxXmlPartBytes) {
        throw exportError(`La parte XLSX ${name} excede el límite permitido.`, 'CATALOG_EXPORT_CAP_EXCEEDED', 413)
      }
      aggregateXmlBytes += bytes
      if (aggregateXmlBytes > limits.maxAggregateXmlBytes) {
        throw exportError('La exportación XLSX excede el límite de memoria permitido.', 'CATALOG_EXPORT_CAP_EXCEEDED', 413)
      }
    }
    // WHY: Sort and materialize one worksheet at a time. An aggregate cap hit
    // cannot force later caller rows to be cloned or retained first.
    for (let index = 0; index < sheets.length; index += 1) {
      const name = `xl/worksheets/sheet${index + 1}.xml`
      const xml = await worksheetXml(validateAndSortSheet(sheets[index], limits), limits, yieldNow)
      const bytes = Buffer.byteLength(xml)
      if (bytes > limits.maxXmlPartBytes) {
        throw exportError(`La parte XLSX ${name} excede el límite permitido.`, 'CATALOG_EXPORT_CAP_EXCEEDED', 413)
      }
      aggregateXmlBytes += bytes
      if (aggregateXmlBytes > limits.maxAggregateXmlBytes) {
        throw exportError('La exportación XLSX excede el límite de memoria permitido.', 'CATALOG_EXPORT_CAP_EXCEEDED', 413)
      }
      parts[name] = xml
    }
    const zip = createArchive()
    for (const [name, xml] of Object.entries(parts)) {
      const entry = zip.addFile(name, Buffer.from(xml, 'utf8'))
      entry.header.time = generatedAt
    }
    const buffer = await zip.toBufferPromise()
    if (buffer.length > limits.maxZipBytes) {
      throw exportError('La exportación XLSX excede 16 MiB; reduce el filtro y vuelve a intentar.', 'CATALOG_EXPORT_CAP_EXCEEDED', 413)
    }
    return buffer
  }
}

export const writeCatalogWorkbookV1 = createCatalogWorkbookWriterV1()
