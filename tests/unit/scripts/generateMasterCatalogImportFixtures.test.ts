import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generateMasterCatalogImportFixtures } from '../../../scripts/generate-master-catalog-import-fixtures'
import { parseMasterCatalogXlsxBuffer } from '@/workers/masterCatalogXlsx.worker'
import { context, makeHarness, upload } from '../services/master-catalog/catalogImportTestHarness'

const fixtureNames = ['catalog-master-import-v1-valid.xlsx', 'catalog-master-import-v1-errors.xlsx'] as const
const committedDirectory = resolve(process.cwd(), 'tests/fixtures/master-catalog')
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')

describe('master catalog import fixture generator', () => {
  let firstDirectory: string
  let secondDirectory: string

  beforeEach(async () => {
    firstDirectory = await mkdtemp(join(tmpdir(), 'catalog-import-fixture-a-'))
    secondDirectory = await mkdtemp(join(tmpdir(), 'catalog-import-fixture-b-'))
  })

  afterEach(async () => {
    await Promise.all([rm(firstDirectory, { recursive: true, force: true }), rm(secondDirectory, { recursive: true, force: true })])
  })

  it('emits byte-identical safe OOXML and matches the versioned repository artifacts', async () => {
    const first = await generateMasterCatalogImportFixtures(firstDirectory)
    const second = await generateMasterCatalogImportFixtures(secondDirectory)

    expect(first.map(result => result.filename)).toEqual(fixtureNames)
    expect(second.map(result => result.filename)).toEqual(fixtureNames)
    for (const fixtureName of fixtureNames) {
      const [firstBytes, secondBytes, committedBytes] = await Promise.all([
        readFile(join(firstDirectory, fixtureName)),
        readFile(join(secondDirectory, fixtureName)),
        readFile(join(committedDirectory, fixtureName)),
      ])
      expect(firstBytes).toEqual(secondBytes)
      expect(firstBytes).toEqual(committedBytes)
      expect(sha256(firstBytes)).toMatch(/^[0-9a-f]{64}$/u)
    }
  })

  it('keeps both binaries structurally valid while only the error fixture is domain-hostile', async () => {
    await generateMasterCatalogImportFixtures(firstDirectory)
    const validBytes = await readFile(join(firstDirectory, fixtureNames[0]))
    const errorBytes = await readFile(join(firstDirectory, fixtureNames[1]))
    const validWorkbook = parseMasterCatalogXlsxBuffer(validBytes)
    const errorWorkbook = parseMasterCatalogXlsxBuffer(errorBytes)

    expect(validWorkbook.sheetNames).toEqual(['Metadata', 'Items', 'OrganizationValues', 'BusinessTypes', 'VenueBindingRequests'])
    expect(errorWorkbook.sheetNames).toEqual(validWorkbook.sheetNames)
    expect(validWorkbook.sheets.Items.rows[0]?.values.corporate_sku).toEqual({ kind: 'TEXT', value: 'SKU-001' })
    expect(errorWorkbook.sheets.Items.rows[0]?.values.corporate_sku).toEqual({ kind: 'NUMBER', value: '123' })

    const validPreview = await makeHarness(validWorkbook).service.preview(context, { ...upload, buffer: validBytes })
    const errorPreview = await makeHarness(errorWorkbook).service.preview(context, { ...upload, buffer: errorBytes })
    expect(validPreview).toMatchObject({ canConfirm: true, errors: [] })
    expect(errorPreview.canConfirm).toBe(false)
    expect(errorPreview.errors.map(error => error.error_code)).toEqual(
      expect.arrayContaining(['CATALOG_CODE_MUST_BE_TEXT', 'CATALOG_UNIT_INVALID', 'CATALOG_CURRENCY_INVALID']),
    )
  })
})
