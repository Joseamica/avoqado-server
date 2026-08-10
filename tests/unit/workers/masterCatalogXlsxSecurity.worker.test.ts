import AdmZip from 'adm-zip'
import { parseMasterCatalogXlsxBuffer } from '@/workers/masterCatalogXlsx.worker'
import { mutateEntry, replaceEntryBytes, workbookBuffer } from './masterCatalogXlsx.fixture'

describe('masterCatalogXlsx.worker closed XML security grammar', () => {
  it.each([
    ['content-types', '[Content_Types].xml', /(<\/?)Types(?=[ >])/gu, '$1EvilTypes'],
    ['relationships', '_rels/.rels', /(<\/?)Relationships(?=[ >])/gu, '$1EvilRelationships'],
    ['workbook', 'xl/workbook.xml', /(<\/?)workbook(?=[ >])/gu, '$1evilWorkbook'],
    ['worksheet', 'xl/worksheets/sheet1.xml', /(<\/?)worksheet(?=[ >])/gu, '$1evilWorksheet'],
  ])('rejects a renamed %s OPC root', (_label, path, root, replacement) => {
    const buffer = mutateEntry(workbookBuffer(), path, xml => xml.replace(root, replacement))
    expect(() => parseMasterCatalogXlsxBuffer(buffer)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_OOXML_INVALID' }))
  })

  it('rejects SpreadsheetML namespace spoofing even when local names remain valid', () => {
    const buffer = mutateEntry(workbookBuffer(), 'xl/workbook.xml', xml =>
      xml.replace('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'urn:evil:spreadsheet'),
    )
    expect(() => parseMasterCatalogXlsxBuffer(buffer)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_OOXML_INVALID' }))
  })

  it('rejects raw less-than markup inside an XML attribute value', () => {
    const buffer = mutateEntry(workbookBuffer(), 'xl/workbook.xml', xml => xml.replace('<workbook ', '<workbook evil="<" '))
    expect(() => parseMasterCatalogXlsxBuffer(buffer)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_XML_INVALID' }))
  })

  it.each([
    ['attribute NameStart', (xml: string) => xml.replace('<workbook ', '<workbook 1evil="x" ')],
    ['qualified local NameStart', (xml: string) => xml.replace('<workbook ', '<workbook xmlns:a="urn:evil" a:1bad="x" ')],
    ['element NameStart', (xml: string) => xml.replace('<workbook ', '<1workbook ').replace('</workbook>', '</1workbook>')],
    [
      'duplicate expanded attribute',
      (xml: string) => xml.replace('<workbook ', '<workbook xmlns:a="urn:same" xmlns:b="urn:same" a:evil="1" b:evil="2" '),
    ],
  ])('rejects invalid XML %s grammar', (_label, mutate) => {
    const buffer = mutateEntry(workbookBuffer(), 'xl/workbook.xml', mutate)
    expect(() => parseMasterCatalogXlsxBuffer(buffer)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_XML_INVALID' }))
  })

  it.each([
    ['end tag', (xml: string) => xml.replace('</workbook>', '</workbook\u00A0>')],
    ['self-closing slash boundary with XML space', (xml: string) => xml.replace('/><sheets>', '/ ><sheets>')],
    ['self-closing slash boundary with NBSP', (xml: string) => xml.replace('/><sheets>', '/\u00A0><sheets>')],
  ])('rejects invalid whitespace at the %s', (_label, mutate) => {
    const buffer = mutateEntry(workbookBuffer(), 'xl/workbook.xml', mutate)
    expect(() => parseMasterCatalogXlsxBuffer(buffer)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_XML_INVALID' }))
  })

  it('rejects formula-bearing workbook and worksheet descendants outside cell f elements', () => {
    const definedName = mutateEntry(workbookBuffer(), 'xl/workbook.xml', xml =>
      xml.replace('</workbook>', '<definedNames><definedName>HYPERLINK("https://invalid")</definedName></definedNames></workbook>'),
    )
    expect(() => parseMasterCatalogXlsxBuffer(definedName)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_OOXML_INVALID' }))

    const validation = mutateEntry(workbookBuffer(), 'xl/worksheets/sheet1.xml', xml =>
      xml.replace(
        '</worksheet>',
        '<dataValidations><dataValidation><formula1>HYPERLINK("https://invalid")</formula1></dataValidation></dataValidations></worksheet>',
      ),
    )
    expect(() => parseMasterCatalogXlsxBuffer(validation)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_OOXML_INVALID' }))
  })

  it('never applies rows nested outside the single worksheet sheetData ancestry', () => {
    const hiddenRow = mutateEntry(workbookBuffer(), 'xl/worksheets/sheet1.xml', xml =>
      xml.replace(
        '</sheetData>',
        '</sheetData><evil><row r="99"><c r="A99" t="inlineStr"><is><t>HIDDEN-SKU</t></is></c><c r="B99"><v>99.99</v></c></row></evil>',
      ),
    )
    const parsed = parseMasterCatalogXlsxBuffer(hiddenRow)
    expect(parsed.sheets.Metadata.rows.map(row => row.sourceRow)).not.toContain(99)
  })

  it.each([
    [
      'openpyxl',
      (buffer: Buffer) => {
        const workbook = mutateEntry(buffer, 'xl/workbook.xml', xml => xml.replace('</sheets>', '</sheets><definedNames/>'))
        return mutateEntry(workbook, 'xl/worksheets/sheet1.xml', xml =>
          xml.replace('<dimension', '<sheetPr><outlinePr summaryBelow="1"/><pageSetUpPr fitToPage="0"/></sheetPr><dimension'),
        )
      },
    ],
    [
      'LibreOffice',
      (buffer: Buffer) => {
        const workbook = mutateEntry(buffer, 'xl/workbook.xml', xml =>
          xml
            .replace(
              '<workbookPr',
              '<fileVersion appName="Calc"/><workbookProtection/><bookViews><workbookView activeTab="0"/></bookViews><workbookPr',
            )
            .replace(
              '</workbook>',
              '<calcPr calcId="124519"/><extLst><ext uri="urn:libreoffice"><lo:extCalcPr xmlns:lo="urn:libreoffice"/></ext></extLst></workbook>',
            ),
        )
        return mutateEntry(workbook, 'xl/worksheets/sheet1.xml', xml =>
          xml
            .replace('<dimension', '<sheetPr><outlinePr/><pageSetUpPr/></sheetPr><dimension')
            .replace(
              '<sheetViews><sheetView workbookViewId="0"/></sheetViews>',
              '<sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>',
            )
            .replace(
              '<ignoredErrors>',
              '<pageMargins left="0.75" right="0.75" top="1" bottom="1" header="0.5" footer="0.5"/><ignoredErrors>',
            ),
        )
      },
    ],
  ])('accepts the benign non-semantic %s re-save dialect without changing imported data', (_label, resave) => {
    const parsed = parseMasterCatalogXlsxBuffer(resave(workbookBuffer()))
    expect(parsed.sheetNames).toEqual(['Metadata', 'Items', 'OrganizationValues', 'BusinessTypes', 'VenueBindingRequests'])
    expect(parsed.sheets.OrganizationValues.rows[0]?.values.amount).toEqual({ kind: 'NUMBER', value: '1' })
  })

  it('rejects duplicate row numbers and cell references that disagree with their row container', () => {
    const duplicateRow = mutateEntry(workbookBuffer(), 'xl/worksheets/sheet1.xml', xml =>
      xml.replace('</sheetData>', '<row r="2"><c r="A2" t="s"><v>0</v></c></row></sheetData>'),
    )
    expect(() => parseMasterCatalogXlsxBuffer(duplicateRow)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_ROW_INVALID' }))

    const mismatchedCell = mutateEntry(workbookBuffer(), 'xl/worksheets/sheet1.xml', xml => xml.replace('r="A2"', 'r="A99"'))
    expect(() => parseMasterCatalogXlsxBuffer(mismatchedCell)).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_CELL_REFERENCE_INVALID' }),
    )
  })

  it('rejects namespace-prefixed self-closing formulas even when a cached value follows', () => {
    const buffer = mutateEntry(workbookBuffer(), 'xl/worksheets/sheet3.xml', xml =>
      xml.replace(/(<c r="C2"[^>]*>)/u, '$1<x:f xmlns:x="urn:adversarial"/><v>999.99</v>'),
    )
    expect(() => parseMasterCatalogXlsxBuffer(buffer)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_FORMULA_FORBIDDEN' }))

    const cachedString = mutateEntry(workbookBuffer(), 'xl/worksheets/sheet3.xml', xml =>
      xml.replace(/<c r="C2"[^>]*>[\s\S]*?<\/c>/u, '<c r="C2" t="str"><v>cached</v></c>'),
    )
    expect(() => parseMasterCatalogXlsxBuffer(cachedString)).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_CELL_TYPE_INVALID' }),
    )
  })

  it('fails closed on unrecognized nested content inside cells and shared strings', () => {
    const hiddenCellText = mutateEntry(workbookBuffer(), 'xl/worksheets/sheet3.xml', xml =>
      xml.replace(/(<c r="C2"[^>]*>)/u, '$1<t>hidden</t>'),
    )
    expect(() => parseMasterCatalogXlsxBuffer(hiddenCellText)).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_CELL_TYPE_INVALID' }),
    )

    const unknownBlankType = mutateEntry(workbookBuffer(), 'xl/worksheets/sheet3.xml', xml =>
      xml.replace(/<c r="E2"[^>]*>[\s\S]*?<\/c>/u, '<c r="E2" t="unknown"/>'),
    )
    expect(() => parseMasterCatalogXlsxBuffer(unknownBlankType)).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_CELL_TYPE_INVALID' }),
    )

    const hiddenSharedString = mutateEntry(workbookBuffer(), 'xl/sharedStrings.xml', xml =>
      xml.replace('<t>SKU-001</t>', '<unknown><t>SKU-001</t></unknown>'),
    )
    expect(() => parseMasterCatalogXlsxBuffer(hiddenSharedString)).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_XML_INVALID' }),
    )
  })

  it.each([
    ['DTD', '<!DOCTYPE payload [<!ELEMENT payload ANY>]>'],
    ['ENTITY', '<!ENTITY steal "forbidden">'],
    ['CDATA', '<![CDATA[forbidden]]>'],
  ])('rejects %s declarations before XML element parsing', (_label, declaration) => {
    const buffer = mutateEntry(workbookBuffer(), 'docProps/app.xml', xml => xml.replace(/(<[^?])/u, `${declaration}$1`))
    expect(() => parseMasterCatalogXlsxBuffer(buffer)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_XML_MARKUP_FORBIDDEN' }))
  })

  it('uses fatal UTF-8 for every XML OPC part and rejects UTF-16 declarations/BOMs', () => {
    const base = workbookBuffer()
    const zip = new AdmZip(base)
    const appXml = zip.getEntry('docProps/app.xml')?.getData()
    if (!appXml) throw new Error('missing app properties fixture entry')
    const invalidUtf8 = replaceEntryBytes(base, 'docProps/app.xml', Buffer.concat([appXml, Buffer.from([0xff])]))
    expect(() => parseMasterCatalogXlsxBuffer(invalidUtf8)).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_XML_ENCODING_INVALID' }),
    )

    const macroXml =
      "<?xml version='1.0' encoding='UTF-16'?><Types><Override PartName='/xl/workbook.xml' ContentType='application/vnd.ms-excel.sheet.macroEnabled.main+xml'/></Types>"
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(macroXml, 'utf16le')])
    expect(() => parseMasterCatalogXlsxBuffer(replaceEntryBytes(base, '[Content_Types].xml', utf16))).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_XML_ENCODING_INVALID' }),
    )

    const encodedControl = mutateEntry(base, 'docProps/app.xml', xml => xml.replace('</Properties>', '&#x85;</Properties>'))
    expect(() => parseMasterCatalogXlsxBuffer(encodedControl)).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_CONTROL_CHARACTER_FORBIDDEN' }),
    )
  })

  it('rejects every actual XML part whose semantic content type has no allowlisted grammar', () => {
    for (const payload of ['<evil/>', '<evil>']) {
      const zip = new AdmZip(workbookBuffer())
      zip.addFile('evil.xml', Buffer.from(payload))
      expect(() => parseMasterCatalogXlsxBuffer(zip.toBuffer())).toThrow(
        expect.objectContaining({ code: 'CATALOG_WORKBOOK_OOXML_INVALID' }),
      )
    }
  })

  it('applies XML and relationship safety by OPC extension without case-sensitive gaps', () => {
    const invalidXml = new AdmZip(workbookBuffer())
    invalidXml.addFile('docProps/hostile.payload', Buffer.from([0xff]))
    const contentTypes = invalidXml.getEntry('[Content_Types].xml')
    if (!contentTypes) throw new Error('missing content-types fixture entry')
    invalidXml.updateFile(
      '[Content_Types].xml',
      Buffer.from(
        contentTypes
          .getData()
          .toString('utf8')
          .replace('</Types>', "<Override PartName='/docProps/hostile.payload' ContentType='application/xml'/></Types>"),
      ),
    )
    expect(() => parseMasterCatalogXlsxBuffer(invalidXml.toBuffer())).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_XML_ENCODING_INVALID' }),
    )

    const externalRelationship = new AdmZip(workbookBuffer())
    externalRelationship.addFile(
      'xl/worksheets/_rels/sheet1.xml.RELS',
      Buffer.from(
        "<?xml version='1.0'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship TargetMode='External'/></Relationships>",
      ),
    )
    expect(() => parseMasterCatalogXlsxBuffer(externalRelationship.toBuffer())).toThrow(
      expect.objectContaining({ code: 'CATALOG_WORKBOOK_EXTERNAL_LINK_FORBIDDEN' }),
    )
  })

  it.each([
    ['numeric surrogate', '&#xD800;', 'CATALOG_WORKBOOK_XML_INVALID'],
    ['numeric noncharacter', '&#xFDD0;', 'CATALOG_WORKBOOK_XML_INVALID'],
    ['C1 control U+0085', '\u0085', 'CATALOG_WORKBOOK_CONTROL_CHARACTER_FORBIDDEN'],
    ['LRM U+200E', '\u200E', 'CATALOG_WORKBOOK_BIDI_FORBIDDEN'],
    ['numeric RLM U+200F', '&#x200F;', 'CATALOG_WORKBOOK_BIDI_FORBIDDEN'],
    ['ALM U+061C', '\u061C', 'CATALOG_WORKBOOK_BIDI_FORBIDDEN'],
    ['numeric deprecated bidi U+206A', '&#x206A;', 'CATALOG_WORKBOOK_BIDI_FORBIDDEN'],
    ['bidi override U+202E', '\u202E', 'CATALOG_WORKBOOK_BIDI_FORBIDDEN'],
  ])('rejects %s in shared-string text', (_label, hostile, code) => {
    const buffer = mutateEntry(workbookBuffer(), 'xl/sharedStrings.xml', xml => xml.replace('<t>SKU-001</t>', `<t>${hostile}</t>`))
    expect(() => parseMasterCatalogXlsxBuffer(buffer)).toThrow(expect.objectContaining({ code }))
  })

  it('rejects hidden cells beyond the exact header and out-of-order physical rows', () => {
    const hiddenCell = mutateEntry(workbookBuffer(), 'xl/worksheets/sheet1.xml', xml =>
      xml.replace(/(<row r="2"[^>]*>[\s\S]*?)(<\/row>)/u, '$1<c r="C2" t="inlineStr"><is><t>hidden</t></is></c>$2'),
    )
    expect(() => parseMasterCatalogXlsxBuffer(hiddenCell)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_COLUMN_INVALID' }))

    const outOfOrder = mutateEntry(workbookBuffer(), 'xl/worksheets/sheet1.xml', xml =>
      xml.replace(/(<row r="2"[\s\S]*?<\/row>)(<row r="3"[\s\S]*?<\/row>)/u, '$2$1'),
    )
    expect(() => parseMasterCatalogXlsxBuffer(outOfOrder)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_ROW_INVALID' }))
  })

  it('bounds sourceRow to PostgreSQL Int32 and stops row iteration at the per-sheet cap', () => {
    const overflow = mutateEntry(workbookBuffer(), 'xl/worksheets/sheet1.xml', xml =>
      xml.replace(/r="2"/gu, 'r="2147483648"').replace(/r="([AB])2"/gu, 'r="$12147483648"'),
    )
    expect(() => parseMasterCatalogXlsxBuffer(overflow)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_ROW_INVALID' }))

    const emptyRows = Array.from({ length: 100_000 }, (_, index) => `<row r="${index + 2}"/>`).join('')
    const oversized = mutateEntry(workbookBuffer(), 'xl/worksheets/sheet2.xml', xml =>
      xml.replace('</sheetData>', `${emptyRows}<f/></sheetData>`),
    )
    // WHY: The row cap must win before a trailing token, proving the scanner
    // does not first regex/materialize the complete 100k-row attack document.
    expect(() => parseMasterCatalogXlsxBuffer(oversized)).toThrow(expect.objectContaining({ code: 'CATALOG_WORKBOOK_ROW_LIMIT' }))
  })
})
