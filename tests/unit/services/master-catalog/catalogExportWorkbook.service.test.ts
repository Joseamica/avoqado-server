import * as XLSX from 'xlsx'
import {
  CATALOG_EXPORT_METADATA_GRAIN_V1,
  createCatalogWorkbookWriterV1,
  writeCatalogWorkbookV1,
} from '@/services/master-catalog/catalogExportWorkbook.service'

function readRows(buffer: Buffer, sheetName: string): unknown[][] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellNF: true })
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null }) as unknown[][]
}

const metadata = {
  schemaVersion: '1',
  organizationId: 'org-001',
  generatedAt: '2026-08-09T12:34:56.000Z',
  timezone: 'America/Mexico_City',
  filters: '{}',
  profileVersion: '1',
}

describe('catalogExport workbook v1', () => {
  it('declares the exact versioned Metadata grain', () => {
    expect(CATALOG_EXPORT_METADATA_GRAIN_V1).toEqual(['key', 'value'])
  })

  it('writes typed cells, empty nulls, grain order, and neutralized formula-like text', async () => {
    const workbook = await writeCatalogWorkbookV1({
      metadata,
      sheets: [
        {
          name: 'Typed',
          grain: ['id'],
          columns: [
            { key: 'id', type: 'text' },
            { key: 'money', type: 'decimal2', precision: 10 },
            { key: 'recipe_cost', type: 'decimal4', precision: 10 },
            { key: 'nullable', type: 'text' },
            { key: 'danger', type: 'text' },
          ],
          rows: [
            { id: '0002', money: '12.30', recipe_cost: '1.2345', nullable: null, danger: '+SUM(A1:A2)' },
            { id: '0001', money: '2.00', recipe_cost: '0.5000', nullable: null, danger: '=1+1' },
            { id: '0003', money: '-1.50', recipe_cost: '7.0000', nullable: null, danger: '-cmd' },
            { id: '0004', money: '0.00', recipe_cost: '8.1000', nullable: null, danger: '@payload' },
          ],
        },
      ],
    })

    expect(readRows(workbook, 'Metadata')).toEqual([
      ['key', 'value'],
      ['filters', '{}'],
      ['generatedAt', '2026-08-09T12:34:56.000Z'],
      ['organizationId', 'org-001'],
      ['profileVersion', '1'],
      ['schemaVersion', '1'],
      ['timezone', 'America/Mexico_City'],
    ])
    expect(readRows(workbook, 'Typed')).toEqual([
      ['id', 'money', 'recipe_cost', 'nullable', 'danger'],
      ['0001', 2, 0.5, null, "'=1+1"],
      ['0002', 12.3, 1.2345, null, "'+SUM(A1:A2)"],
      ['0003', -1.5, 7, null, "'-cmd"],
      ['0004', 0, 8.1, null, "'@payload"],
    ])
    const parsed = XLSX.read(workbook, { type: 'buffer', cellNF: true })
    expect(parsed.Sheets.Typed.B2.z).toBe('0.00')
    expect(parsed.Sheets.Typed.C2.z).toBe('0.0000')
  })

  it('orders the seven template metadata keys by the exact declared grain', async () => {
    const workbook = await writeCatalogWorkbookV1({
      metadata: { ...metadata, documentType: 'catalog-master-import' },
      sheets: [],
    })

    expect(readRows(workbook, 'Metadata')).toEqual([
      ['key', 'value'],
      ['documentType', 'catalog-master-import'],
      ['filters', '{}'],
      ['generatedAt', '2026-08-09T12:34:56.000Z'],
      ['organizationId', 'org-001'],
      ['profileVersion', '1'],
      ['schemaVersion', '1'],
      ['timezone', 'America/Mexico_City'],
    ])
  })

  it('rejects row capacity before iterating or cloning caller data', async () => {
    const rows = new Proxy(new Array(5_001), {
      get(target, property, receiver) {
        if (property === 'map' || property === Symbol.iterator) throw new Error('iterated-before-cap')
        return Reflect.get(target, property, receiver)
      },
    }) as Array<Record<string, string>>
    await expect(
      writeCatalogWorkbookV1({
        metadata,
        sheets: [{ name: 'TooLarge', grain: ['id'], columns: [{ key: 'id', type: 'text' }], rows }],
      }),
    ).rejects.toMatchObject({ statusCode: 413, code: 'CATALOG_EXPORT_CAP_EXCEEDED' })
  })

  it.each(['x'.repeat(32_768), `=${'x'.repeat(32_766)}`])(
    'rejects an oversized emitted text cell before cloning or sorting rows',
    async value => {
      const rows = new Proxy([{ id: value }], {
        get(target, property, receiver) {
          if (property === 'map' || property === Symbol.iterator) throw new Error('cloned-before-text-cap')
          return Reflect.get(target, property, receiver)
        },
      })
      await expect(
        writeCatalogWorkbookV1({
          metadata,
          sheets: [{ name: 'TooLargeText', grain: ['id'], columns: [{ key: 'id', type: 'text' }], rows }],
        }),
      ).rejects.toMatchObject({ statusCode: 413, code: 'CATALOG_EXPORT_CELL_TOO_LARGE' })
    },
  )

  it('rejects an oversized worksheet XML part before creating a ZIP archive', async () => {
    const createArchive = jest.fn()
    const writer = createCatalogWorkbookWriterV1({ limits: { maxXmlPartBytes: 2_000 }, createArchive })

    await expect(
      writer({
        metadata,
        sheets: [
          {
            name: 'PartCap',
            grain: ['id'],
            columns: [{ key: 'id', type: 'text' }],
            rows: [{ id: 'a'.repeat(1_500) }, { id: 'b'.repeat(1_500) }],
          },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 413, code: 'CATALOG_EXPORT_CAP_EXCEEDED' })
    expect(createArchive).not.toHaveBeenCalled()
  })

  it('rejects aggregate XML incrementally before materializing a later sheet or ZIP', async () => {
    const createArchive = jest.fn()
    const secondSheetRows = new Proxy([{ id: 'later' }], {
      get(target, property, receiver) {
        if (property === 'map') throw new Error('materialized-after-aggregate-cap')
        return Reflect.get(target, property, receiver)
      },
    })
    const writer = createCatalogWorkbookWriterV1({
      limits: { maxXmlPartBytes: 7_000, maxAggregateXmlBytes: 7_000 },
      createArchive,
    })

    await expect(
      writer({
        metadata,
        sheets: [
          {
            name: 'AggregateCap',
            grain: ['id'],
            columns: [{ key: 'id', type: 'text' }],
            rows: [{ id: 'a'.repeat(2_500) }, { id: 'b'.repeat(2_500) }],
          },
          { name: 'NeverMaterialized', grain: ['id'], columns: [{ key: 'id', type: 'text' }], rows: secondSheetRows },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 413, code: 'CATALOG_EXPORT_CAP_EXCEEDED' })
    expect(createArchive).not.toHaveBeenCalled()
  })

  it('rejects an oversized final ZIP from the bounded archive adapter', async () => {
    const archive = {
      addFile: jest.fn(() => ({ header: { time: new Date(0) } })),
      toBufferPromise: jest.fn().mockResolvedValue(Buffer.alloc(17)),
    }
    const writer = createCatalogWorkbookWriterV1({ limits: { maxZipBytes: 16 }, createArchive: () => archive })

    await expect(writer({ metadata, sheets: [] })).rejects.toMatchObject({
      statusCode: 413,
      code: 'CATALOG_EXPORT_CAP_EXCEEDED',
    })
    expect(archive.toBufferPromise).toHaveBeenCalledTimes(1)
  })

  it('yields from the writer itself before completing a bounded multi-row sheet', async () => {
    let releaseYield: (() => void) | undefined
    let firstYield = true
    const yieldNow = jest.fn(() => {
      if (!firstYield) return Promise.resolve()
      firstYield = false
      return new Promise<void>(resolve => (releaseYield = resolve))
    })
    const writer = createCatalogWorkbookWriterV1({ limits: { yieldEveryRows: 2 }, yieldNow })
    let settled = false
    const pending = writer({
      metadata,
      sheets: [
        {
          name: 'Cooperative',
          grain: ['id'],
          columns: [{ key: 'id', type: 'text' }],
          rows: [{ id: '1' }, { id: '2' }, { id: '3' }],
        },
      ],
    }).finally(() => (settled = true))

    await Promise.resolve()
    expect(yieldNow).toHaveBeenCalled()
    expect(settled).toBe(false)
    releaseYield?.()
    await expect(pending).resolves.toBeInstanceOf(Buffer)
  })

  it.each([
    ['decimal4', 5, '9.9999'],
    ['decimal6', 7, '9.999999'],
    ['decimal4', 12, '99999999.9999'],
    ['decimal2', 10, '99999999.99'],
    ['decimal4', 10, '999999.9999'],
  ] as const)('accepts the exact decimal(%s precision %i) upper boundary', async (type, precision, value) => {
    await expect(
      writeCatalogWorkbookV1({
        metadata,
        sheets: [{ name: 'DecimalBoundary', grain: ['value'], columns: [{ key: 'value', type, precision }], rows: [{ value }] }],
      }),
    ).resolves.toBeInstanceOf(Buffer)
  })

  it.each([
    ['decimal4', 5, '10.0000'],
    ['decimal6', 7, '10.000000'],
    ['decimal4', 12, '100000000.0000'],
    ['decimal2', 10, '100000000.00'],
    ['decimal4', 10, '1000000.0000'],
  ] as const)('rejects decimal(%s precision %i) integer overflow before ZIP', async (type, precision, value) => {
    const createArchive = jest.fn()
    const writer = createCatalogWorkbookWriterV1({ createArchive })
    await expect(
      writer({
        metadata,
        sheets: [{ name: 'DecimalOverflow', grain: ['value'], columns: [{ key: 'value', type, precision }], rows: [{ value }] }],
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_EXPORT_INVALID' })
    expect(createArchive).not.toHaveBeenCalled()
  })

  it.each(['0.00001', '1e3', 1e21])('rejects scale/exponent input %p without rounding before ZIP', async value => {
    const createArchive = jest.fn()
    const writer = createCatalogWorkbookWriterV1({ createArchive })
    await expect(
      writer({
        metadata,
        sheets: [
          {
            name: 'DecimalLexical',
            grain: ['id'],
            columns: [
              { key: 'id', type: 'text' },
              { key: 'value', type: 'decimal4', precision: 10 },
            ],
            rows: [{ id: '1', value }],
          },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_EXPORT_INVALID' })
    expect(createArchive).not.toHaveBeenCalled()
  })

  it.each(['safe\u202Eevil', 'x\uFFFEy', 'lone\uD800surrogate'])('rejects spoofing or XML-invalid text %p', async value => {
    await expect(
      writeCatalogWorkbookV1({
        metadata,
        sheets: [{ name: 'Unsafe', grain: ['id'], columns: [{ key: 'id', type: 'text' }], rows: [{ id: value }] }],
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_EXPORT_INVALID' })
  })
})
