import { CatalogIepsMode, Unit } from '@prisma/client'
import type { ParsedWorkbookCell, ParsedWorkbookRow } from '../../workers/masterCatalogXlsx.worker'
import { parseCatalogMoney } from './catalogMoney.service'
import {
  parseCatalogUnsignedDecimal,
  validateCatalogCurrencyV1,
  validateCatalogExpectedRevision,
  validateCatalogIepsFieldsV1,
  validateCatalogImageUrlV1,
  validateCatalogObjetoImpV1,
  validateCatalogSatProductKeyV1,
  validateCatalogSatUnitKeyV1,
} from './catalogItemValidation.service'
import type { CatalogImportRowError, CatalogImportStagedLine } from './catalogImport.types'
import type { CatalogImportCooperativeCheckpoint } from './catalogImportCanonical.service'

const SAFE_REJECTED_VALUE_LENGTH = 128
const SAFE_FINDING_MESSAGES: Readonly<Record<string, string>> = {
  CATALOG_BASELINE_INCOMPLETE: 'Falta un valor obligatorio para completar el artículo.',
  CATALOG_BINDING_ACTION_INVALID: 'La acción solicitada debe ser LINK, CREATE o SKIP.',
  CATALOG_BINDING_REQUEST_INCOMPLETE: 'La solicitud de vínculo no tiene todos los campos requeridos.',
  CATALOG_CODE_MUST_BE_TEXT: 'La celda debe contener texto no vacío.',
  CATALOG_CURRENCY_INVALID: 'La moneda debe ser un código ISO-4217 válido en mayúsculas.',
  CATALOG_DECIMAL_INVALID: 'El decimal tiene precisión o rango inválido.',
  CATALOG_IEPS_INVALID: 'Los campos IEPS no coinciden con el modo solicitado.',
  CATALOG_IMPORT_VALIDATOR_DRIFT: 'El importador no pudo clasificar una regla vigente del catálogo.',
  CATALOG_MONEY_INVALID: 'El importe debe cumplir el formato monetario Decimal(10,2).',
  CATALOG_OBJETO_IMP_INVALID: 'ObjetoImp no pertenece al conjunto CFDI permitido.',
  CATALOG_SAT_PRODUCT_KEY_INVALID: 'La clave SAT de producto debe contener ocho dígitos.',
  CATALOG_SAT_UNIT_KEY_INVALID: 'La clave SAT de unidad no cumple el formato permitido.',
  CATALOG_TARGET_NOT_FOUND: 'El recurso solicitado no existe dentro de la organización y venue esperados.',
  CATALOG_UNIT_INVALID: 'La unidad no pertenece al catálogo permitido.',
  CATALOG_VALUE_PAIR_REQUIRED: 'Cada moneda debe incluir un precio de venta y un costo de compra.',
  CATALOG_WORKBOOK_DUPLICATE: 'La identidad ya aparece en otra fila del mismo workbook.',
}
const findingKeysByTarget = new WeakMap<CatalogImportRowError[], Set<string>>()

function findingKey(sheet: string, row: number, column: string, code: string): string {
  return `${sheet}:${row}:${column}:${code}`
}

function findingKeys(errors: CatalogImportRowError[]): Set<string> {
  let keys = findingKeysByTarget.get(errors)
  if (!keys) {
    keys = new Set(errors.map(error => findingKey(error.source_sheet, error.source_row, error.column, error.error_code)))
    findingKeysByTarget.set(errors, keys)
  }
  return keys
}

function safeRejected(cell: ParsedWorkbookCell | undefined): string | undefined {
  // WHY: Diagnostics retain enough context to repair a row but cap sensitive
  // codes and prices at whole Unicode scalars before staging/API serialization.
  if (!cell || cell.kind === 'BLANK') return undefined
  let excerpt = ''
  let scalars = 0
  for (const scalar of cell.value) {
    const codePoint = scalar.codePointAt(0) as number
    // WHY: The worker rejects these values, but this pure boundary remains
    // safe under forged tests/callers and never emits invalid PostgreSQL JSON.
    if (codePoint === 0 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined
    if (scalars === SAFE_REJECTED_VALUE_LENGTH) break
    excerpt += scalar
    scalars += 1
  }
  return excerpt
}

export function addCatalogImportFinding(
  errors: CatalogImportRowError[],
  sheet: string,
  row: number,
  column: string,
  code: string,
  cell?: ParsedWorkbookCell,
  suggestion = 'Corrige la celda y vuelve a generar el preview.',
): void {
  const rejectedValue = safeRejected(cell)
  // WHY: Every staged/API finding is deterministic, human-readable, and omits
  // undefined fields so strict canonical hashing cannot diverge by serializer.
  errors.push({
    source_sheet: sheet,
    source_row: row,
    column,
    error_code: code,
    ...(rejectedValue === undefined ? {} : { rejected_value: rejectedValue }),
    message: SAFE_FINDING_MESSAGES[code] ?? `El campo ${column} no cumple la regla de importación indicada.`,
    suggestion,
  })
  findingKeys(errors).add(findingKey(sheet, row, column, code))
}

export function addCatalogImportFindingOnce(
  errors: CatalogImportRowError[],
  sheet: string,
  row: number,
  column: string,
  code: string,
  cell?: ParsedWorkbookCell,
  suggestion?: string,
): void {
  // WHY: Leaf and aggregate Task 5 validators may classify the same field;
  // staging keeps one actionable finding per coordinate/code.
  const exists = findingKeys(errors).has(findingKey(sheet, row, column, code))
  if (!exists) addCatalogImportFinding(errors, sheet, row, column, code, cell, suggestion)
}

export async function appendCatalogImportStandaloneErrorLines(
  staged: CatalogImportStagedLine[],
  errors: CatalogImportRowError[],
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<void> {
  const stagedRowsBySheet = new Map<string, Set<number>>()
  let visited = 0
  for (const line of staged) {
    const rows = stagedRowsBySheet.get(line.sourceSheet) ?? new Set<number>()
    rows.add(line.sourceRow)
    stagedRowsBySheet.set(line.sourceSheet, rows)
    visited += 1
    if (visited % 64 === 0) await checkpoint()
  }
  const grouped = new Map<string, CatalogImportRowError[]>()
  for (const error of errors) {
    // WHY: Most validation findings already belong to a durable staged line.
    // Avoid allocating a second 400k-entry grouping only to discard it later;
    // under a warm server that redundant allocation can itself trigger a
    // main-thread GC pause beyond the 50 ms event-loop budget.
    if (stagedRowsBySheet.get(error.source_sheet)?.has(error.source_row)) {
      visited += 1
      if (visited % 64 === 0) await checkpoint()
      continue
    }
    const key = `${error.source_sheet}:${error.source_row}`
    const findings = grouped.get(key) ?? []
    findings.push(error)
    grouped.set(key, findings)
    visited += 1
    if (visited % 64 === 0) await checkpoint()
  }
  // WHY: A single grouping pass avoids quadratic error scans for a hostile
  // workbook while preserving one durable line per source coordinate.
  for (const findings of grouped.values()) {
    await checkpoint()
    const error = findings[0]
    if (!error) continue
    staged.push({
      sourceSheet: error.source_sheet,
      sourceRow: error.source_row,
      status: 'INVALID',
      payload: { schemaVersion: 1 },
      errors: findings,
      catalogItemId: null,
    })
  }
}

export function readCatalogImportText(
  errors: CatalogImportRowError[],
  sheet: string,
  row: ParsedWorkbookRow,
  column: string,
  optional = false,
): string | null {
  const cell = row.values[column]
  if (cell?.kind === 'BLANK' && optional) return null
  if (cell?.kind !== 'TEXT' || !cell.value.trim()) {
    addCatalogImportFinding(errors, sheet, row.sourceRow, column, 'CATALOG_CODE_MUST_BE_TEXT', cell, 'Usa una celda de texto no vacía.')
    return null
  }
  return cell.value
}

export function readCatalogImportDecimal(
  errors: CatalogImportRowError[],
  sheet: string,
  row: ParsedWorkbookRow,
  column: string,
  optional = false,
): string | null {
  const cell = row.values[column]
  if (cell?.kind === 'BLANK' && optional) return null
  if (cell?.kind !== 'NUMBER' || !/^\d+(?:\.\d+)?$/u.test(cell.value)) {
    addCatalogImportFinding(
      errors,
      sheet,
      row.sourceRow,
      column,
      'CATALOG_DECIMAL_INVALID',
      cell,
      'Usa una celda decimal ordinaria, sin exponente.',
    )
    return null
  }
  return cell.value
}

export function readCatalogImportRevision(
  errors: CatalogImportRowError[],
  sheet: string,
  row: ParsedWorkbookRow,
  column: string,
  optional = false,
): number | null {
  const raw = readCatalogImportDecimal(errors, sheet, row, column, optional)
  if (raw === null) return null
  if (!/^\d+$/u.test(raw)) {
    addCatalogImportFinding(
      errors,
      sheet,
      row.sourceRow,
      column,
      'CATALOG_REVISION_INVALID',
      row.values[column],
      'Usa una revisión entera positiva.',
    )
    return null
  }
  try {
    return validateCatalogExpectedRevision(Number(raw), column)
  } catch {
    addCatalogImportFinding(
      errors,
      sheet,
      row.sourceRow,
      column,
      'CATALOG_REVISION_INVALID',
      row.values[column],
      'Usa una revisión entera positiva vigente.',
    )
    return null
  }
}

export function validateCatalogImportMoneyCell(
  errors: CatalogImportRowError[],
  sheet: string,
  row: ParsedWorkbookRow,
  column: string,
  value: string,
): string | null {
  // WHY: Decimal(10,2) validation consumes the raw lexical string and never
  // crosses a JavaScript number before staging or hashing.
  try {
    return parseCatalogMoney(value)
  } catch {
    addCatalogImportFindingOnce(errors, sheet, row.sourceRow, column, 'CATALOG_MONEY_INVALID', row.values[column])
    return null
  }
}

export function validateCatalogImportCurrencyCell(
  errors: CatalogImportRowError[],
  sheet: string,
  row: ParsedWorkbookRow,
  column: string,
  value: string,
  expected?: unknown,
): boolean {
  // WHY: CREATE bindings must use both frozen ISO-4217 membership and the live
  // Venue currency; there is no fallback or FX inference in the preview.
  try {
    validateCatalogCurrencyV1(value)
    if (expected !== undefined && expected !== value) throw new Error('currency mismatch')
    return true
  } catch {
    addCatalogImportFindingOnce(errors, sheet, row.sourceRow, column, 'CATALOG_CURRENCY_INVALID', row.values[column])
    return false
  }
}

interface CatalogImportItemFiscalInput {
  imageUrl: string
  unit: Unit
  taxRate: string
  satProductKey: string
  satUnitKey: string
  objetoImp: string
  iepsMode: CatalogIepsMode
  iepsRate: string | null
  iepsQuota: string | null
  iepsQuotaUnit: Unit | null
}

export function addCatalogImportItemFieldFindings(
  input: CatalogImportItemFiscalInput,
  row: ParsedWorkbookRow,
  errors: CatalogImportRowError[],
): void {
  // WHY: Import preview reports independent field failures in one pass while
  // delegating every acceptance rule to Task 5's pure validators.
  const checks: Array<{ column: string; run: () => unknown; fallback: string }> = [
    { column: 'image_url', run: () => validateCatalogImageUrlV1(input.imageUrl), fallback: 'CATALOG_IMAGE_URL_INVALID' },
    {
      column: 'unit',
      run: () => {
        if (!Object.values(Unit).includes(input.unit)) throw Object.assign(new Error('invalid unit'), { code: 'CATALOG_UNIT_INVALID' })
      },
      fallback: 'CATALOG_UNIT_INVALID',
    },
    {
      column: 'iva_rate',
      run: () => parseCatalogUnsignedDecimal(input.taxRate, 4, '1.0000', 'taxRate'),
      fallback: 'CATALOG_DECIMAL_INVALID',
    },
    {
      column: 'sat_product_key',
      run: () => validateCatalogSatProductKeyV1(input.satProductKey),
      fallback: 'CATALOG_SAT_PRODUCT_KEY_INVALID',
    },
    { column: 'sat_unit_key', run: () => validateCatalogSatUnitKeyV1(input.satUnitKey), fallback: 'CATALOG_SAT_UNIT_KEY_INVALID' },
    { column: 'objeto_imp', run: () => validateCatalogObjetoImpV1(input.objetoImp), fallback: 'CATALOG_OBJETO_IMP_INVALID' },
  ]
  for (const check of checks) {
    try {
      check.run()
    } catch (error) {
      addCatalogImportFindingOnce(
        errors,
        'Items',
        row.sourceRow,
        check.column,
        (error as { code?: string }).code ?? check.fallback,
        row.values[check.column],
      )
    }
  }

  // WHY: IEPS rate, quota, and quota-unit are independent repair targets.
  // Validate their leaf boundaries first, then attribute only the cross-field
  // combination to ieps_mode when every submitted leaf is individually valid.
  let iepsLeavesValid = true
  const iepsLeafChecks: Array<{ column: string; run: () => unknown; fallback: string }> = [
    ...(input.iepsRate === null
      ? []
      : [
          {
            column: 'ieps_rate',
            run: () => parseCatalogUnsignedDecimal(input.iepsRate, 6, '1.000000', 'iepsRate'),
            fallback: 'CATALOG_DECIMAL_INVALID',
          },
        ]),
    ...(input.iepsQuota === null
      ? []
      : [
          {
            column: 'ieps_quota',
            run: () => parseCatalogUnsignedDecimal(input.iepsQuota, 4, '99999999.9999', 'iepsQuota'),
            fallback: 'CATALOG_DECIMAL_INVALID',
          },
        ]),
    ...(input.iepsQuotaUnit === null
      ? []
      : [
          {
            column: 'ieps_quota_unit',
            run: () => {
              if (!Object.values(Unit).includes(input.iepsQuotaUnit as Unit)) {
                throw Object.assign(new Error('invalid IEPS quota unit'), { code: 'CATALOG_IEPS_INVALID' })
              }
            },
            fallback: 'CATALOG_IEPS_INVALID',
          },
        ]),
  ]
  for (const check of iepsLeafChecks) {
    try {
      check.run()
    } catch (error) {
      iepsLeavesValid = false
      addCatalogImportFindingOnce(
        errors,
        'Items',
        row.sourceRow,
        check.column,
        (error as { code?: string }).code ?? check.fallback,
        row.values[check.column],
      )
    }
  }
  const modeValid = Object.values(CatalogIepsMode).includes(input.iepsMode)
  if (!modeValid) {
    addCatalogImportFindingOnce(errors, 'Items', row.sourceRow, 'ieps_mode', 'CATALOG_IEPS_INVALID', row.values.ieps_mode)
  } else if (iepsLeavesValid) {
    try {
      validateCatalogIepsFieldsV1(input)
    } catch {
      addCatalogImportFindingOnce(errors, 'Items', row.sourceRow, 'ieps_mode', 'CATALOG_IEPS_INVALID', row.values.ieps_mode)
    }
  }
}
