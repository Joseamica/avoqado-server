import { appendCatalogImportStandaloneErrorLines } from '@/services/master-catalog/catalogImportFieldValidation.service'
import type { CatalogImportRowError, CatalogImportStagedLine } from '@/services/master-catalog/catalogImport.types'
import { expectCatalogImportEventLoopBudgetV1, startCatalogImportEventLoopProbeV1 } from './catalogImportEventLoopTestHarness'
import { blank, context, makeHarness, number, row, text, upload, validWorkbook } from './catalogImportTestHarness'

describe('catalog import field finding scheduler', () => {
  it('yields while grouping the maximum durable finding envelope even when every coordinate already has a line', async () => {
    const errors: CatalogImportRowError[] = []
    const staged: CatalogImportStagedLine[] = []
    for (let index = 0; index < 20_000; index += 1) {
      const sourceRow = index + 2
      const rowErrors = Array.from(
        { length: 20 },
        (_, column): CatalogImportRowError => ({
          source_sheet: 'Items',
          source_row: sourceRow,
          column: `column_${column}`,
          error_code: 'CATALOG_CODE_MUST_BE_TEXT',
          message: 'Valor inválido.',
          suggestion: 'Corrige la celda.',
        }),
      )
      errors.push(...rowErrors)
      staged.push({
        sourceSheet: 'Items',
        sourceRow,
        status: 'INVALID',
        payload: { schemaVersion: 1 },
        errors: rowErrors,
        catalogItemId: null,
      })
    }

    const probe = startCatalogImportEventLoopProbeV1()
    let sliceStartedAt = performance.now()
    const checkpoint = async () => {
      if (performance.now() - sliceStartedAt < 4) return
      await new Promise<void>(resolve => setImmediate(resolve))
      sliceStartedAt = performance.now()
    }

    await appendCatalogImportStandaloneErrorLines(staged, errors, checkpoint)
    const samples = probe.stop()

    // WHY: Invalid workbooks are the adversarial path; pre-existing staged
    // coordinates must not bypass the same <50 ms scheduler as valid rows.
    expectCatalogImportEventLoopBudgetV1(samples)
    expect(staged).toHaveLength(20_000)
  }, 20_000)

  it('reports CREATE rule revisions once per exact OrganizationValues row', async () => {
    const workbook = validWorkbook()
    workbook.sheets.OrganizationValues.rows[0]!.values.expected_rule_revision = number('2')
    workbook.sheets.OrganizationValues.rows[1]!.values.expected_rule_revision = number('3')

    const result = await makeHarness(workbook).service.preview(context, upload)
    const findings = result.errors
      .filter(error => error.source_sheet === 'OrganizationValues' && error.column === 'expected_rule_revision')
      .map(error => ({ row: error.source_row, code: error.error_code }))

    // WHY: CREATE has no persisted rule CAS authority; every supplied revision
    // is independently invalid and never reclassified as an UPDATE conflict.
    expect(findings).toEqual([
      { row: 2, code: 'CATALOG_VALUE_REVISION_INVALID' },
      { row: 3, code: 'CATALOG_VALUE_REVISION_INVALID' },
    ])
  })

  it('points an incomplete currency pair to that currency instead of a valid pair', async () => {
    const workbook = validWorkbook()
    workbook.sheets.OrganizationValues.rows.push(
      row(4, {
        corporate_sku: text('SKU-001'),
        value_type: text('SALE_PRICE'),
        amount: number('12.00'),
        currency: text('USD'),
        expected_rule_revision: blank(),
      }),
    )

    const result = await makeHarness(workbook).service.preview(context, upload)
    const findings = result.errors.filter(error => error.error_code === 'CATALOG_VALUE_PAIR_REQUIRED')

    expect(findings).toEqual([
      expect.objectContaining({
        source_sheet: 'OrganizationValues',
        source_row: 4,
        column: 'currency',
        rejected_value: 'USD',
        suggestion: 'Agrega PURCHASE_COST para USD.',
      }),
    ])
  })

  it('truncates rejected workbook text at a complete Unicode-scalar boundary', async () => {
    const workbook = validWorkbook()
    const submitted = `${'A'.repeat(127)}😀${'B'.repeat(130)}`
    workbook.sheets.Items.rows[0]!.values.corporate_sku = text(submitted)

    const result = await makeHarness(workbook).service.preview(context, upload)
    const finding = result.errors.find(error => error.source_sheet === 'Items' && error.column === 'corporate_sku')

    expect(result).toMatchObject({ canConfirm: false, previewToken: null })
    expect(finding).toMatchObject({ error_code: 'CATALOG_IDENTIFIER_INVALID', rejected_value: `${'A'.repeat(127)}😀` })
    expect([...(finding?.rejected_value ?? '')]).toHaveLength(128)
    expect(
      [...(finding?.rejected_value ?? '')].some(scalar => {
        const codePoint = scalar.codePointAt(0) as number
        return codePoint >= 0xd800 && codePoint <= 0xdfff
      }),
    ).toBe(false)
  })

  it('keeps every ancillary scalar diagnostic even when its join identity or enum is invalid', async () => {
    const workbook = validWorkbook()
    workbook.sheets.OrganizationValues.rows.push(
      row(9, {
        corporate_sku: blank(),
        value_type: text('WAT'),
        amount: text('oops'),
        currency: text('mxn'),
        expected_rule_revision: text('bad'),
      }),
    )
    workbook.sheets.BusinessTypes.rows.push(row(8, { corporate_sku: blank(), business_type: text('WAT') }))
    workbook.sheets.VenueBindingRequests.rows.push(
      row(7, {
        corporate_sku: blank(),
        venue_id: blank(),
        requested_action: text('DELETE'),
        product_id: text('product-foreign'),
        local_sku: blank(),
        category_id: text('category-foreign'),
        initial_price: number('999999999.999'),
        currency: text('usd'),
      }),
    )
    const h = makeHarness(workbook)
    h.tx.product.findMany.mockResolvedValue([{ id: 'product-foreign', venueId: 'venue-foreign' }])
    h.tx.menuCategory.findMany.mockResolvedValue([{ id: 'category-foreign', venueId: 'venue-foreign' }])

    const result = await h.service.preview(context, upload)
    const keys = (sheet: string, sourceRow: number) =>
      result.errors
        .filter(error => error.source_sheet === sheet && error.source_row === sourceRow)
        .map(error => `${error.column}:${error.error_code}`)
        .sort()

    // WHY: Invalid joins limit lookup scope but never become a fail-fast gate
    // that hides independent enum, money, currency, or tenant-safe findings.
    expect(keys('OrganizationValues', 9)).toEqual([
      'amount:CATALOG_DECIMAL_INVALID',
      'corporate_sku:CATALOG_CODE_MUST_BE_TEXT',
      'currency:CATALOG_CURRENCY_INVALID',
      'expected_rule_revision:CATALOG_DECIMAL_INVALID',
      'value_type:CATALOG_VALUE_KIND_INVALID',
    ])
    expect(keys('BusinessTypes', 8)).toEqual(['business_type:CATALOG_BUSINESS_TYPE_INVALID', 'corporate_sku:CATALOG_CODE_MUST_BE_TEXT'])
    expect(keys('VenueBindingRequests', 7)).toEqual([
      'category_id:CATALOG_TARGET_NOT_FOUND',
      'corporate_sku:CATALOG_CODE_MUST_BE_TEXT',
      'currency:CATALOG_CURRENCY_INVALID',
      'initial_price:CATALOG_MONEY_INVALID',
      'product_id:CATALOG_TARGET_NOT_FOUND',
      'requested_action:CATALOG_BINDING_ACTION_INVALID',
      'venue_id:CATALOG_CODE_MUST_BE_TEXT',
    ])
  })
})
