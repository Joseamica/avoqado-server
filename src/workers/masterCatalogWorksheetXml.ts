import type { MasterCatalogWorkbookLimits, ParsedWorkbookCell, ParsedWorkbookSheet } from './masterCatalogXlsx.worker'
import { assertSafeXmlValue, decodeXmlText, failWorkbook, scanXml, type XmlElement, xmlAttribute } from './masterCatalogXmlSafety'

const MAX_SOURCE_ROW = 2_147_483_647
const SPREADSHEET_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

function isFormattingWhitespace(raw: string): boolean {
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false
  }
  return true
}

function isSpreadsheetElement(element: XmlElement, name: string, depth: number, parent: string | null): boolean {
  return (
    element.localName === name &&
    element.namespaceUri === SPREADSHEET_NAMESPACE &&
    element.depth === depth &&
    element.parentLocalName === parent &&
    (depth === 0 || element.parentNamespaceUri === SPREADSHEET_NAMESPACE)
  )
}

function parseBoundedInteger(raw: string, maximum: number, code: string): number {
  if (!raw) failWorkbook(code)
  let value = 0
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw.charCodeAt(index)
    if (character < 0x30 || character > 0x39) failWorkbook(code)
    value = value * 10 + character - 0x30
    if (value > maximum) failWorkbook(code)
  }
  return value
}

function cellCoordinates(reference: string): { column: number; row: number } {
  let cursor = 0
  let column = 0
  while (cursor < reference.length) {
    const code = reference.charCodeAt(cursor)
    if (code < 0x41 || code > 0x5a) break
    column = column * 26 + code - 0x40
    if (column > 16_384) failWorkbook('CATALOG_WORKBOOK_CELL_REFERENCE_INVALID')
    cursor += 1
  }
  if (cursor === 0) failWorkbook('CATALOG_WORKBOOK_CELL_REFERENCE_INVALID')
  const row = parseBoundedInteger(reference.slice(cursor), MAX_SOURCE_ROW, 'CATALOG_WORKBOOK_CELL_REFERENCE_INVALID')
  if (row < 1) failWorkbook('CATALOG_WORKBOOK_CELL_REFERENCE_INVALID')
  return { column, row }
}

function isPlainDecimal(value: string): boolean {
  let cursor = value.charCodeAt(0) === 0x2d ? 1 : 0
  const integerStart = cursor
  while (cursor < value.length && value.charCodeAt(cursor) >= 0x30 && value.charCodeAt(cursor) <= 0x39) cursor += 1
  if (cursor === integerStart) return false
  if (cursor === value.length) return true
  if (value.charCodeAt(cursor) !== 0x2e) return false
  cursor += 1
  const decimalStart = cursor
  while (cursor < value.length && value.charCodeAt(cursor) >= 0x30 && value.charCodeAt(cursor) <= 0x39) cursor += 1
  return cursor === value.length && cursor > decimalStart
}

function assertTextCell(value: string, limits: MasterCatalogWorkbookLimits): void {
  assertSafeXmlValue(value, limits.maxCellCharacters)
  const first = value.trimStart().charCodeAt(0)
  if (first === 0x3d || first === 0x2b || first === 0x2d || first === 0x40) {
    failWorkbook('CATALOG_WORKBOOK_FORMULA_LIKE_FORBIDDEN')
  }
}

function decodeBoundedCellText(raw: string, limits: MasterCatalogWorkbookLimits): string {
  // WHY: The longest accepted numeric character reference is bounded, so a
  // source chunk far larger than 12x the decoded character cap cannot become a
  // valid cell. Fail before decoding/materializing that hostile value.
  if (raw.length > limits.maxCellCharacters * 12) failWorkbook('CATALOG_WORKBOOK_CELL_LIMIT')
  return decodeXmlText(raw, limits.maxCellCharacters)
}

export function parseSharedStringsXml(xml: string, limits: MasterCatalogWorkbookLimits): string[] {
  const strings: string[] = []
  const maximumStrings = limits.maxTotalRows * limits.maxColumns
  let current: string | null = null
  let inText = false
  let textSeen = false
  let sawRoot = false

  scanXml(xml, {
    start(element) {
      if (element.localName === 'f') failWorkbook('CATALOG_WORKBOOK_FORMULA_FORBIDDEN')
      if (element.depth === 0) {
        if (sawRoot || !isSpreadsheetElement(element, 'sst', 0, null)) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
        sawRoot = true
      } else if (isSpreadsheetElement(element, 'si', 1, 'sst')) {
        if (current !== null || strings.length >= maximumStrings) failWorkbook('CATALOG_WORKBOOK_ROW_LIMIT')
        current = ''
        textSeen = false
        if (element.selfClosing) {
          strings.push('')
          current = null
        }
      } else if (current !== null) {
        // WHY: The importer supports one plain `<t>` child per shared string.
        // Rejecting rich/unknown descendants prevents unparsed content from
        // existing beside the value later covered by the workbook hash.
        if (!isSpreadsheetElement(element, 't', 2, 'si') || inText || textSeen) {
          failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
        }
        textSeen = true
        inText = !element.selfClosing
      } else {
        failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
      }
    },
    text(rawText) {
      if (current === null) {
        if (!isFormattingWhitespace(rawText)) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
        return
      }
      if (!inText) {
        if (!isFormattingWhitespace(rawText)) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
        return
      }
      current += decodeBoundedCellText(rawText, limits)
      assertTextCell(current, limits)
    },
    end(_qualifiedName, name) {
      if (name === 't' && current !== null) {
        if (!inText) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
        inText = false
      }
      if (name === 'si') {
        if (current === null || inText) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
        assertTextCell(current, limits)
        strings.push(current)
        current = null
      }
    },
  })
  if (!sawRoot) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
  return strings
}

interface PendingCell {
  column: number
  type: string | null
  rawValue: string | null
  inlineValue: string
  collectingValue: boolean
  collectingText: boolean
  childStack: string[]
  inlineStringSeen: boolean
  inlineTextSeen: boolean
}

function startCellChild(cell: PendingCell, element: { localName: string; selfClosing: boolean }): void {
  const parent = cell.childStack[cell.childStack.length - 1] ?? 'c'
  if (element.localName === 'v') {
    if (parent !== 'c' || cell.rawValue !== null || cell.inlineStringSeen) {
      failWorkbook('CATALOG_WORKBOOK_CELL_TYPE_INVALID')
    }
    cell.rawValue = ''
    cell.collectingValue = !element.selfClosing
  } else if (element.localName === 'is') {
    if (parent !== 'c' || cell.type !== 'inlineStr' || cell.inlineStringSeen || cell.rawValue !== null) {
      failWorkbook('CATALOG_WORKBOOK_CELL_TYPE_INVALID')
    }
    cell.inlineStringSeen = true
  } else if (element.localName === 't') {
    if (parent !== 'is' || cell.inlineTextSeen) failWorkbook('CATALOG_WORKBOOK_CELL_TYPE_INVALID')
    cell.inlineTextSeen = true
    cell.collectingText = !element.selfClosing
  } else {
    failWorkbook('CATALOG_WORKBOOK_CELL_TYPE_INVALID')
  }
  if (!element.selfClosing) cell.childStack.push(element.localName)
}

function finishCell(cell: PendingCell, sharedStrings: readonly string[], limits: MasterCatalogWorkbookLimits): ParsedWorkbookCell {
  // WHY: `str` is a cached formula result and unknown empty cell types are
  // still semantic input, so validate the type before the blank fast path.
  if (cell.type !== null && cell.type !== 'n' && cell.type !== 's' && cell.type !== 'b' && cell.type !== 'inlineStr') {
    failWorkbook('CATALOG_WORKBOOK_CELL_TYPE_INVALID')
  }
  if (cell.type === 'inlineStr') {
    if (cell.rawValue !== null) failWorkbook('CATALOG_WORKBOOK_CELL_TYPE_INVALID')
    assertTextCell(cell.inlineValue, limits)
    return cell.inlineValue ? { kind: 'TEXT', value: cell.inlineValue } : { kind: 'BLANK', value: '' }
  }
  if (cell.rawValue === null || cell.rawValue === '') return { kind: 'BLANK', value: '' }
  const value = decodeXmlText(cell.rawValue, limits.maxCellCharacters)
  if (cell.type === 's') {
    const index = parseBoundedInteger(value, Math.max(sharedStrings.length - 1, 0), 'CATALOG_WORKBOOK_CELL_TYPE_INVALID')
    const shared = sharedStrings[index]
    if (shared === undefined) failWorkbook('CATALOG_WORKBOOK_CELL_TYPE_INVALID')
    return shared ? { kind: 'TEXT', value: shared } : { kind: 'BLANK', value: '' }
  }
  if (cell.type === 'b') {
    if (value !== '0' && value !== '1') failWorkbook('CATALOG_WORKBOOK_CELL_TYPE_INVALID')
    return { kind: 'BOOLEAN', value: value === '1' ? 'true' : 'false' }
  }
  if (cell.rawValue.includes('&')) failWorkbook('CATALOG_WORKBOOK_NUMBER_INVALID')
  if (!isPlainDecimal(value)) failWorkbook('CATALOG_WORKBOOK_NUMBER_INVALID')
  return { kind: 'NUMBER', value }
}

export function parseWorksheetXml(
  xml: string,
  expectedHeaders: readonly string[],
  sharedStrings: readonly string[],
  limits: MasterCatalogWorkbookLimits,
  remainingWorkbookRows: number,
): { sheet: ParsedWorkbookSheet; physicalRows: number } {
  const rows = [] as ParsedWorkbookSheet['rows']
  let physicalRows = 0
  let lastSourceRow = 0
  let sawHeader = false
  let sawRoot = false
  let sawSheetData = false
  let definedNameDepth = 0
  let currentRow: { sourceRow: number; cells: Map<number, ParsedWorkbookCell> } | null = null
  let currentCell: PendingCell | null = null

  const finishCurrentCell = (): void => {
    if (!currentRow || !currentCell) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    currentRow.cells.set(currentCell.column, finishCell(currentCell, sharedStrings, limits))
    currentCell = null
  }
  const finishCurrentRow = (): void => {
    if (!currentRow || currentCell) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    if (currentRow.sourceRow === 1) {
      if (currentRow.cells.size !== expectedHeaders.length) failWorkbook('CATALOG_WORKBOOK_COLUMN_INVALID')
      for (let index = 0; index < expectedHeaders.length; index += 1) {
        const cell = currentRow.cells.get(index + 1)
        if (cell?.kind !== 'TEXT' || cell.value !== expectedHeaders[index]) failWorkbook('CATALOG_WORKBOOK_COLUMN_INVALID')
      }
      sawHeader = true
    } else {
      if (!sawHeader) failWorkbook('CATALOG_WORKBOOK_COLUMN_INVALID')
      rows.push({
        sourceRow: currentRow.sourceRow,
        values: Object.fromEntries(
          expectedHeaders.map((header, index) => [header, currentRow?.cells.get(index + 1) ?? { kind: 'BLANK', value: '' }]),
        ) as Record<string, ParsedWorkbookCell>,
      })
    }
    currentRow = null
  }

  scanXml(xml, {
    start(element) {
      if (element.localName === 'f') failWorkbook('CATALOG_WORKBOOK_FORMULA_FORBIDDEN')
      if (element.localName === 'formula' || element.localName === 'formula1' || element.localName === 'formula2') {
        failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
      }
      if (element.localName === 'definedName' && !element.selfClosing) definedNameDepth += 1
      if (isSpreadsheetElement(element, 'worksheet', 0, null)) {
        if (sawRoot) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
        sawRoot = true
      } else if (isSpreadsheetElement(element, 'sheetData', 1, 'worksheet')) {
        if (sawSheetData) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
        sawSheetData = true
      } else if (isSpreadsheetElement(element, 'row', 2, 'sheetData')) {
        if (currentRow) failWorkbook('CATALOG_WORKBOOK_ROW_INVALID')
        const sourceRow = parseBoundedInteger(xmlAttribute(element, 'r', null) ?? '', MAX_SOURCE_ROW, 'CATALOG_WORKBOOK_ROW_INVALID')
        if (sourceRow < 1 || sourceRow <= lastSourceRow) failWorkbook('CATALOG_WORKBOOK_ROW_INVALID')
        lastSourceRow = sourceRow
        physicalRows += 1
        if (physicalRows > limits.maxRowsPerSheet || physicalRows > remainingWorkbookRows) {
          failWorkbook('CATALOG_WORKBOOK_ROW_LIMIT')
        }
        currentRow = { sourceRow, cells: new Map() }
        if (element.selfClosing) finishCurrentRow()
      } else if (currentRow && isSpreadsheetElement(element, 'c', 3, 'row')) {
        if (currentCell) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
        const reference = xmlAttribute(element, 'r', null)
        if (!reference) failWorkbook('CATALOG_WORKBOOK_CELL_REFERENCE_INVALID')
        const coordinates = cellCoordinates(reference)
        if (coordinates.row !== currentRow.sourceRow) failWorkbook('CATALOG_WORKBOOK_CELL_REFERENCE_INVALID')
        if (coordinates.column > limits.maxColumns) failWorkbook('CATALOG_WORKBOOK_COLUMN_LIMIT')
        if (coordinates.column > expectedHeaders.length) failWorkbook('CATALOG_WORKBOOK_COLUMN_INVALID')
        if (currentRow.cells.has(coordinates.column)) failWorkbook('CATALOG_WORKBOOK_CELL_REFERENCE_INVALID')
        currentCell = {
          column: coordinates.column,
          type: xmlAttribute(element, 't', null),
          rawValue: null,
          inlineValue: '',
          collectingValue: false,
          collectingText: false,
          childStack: [],
          inlineStringSeen: false,
          inlineTextSeen: false,
        }
        if (element.selfClosing) finishCurrentCell()
      } else if (currentCell) {
        if (
          isSpreadsheetElement(element, 'v', 4, 'c') ||
          isSpreadsheetElement(element, 'is', 4, 'c') ||
          isSpreadsheetElement(element, 't', 5, 'is')
        ) {
          startCellChild(currentCell, element)
        } else {
          // WHY: Non-semantic worksheet subtrees are ignored, but once a cell
          // is authoritative its child grammar remains closed for hashing.
          if (element.namespaceUri === SPREADSHEET_NAMESPACE) startCellChild(currentCell, element)
          failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
        }
      } else if (currentRow) {
        failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
      }
    },
    text(rawText) {
      if (definedNameDepth > 0 && !isFormattingWhitespace(rawText)) {
        failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
      }
      if (!currentCell) {
        if (currentRow && !isFormattingWhitespace(rawText)) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
        return
      }
      if (currentCell.collectingValue) {
        if ((currentCell.rawValue?.length ?? 0) + rawText.length > limits.maxCellCharacters) {
          failWorkbook('CATALOG_WORKBOOK_CELL_LIMIT')
        }
        currentCell.rawValue = `${currentCell.rawValue ?? ''}${rawText}`
      } else if (currentCell.collectingText) {
        currentCell.inlineValue += decodeBoundedCellText(rawText, limits)
        assertTextCell(currentCell.inlineValue, limits)
      } else if (!isFormattingWhitespace(rawText)) {
        failWorkbook('CATALOG_WORKBOOK_CELL_TYPE_INVALID')
      }
    },
    end(_qualifiedName, name) {
      if (name === 'definedName' && definedNameDepth > 0) definedNameDepth -= 1
      if (currentCell && name !== 'c') {
        if (currentCell.childStack.pop() !== name) failWorkbook('CATALOG_WORKBOOK_CELL_TYPE_INVALID')
        if (name === 'v') currentCell.collectingValue = false
        if (name === 't') currentCell.collectingText = false
      } else if (name === 'c' && currentCell) {
        if (currentCell.childStack.length) failWorkbook('CATALOG_WORKBOOK_CELL_TYPE_INVALID')
        finishCurrentCell()
      } else if (name === 'row' && currentRow) finishCurrentRow()
    },
  })
  if (!sawRoot || !sawSheetData) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
  if (!sawHeader) failWorkbook('CATALOG_WORKBOOK_COLUMN_INVALID')
  return { sheet: { columns: [...expectedHeaders], rows }, physicalRows }
}
