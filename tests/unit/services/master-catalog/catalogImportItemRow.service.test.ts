import { context, makeHarness, number, row, text, upload, validWorkbook } from './catalogImportTestHarness'

describe('catalog import Items scalar phase', () => {
  it('reports every scalar failure on a duplicate SKU without rescanning its ancillary aggregate', async () => {
    const workbook = validWorkbook()
    const first = workbook.sheets.Items.rows[0]!.values
    workbook.sheets.Items.rows.push(
      row(3, {
        ...first,
        catalog_item_id: text('forbidden-create-id'),
        expected_revision: number('2'),
        image_url: text('not-a-url'),
        unit: text('BAD_UNIT'),
        iva_rate: number('2.0000'),
      }),
    )

    const result = await makeHarness(workbook).service.preview(context, upload)
    const findings = result.errors
      .filter(error => error.source_sheet === 'Items' && error.source_row === 3)
      .map(error => `${error.column}:${error.error_code}`)
      .sort()

    // WHY: The duplicate identity cuts child joins only; every scalar cell on
    // the physical row remains independently repairable in one preview.
    expect(findings).toEqual([
      'catalog_item_id:CATALOG_IMPORT_IDENTITY_INVALID',
      'corporate_sku:CATALOG_WORKBOOK_DUPLICATE',
      'expected_revision:CATALOG_IMPORT_IDENTITY_INVALID',
      'image_url:CATALOG_IMAGE_URL_INVALID',
      'iva_rate:CATALOG_DECIMAL_INVALID',
      'unit:CATALOG_UNIT_INVALID',
    ])
  })

  it('reports an over-index-budget corporate SKU on the exact Items cell and never issues a bearer', async () => {
    const workbook = validWorkbook()
    const oversizedSku = 'S'.repeat(257)
    workbook.sheets.Items.rows[0]!.values.corporate_sku = text(oversizedSku)
    for (const sheet of ['OrganizationValues', 'BusinessTypes'] as const) {
      for (const ancillary of workbook.sheets[sheet].rows) ancillary.values.corporate_sku = text(oversizedSku)
    }

    const result = await makeHarness(workbook).service.preview(context, upload)

    expect(result).toMatchObject({ canConfirm: false, previewToken: null })
    expect(
      result.errors
        .filter(error => error.source_sheet === 'Items' && error.source_row === 2)
        .map(error => `${error.column}:${error.error_code}`),
    ).toEqual(['corporate_sku:CATALOG_IDENTIFIER_INVALID'])
  })

  it('reports an over-index-budget reference on its exact Items cell and never issues a bearer', async () => {
    const workbook = validWorkbook()
    workbook.sheets.Items.rows[0]!.values.brand = text('B'.repeat(257))

    const result = await makeHarness(workbook).service.preview(context, upload)

    expect(result).toMatchObject({ canConfirm: false, previewToken: null })
    expect(
      result.errors
        .filter(error => error.source_sheet === 'Items' && error.source_row === 2)
        .map(error => `${error.column}:${error.error_code}`),
    ).toEqual(['brand:CATALOG_REFERENCE_NAME_INVALID'])
  })
})
