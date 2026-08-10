import AdmZip from 'adm-zip'
import * as XLSX from 'xlsx'

export const HEADERS = {
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

type SheetName = keyof typeof HEADERS

function sheetRows(name: SheetName): unknown[][] {
  if (name === 'Metadata') {
    return [
      [...HEADERS.Metadata],
      ['documentType', 'catalog-master-import'],
      ['schemaVersion', '1'],
      ['organizationId', 'org-pits'],
      ['timezone', 'America/Mexico_City'],
    ]
  }
  if (name === 'OrganizationValues') return [[...HEADERS[name]], ['SKU-001', 'SALE_PRICE', 1, 'MXN', '']]
  return [[...HEADERS[name]]]
}

export function workbookBuffer(options: { omit?: SheetName; extraSheet?: string; formula?: boolean } = {}): Buffer {
  // WHY: SheetJS remains confined to trusted fixture generation. Production
  // parsing never imports it or calls `read` on attacker-controlled bytes.
  const workbook = XLSX.utils.book_new()
  for (const name of Object.keys(HEADERS) as SheetName[]) {
    if (name === options.omit) continue
    const sheet = XLSX.utils.aoa_to_sheet(sheetRows(name))
    if (name === 'OrganizationValues' && options.formula) sheet.C2 = { t: 'n', f: '1+1', v: 2 }
    XLSX.utils.book_append_sheet(workbook, sheet, name)
  }
  if (options.extraSheet) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['forbidden']]), options.extraSheet)
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true, bookSST: true }) as Buffer
}

export function mutateEntry(buffer: Buffer, name: string, mutate: (xml: string) => string): Buffer {
  const zip = new AdmZip(buffer)
  const entry = zip.getEntry(name)
  if (!entry) throw new Error(`missing fixture entry ${name}`)
  zip.updateFile(name, Buffer.from(mutate(entry.getData().toString('utf8')), 'utf8'))
  return zip.toBuffer()
}

export function replaceEntryBytes(buffer: Buffer, name: string, bytes: Buffer): Buffer {
  const zip = new AdmZip(buffer)
  if (!zip.getEntry(name)) throw new Error(`missing fixture entry ${name}`)
  zip.updateFile(name, bytes)
  return zip.toBuffer()
}

export function addRenamedPartWithContentType(buffer: Buffer, contentType: string): Buffer {
  const zip = new AdmZip(buffer)
  zip.addFile('xl/custom/innocent.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><payload/>'))
  const entry = zip.getEntry('[Content_Types].xml')
  if (!entry) throw new Error('missing content-types fixture entry')
  const xml = entry
    .getData()
    .toString('utf8')
    .replace(
      '</Types>',
      `<ct:Override xmlns:ct='http://schemas.openxmlformats.org/package/2006/content-types' ContentType='${contentType}' PartName='/xl/custom/innocent.xml'/></Types>`,
    )
  zip.updateFile('[Content_Types].xml', Buffer.from(xml))
  return zip.toBuffer()
}

export function addRenamedPartRelationship(buffer: Buffer, relationshipType: string): Buffer {
  const zip = new AdmZip(buffer)
  const entry = zip.getEntry('xl/_rels/workbook.xml.rels')
  if (!entry) throw new Error('missing workbook relationships fixture entry')
  const xml = entry
    .getData()
    .toString('utf8')
    .replace(
      '</Relationships>',
      `<r:Relationship xmlns:r='http://schemas.openxmlformats.org/package/2006/relationships' Target='styles.xml' Type='${relationshipType}' Id='rAdversarial'/></Relationships>`,
    )
  zip.updateFile('xl/_rels/workbook.xml.rels', Buffer.from(xml))
  return zip.toBuffer()
}
