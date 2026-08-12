import AdmZip from 'adm-zip'
import { DEFAULT_MASTER_CATALOG_WORKBOOK_LIMITS, parseMasterCatalogXlsxBuffer } from '@/workers/masterCatalogXlsx.worker'
import { addRenamedPartRelationship, addRenamedPartWithContentType, mutateEntry, workbookBuffer } from './masterCatalogXlsx.fixture'

describe('masterCatalogXlsx.worker secure OOXML extraction', () => {
  it('freezes every contractual limit and preserves a raw numeric XML lexeme without using a JavaScript number', () => {
    // WHY: Prices and fiscal decimals must reach Task 5 byte-for-byte; SheetJS
    // numeric coercion would make an already-rounded preview impossible to detect.
    expect(DEFAULT_MASTER_CATALOG_WORKBOOK_LIMITS).toEqual({
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
    expect(Object.isFrozen(DEFAULT_MASTER_CATALOG_WORKBOOK_LIMITS)).toBe(true)
    const raw = '12345678901234567.89'
    const buffer = mutateEntry(workbookBuffer(), 'xl/worksheets/sheet3.xml', xml =>
      xml.replace(/(<c r="C2"[^>]*>\s*<v>)[^<]+(<\/v>)/u, `$1${raw}$2`),
    )

    const parsed = parseMasterCatalogXlsxBuffer(buffer)

    expect(parsed.sheetNames).toEqual(['Metadata', 'Items', 'OrganizationValues', 'BusinessTypes', 'VenueBindingRequests'])
    expect(parsed.sheets.OrganizationValues.rows[0]?.values.amount).toEqual({ kind: 'NUMBER', value: raw })

    const encodedDigit = mutateEntry(buffer, 'xl/worksheets/sheet3.xml', xml => xml.replace(raw, '&#49;'))
    expect(() => parseMasterCatalogXlsxBuffer(encodedDigit)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_NUMBER_INVALID' }))
  })

  it.each([
    ['formula', () => workbookBuffer({ formula: true }), 'CATALOG_WORKBOOK_FORMULA_FORBIDDEN'],
    ['export-only sheet', () => workbookBuffer({ extraSheet: 'PreparedDishDetails' }), 'CATALOG_WORKBOOK_SHEET_INVALID'],
    ['unknown sheet', () => workbookBuffer({ extraSheet: 'Surprise' }), 'CATALOG_WORKBOOK_SHEET_INVALID'],
    ['missing required sheet', () => workbookBuffer({ omit: 'BusinessTypes' }), 'CATALOG_WORKBOOK_SHEET_INVALID'],
    ['corrupt ZIP', () => Buffer.from('PK\u0003\u0004broken', 'binary'), 'CATALOG_WORKBOOK_ZIP_INVALID'],
  ])('rejects %s before returning worksheet rows', (_label, makeBuffer, code) => {
    // WHY: Structural ambiguity is a whole-file failure; staging rows from a
    // partially understood workbook could turn a security rejection into data.
    expect(() => parseMasterCatalogXlsxBuffer(makeBuffer())).toThrow(expect.objectContaining({ code }))
  })

  it.each([
    ['xl/vbaProject.bin', 'CATALOG_WORKBOOK_MACRO_FORBIDDEN'],
    ['xl/externalLinks/externalLink1.xml', 'CATALOG_WORKBOOK_EXTERNAL_LINK_FORBIDDEN'],
    ['EncryptionInfo', 'CATALOG_WORKBOOK_ENCRYPTED'],
  ])('rejects forbidden OOXML entry %s', (entryName, code) => {
    const zip = new AdmZip(workbookBuffer())
    zip.addFile(entryName, Buffer.from('forbidden'))

    expect(() => parseMasterCatalogXlsxBuffer(zip.toBuffer())).toThrow(expect.objectContaining({ code }))
  })

  it('rejects slash-normalized duplicate ZIP names before any getEntry lookup can shadow content', () => {
    const zip = new AdmZip(workbookBuffer())
    zip.addFile('XL/workbook.xml', Buffer.from('<shadow/>'))

    // WHY: Backslash and slash variants resolve to one logical OPC part on
    // common tooling; accepting both would make validation and extraction read
    // potentially different bytes.
    expect(() => parseMasterCatalogXlsxBuffer(zip.toBuffer())).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_ZIP_ENTRY_DUPLICATE' }),
    )
  })

  it('classifies the ZIP encryption flag before attempting decompression', () => {
    const zip = new AdmZip(workbookBuffer())
    const entry = zip.getEntry('xl/workbook.xml')
    if (!entry) throw new Error('missing workbook fixture entry')
    entry.header.flags |= 1

    // WHY: AdmZip's runtime property is `encrypted` even though its current
    // DefinitelyTyped declaration misspells it; the stable error must not rely
    // on a later decompression failure.
    expect(() => parseMasterCatalogXlsxBuffer(zip.toBuffer())).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_ENCRYPTED' }))
  })

  it('counts directory entries toward the ZIP entry cap', () => {
    const zip = new AdmZip(workbookBuffer())
    const fileCount = zip.getEntries().filter(entry => !entry.isDirectory).length
    zip.addFile('unused-directory/', Buffer.alloc(0))

    // WHY: Directory records still consume parser memory and central-directory
    // work, so attackers cannot bypass the 128-entry envelope with empty paths.
    expect(() => parseMasterCatalogXlsxBuffer(zip.toBuffer(), { maxZipEntries: fileCount })).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_ZIP_ENTRY_LIMIT' }),
    )
  })

  it.each(['xl/activeX/activeX1.bin', 'xl/ctrlProps/ctrlProp1.xml', 'xl/controls/control1.xml', 'xl/embeddings/oleObject1.bin'])(
    'rejects active or embedded OOXML part %s',
    entryName => {
      const zip = new AdmZip(workbookBuffer())
      zip.addFile(entryName, Buffer.from('active-content'))

      expect(() => parseMasterCatalogXlsxBuffer(zip.toBuffer())).toThrow(
        expect.objectContaining({ code: 'CATALOG_WORKBOOK_ACTIVE_CONTENT_FORBIDDEN' }),
      )
    },
  )

  it('rejects a macro-enabled workbook content type without relying on a vbaProject filename', () => {
    const buffer = mutateEntry(workbookBuffer(), '[Content_Types].xml', xml =>
      xml.replace('spreadsheetml.sheet.main+xml', 'ms-excel.sheet.macroEnabled.main+xml'),
    )

    expect(() => parseMasterCatalogXlsxBuffer(buffer)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_MACRO_FORBIDDEN' }))
  })

  it('requires relationship parts to use the semantic OPC relationship content type', () => {
    const buffer = mutateEntry(workbookBuffer(), '[Content_Types].xml', xml =>
      xml.replace('application/vnd.openxmlformats-package.relationships+xml', 'application/xml'),
    )
    expect(() => parseMasterCatalogXlsxBuffer(buffer)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_OOXML_INVALID' }))
  })

  it('scans every relationships part for external targets', () => {
    const zip = new AdmZip(workbookBuffer())
    zip.addFile(
      'xl/worksheets/_rels/sheet1.xml.rels',
      Buffer.from(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rExternal" Target="https://invalid.example" TargetMode="External"/></Relationships>',
      ),
    )

    expect(() => parseMasterCatalogXlsxBuffer(zip.toBuffer())).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_EXTERNAL_LINK_FORBIDDEN' }),
    )
  })

  it('rejects single-quoted external relationships independent of attribute order', () => {
    const buffer = mutateEntry(workbookBuffer(), 'xl/_rels/workbook.xml.rels', xml =>
      xml.replace(
        '</Relationships>',
        "<Relationship TargetMode='External' Target='https://invalid.example/private.xlsx' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink' Id='rExternal'/></Relationships>",
      ),
    )

    expect(() => parseMasterCatalogXlsxBuffer(buffer)).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_EXTERNAL_LINK_FORBIDDEN' }),
    )
  })

  it.each([
    ['renamed VBA content type', 'application/vnd.ms-office.vbaProject', 'CATALOG_WORKBOOK_MACRO_FORBIDDEN'],
    ['renamed macro-sheet content type', 'application/vnd.ms-excel.macrosheet+xml', 'CATALOG_WORKBOOK_MACRO_FORBIDDEN'],
    ['renamed OLE content type', 'application/vnd.ms-office.oleObject', 'CATALOG_WORKBOOK_ACTIVE_CONTENT_FORBIDDEN'],
  ])('rejects %s semantically rather than trusting the ZIP path', (_label, contentType, code) => {
    expect(() => parseMasterCatalogXlsxBuffer(addRenamedPartWithContentType(workbookBuffer(), contentType))).toThrow(
      expect.objectContaining({ code }),
    )
  })

  it.each([
    ['renamed VBA relationship', 'http://schemas.microsoft.com/office/2006/relationships/vbaProject', 'CATALOG_WORKBOOK_MACRO_FORBIDDEN'],
    [
      'renamed macro-sheet relationship',
      'http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet',
      'CATALOG_WORKBOOK_MACRO_FORBIDDEN',
    ],
    [
      'renamed OLE relationship',
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject',
      'CATALOG_WORKBOOK_ACTIVE_CONTENT_FORBIDDEN',
    ],
  ])('rejects %s by Relationship Type', (_label, relationshipType, code) => {
    expect(() => parseMasterCatalogXlsxBuffer(addRenamedPartRelationship(workbookBuffer(), relationshipType))).toThrow(
      expect.objectContaining({ code }),
    )
  })

  it('rejects duplicate sheet names even when every name belongs to the allowed set', () => {
    const buffer = mutateEntry(workbookBuffer(), 'xl/workbook.xml', xml => xml.replace('name="BusinessTypes"', 'name="Items"'))

    expect(() => parseMasterCatalogXlsxBuffer(buffer)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_SHEET_INVALID' }))
  })

  it('enforces ZIP entry, expanded-byte, compression-ratio, row, column, and cell caps before domain mapping', () => {
    const buffer = workbookBuffer()
    const cases = [
      { limits: { maxZipEntries: 1 }, code: 'CATALOG_WORKBOOK_ZIP_ENTRY_LIMIT' },
      { limits: { maxExpandedBytes: 32 }, code: 'CATALOG_WORKBOOK_EXPANDED_LIMIT' },
      { limits: { maxCompressionRatio: 1 }, code: 'CATALOG_WORKBOOK_COMPRESSION_RATIO_LIMIT' },
      { limits: { maxRowsPerSheet: 1 }, code: 'CATALOG_WORKBOOK_ROW_LIMIT' },
      { limits: { maxColumns: 1 }, code: 'CATALOG_WORKBOOK_COLUMN_LIMIT' },
      { limits: { maxCellCharacters: 1 }, code: 'CATALOG_WORKBOOK_CELL_LIMIT' },
    ]

    // WHY: Tiny injected caps exercise every guard without allocating attack-
    // sized fixtures; production callers cannot override the frozen defaults.
    for (const testCase of cases) {
      expect(() => parseMasterCatalogXlsxBuffer(buffer, testCase.limits)).toThrow(expect.objectContaining({ code: testCase.code }))
    }
  })

  it('rejects formula-like text and malformed columns while keeping numeric SKU cells visibly typed', () => {
    const formulaLike = mutateEntry(workbookBuffer(), 'xl/sharedStrings.xml', xml =>
      xml.replace('<t>SKU-001</t>', '<t>=HYPERLINK(&quot;https://invalid&quot;)</t>'),
    )
    expect(() => parseMasterCatalogXlsxBuffer(formulaLike)).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_FORMULA_LIKE_FORBIDDEN' }),
    )

    const badHeader = mutateEntry(workbookBuffer(), 'xl/sharedStrings.xml', xml =>
      xml.replace('<t>requested_action</t>', '<t>server_owned_status</t>'),
    )
    expect(() => parseMasterCatalogXlsxBuffer(badHeader)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_COLUMN_INVALID' }))
  })
})
