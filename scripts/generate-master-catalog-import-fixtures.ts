import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as XLSX from 'xlsx'

const SHEETS = {
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

type FixtureKind = 'valid' | 'errors'
type SheetName = keyof typeof SHEETS

export interface GeneratedMasterCatalogImportFixture {
  filename: `catalog-master-import-v1-${FixtureKind}.xlsx`
  path: string
  sha256: string
  bytes: number
}

function metadataRows(): unknown[][] {
  return [
    [...SHEETS.Metadata],
    ['documentType', 'catalog-master-import'],
    ['schemaVersion', '1'],
    ['organizationId', 'org-pits'],
    ['timezone', 'America/Mexico_City'],
  ]
}

function validRows(): Record<SheetName, unknown[][]> {
  return {
    Metadata: metadataRows(),
    Items: [
      [...SHEETS.Items],
      [
        'CREATE',
        '',
        '',
        'SKU-001',
        'RETAIL_PRODUCT',
        'Producto corporativo',
        'Descripción completa',
        'https://cdn.example.test/item.png',
        'Marca Uno',
        'Fabricante Uno',
        'Familia Uno',
        'Subfamilia Uno',
        'Pieza individual',
        'UNIT',
        'REGULAR',
        0.16,
        '50161509',
        'H87',
        '02',
        'NONE',
        '',
        '',
        '',
      ],
    ],
    OrganizationValues: [
      [...SHEETS.OrganizationValues],
      ['SKU-001', 'SALE_PRICE', 100, 'MXN', ''],
      ['SKU-001', 'PURCHASE_COST', 50, 'MXN', ''],
    ],
    BusinessTypes: [[...SHEETS.BusinessTypes], ['SKU-001', 'RETAIL_STORE']],
    VenueBindingRequests: [[...SHEETS.VenueBindingRequests]],
  }
}

function errorRows(): Record<SheetName, unknown[][]> {
  const rows = validRows()
  // WHY: This fixture stays valid, passive OOXML while placing independent
  // domain violations in source cells. It proves errors come from preview
  // validation rather than formulas, macros, external content, or corruption.
  rows.Items[1] = [
    'CREATE',
    '',
    '',
    123,
    'RETAIL_PRODUCT',
    'Producto inválido',
    'Descripción hostil pero segura',
    'javascript:alert(1)',
    'Marca Uno',
    'Fabricante Uno',
    'Familia Uno',
    'Subfamilia Uno',
    'Pieza individual',
    'BAD_UNIT',
    'UNKNOWN_ALIAS',
    2,
    'ABC',
    'BAD',
    '99',
    'RATE',
    0.1234567,
    999999999.99999,
    'BAD_UNIT',
  ]
  rows.OrganizationValues = [
    [...SHEETS.OrganizationValues],
    ['SKU-001', 'WAT', 999999999.999, 'mxn', 7],
    ['SKU-001', 'PURCHASE_COST', 'not-money', 'MXN', 'bad-revision'],
  ]
  rows.BusinessTypes = [[...SHEETS.BusinessTypes], ['SKU-001', 'UNKNOWN_BUSINESS_TYPE']]
  rows.VenueBindingRequests = [
    [...SHEETS.VenueBindingRequests],
    ['SKU-001', 'venue-foreign', 'DELETE', 'product-foreign', 'LOCAL-1', 'category-foreign', '999999999.999', 'usd'],
  ]
  return rows
}

function workbookBytes(kind: FixtureKind): Buffer {
  const workbook = XLSX.utils.book_new()
  const rows = kind === 'valid' ? validRows() : errorRows()
  // WHY: Fixed sheet order, cells, writer options, and no generated timestamps
  // make the ZIP bytes reproducible; SheetJS is used only to write trusted data.
  for (const name of Object.keys(SHEETS) as SheetName[]) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows[name]), name)
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true, bookSST: true }) as Buffer
}

export async function generateMasterCatalogImportFixtures(outputDirectory: string): Promise<GeneratedMasterCatalogImportFixture[]> {
  await mkdir(outputDirectory, { recursive: true })
  const results: GeneratedMasterCatalogImportFixture[] = []
  for (const kind of ['valid', 'errors'] as const) {
    const filename = `catalog-master-import-v1-${kind}.xlsx` as const
    const bytes = workbookBytes(kind)
    const path = resolve(outputDirectory, filename)
    await writeFile(path, bytes)
    results.push({ filename, path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
  }
  return results
}

if (require.main === module) {
  const outputDirectory = process.argv[2] ? resolve(process.argv[2]) : resolve(__dirname, '../tests/fixtures/master-catalog')
  generateMasterCatalogImportFixtures(outputDirectory)
    .then(results => {
      for (const result of results) process.stdout.write(`${result.filename} ${result.sha256} ${result.bytes}\n`)
    })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Fixture generation failed'}\n`)
      process.exitCode = 1
    })
}
