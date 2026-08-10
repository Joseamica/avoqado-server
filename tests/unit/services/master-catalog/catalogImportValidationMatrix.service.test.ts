import { BusinessType, CatalogReferenceStatus } from '@prisma/client'
import { blank, context, makeHarness, number, row, text, upload, validWorkbook } from './catalogImportTestHarness'

function makeUpdateWorkbook() {
  const workbook = validWorkbook()
  const item = workbook.sheets.Items.rows[0]!.values
  item.operation = text('UPDATE')
  item.catalog_item_id = text('catalog-item-1')
  item.expected_revision = number('8')
  workbook.sheets.OrganizationValues.rows.forEach((valueRow, index) => {
    valueRow.values.expected_rule_revision = number(String(index + 2))
  })
  return workbook
}

function itemRow(id: string, sku: string, normalizedSku: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sku,
    normalizedSku,
    status: 'ACTIVE',
    revision: 8,
    invariantVersion: 4n,
    businessTypes: [{ businessType: BusinessType.RETAIL_STORE }],
    ...overrides,
  }
}

describe('catalog import validation matrix', () => {
  it('joins Items and ancillary rows through the one NFKC/trim/case SKU identity', async () => {
    const workbook = validWorkbook()
    workbook.sheets.Items.rows[0]!.values.corporate_sku = text(' sku-001 ')
    for (const sheet of ['OrganizationValues', 'BusinessTypes'] as const) {
      for (const valueRow of workbook.sheets[sheet].rows) valueRow.values.corporate_sku = text('ＳＫＵ-００１')
    }
    const h = makeHarness(workbook)

    const result = await h.service.preview(context, upload)

    expect(result).toMatchObject({ canConfirm: true, errors: [] })
  })

  it('stages the exact canonical Task 5 command without internal validator fields', async () => {
    const workbook = validWorkbook()
    const item = workbook.sheets.Items.rows[0]!.values
    item.name = text('  Producto canónico  ')
    item.description = text('  Descripción canónica  ')
    item.iva_rate = number('0.16')
    workbook.sheets.OrganizationValues.rows[0]!.values.amount = number('1.0')
    const h = makeHarness(workbook)

    await h.service.preview(context, upload)

    const staged = h.tx.catalogImportLine.createMany.mock.calls[0]?.[0].data.find(
      (line: { sourceSheet: string }) => line.sourceSheet === 'Items',
    ).payload.command.input
    expect(staged).toEqual({
      brandId: 'brand-1',
      businessTypes: ['RETAIL_STORE'],
      name: 'Producto canónico',
      description: 'Descripción canónica',
      familyId: 'subfamily-1',
      iepsMode: 'NONE',
      iepsQuota: null,
      iepsQuotaUnit: null,
      iepsRate: null,
      imageUrl: 'https://cdn.example.test/item.png',
      kind: 'RETAIL_PRODUCT',
      manufacturerId: 'manufacturer-1',
      objetoImp: '02',
      organizationValues: [
        { kind: 'SALE_PRICE', amount: '1.00', currency: 'MXN' },
        { kind: 'PURCHASE_COST', amount: '50.00', currency: 'MXN' },
      ],
      presentationLabel: 'Pieza individual',
      productType: 'REGULAR',
      satProductKey: '50161509',
      satUnitKey: 'H87',
      sku: 'SKU-001',
      taxRate: '0.1600',
      unit: 'UNIT',
    })

    const changedWorkbook = validWorkbook()
    changedWorkbook.sheets.Items.rows[0]!.values.name = text('Producto distinto')
    const changed = makeHarness(changedWorkbook)
    await changed.service.preview(context, upload)
    const originalHash = h.tx.catalogImportBatch.create.mock.calls[0]?.[0].data.targetHash
    const changedHash = changed.tx.catalogImportBatch.create.mock.calls[0]?.[0].data.targetHash
    // WHY: The exact reviewed DTO—not raw worksheet whitespace or validator
    // internals—is the target-hash authority accepted by confirmation.
    expect(changedHash).not.toBe(originalHash)
  })

  it('accepts complete MXN+USD pairs and rejects any currency with only one side', async () => {
    const workbook = validWorkbook()
    workbook.sheets.OrganizationValues.rows.push(
      row(4, {
        corporate_sku: text('SKU-001'),
        value_type: text('SALE_PRICE'),
        amount: number('12.00'),
        currency: text('USD'),
        expected_rule_revision: blank(),
      }),
      row(5, {
        corporate_sku: text('SKU-001'),
        value_type: text('PURCHASE_COST'),
        amount: number('8.00'),
        currency: text('USD'),
        expected_rule_revision: blank(),
      }),
    )
    await expect(makeHarness(workbook).service.preview(context, upload)).resolves.toMatchObject({
      canConfirm: true,
      errors: [],
    })

    workbook.sheets.OrganizationValues.rows.pop()
    const incomplete = await makeHarness(workbook).service.preview(context, upload)
    expect(incomplete).toMatchObject({ canConfirm: false })
    expect(incomplete.errors).toEqual(expect.arrayContaining([expect.objectContaining({ error_code: 'CATALOG_VALUE_PAIR_REQUIRED' })]))
  })

  it('never drops an unknown organization value kind beside an otherwise valid pair', async () => {
    const workbook = validWorkbook()
    workbook.sheets.OrganizationValues.rows.push(
      row(4, {
        corporate_sku: text('SKU-001'),
        value_type: text('WAT'),
        amount: number('1.00'),
        currency: text('MXN'),
        expected_rule_revision: blank(),
      }),
    )

    const result = await makeHarness(workbook).service.preview(context, upload)

    expect(result).toMatchObject({ canConfirm: false, previewToken: null })
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ source_row: 4, column: 'value_type', error_code: 'CATALOG_VALUE_KIND_INVALID' })]),
    )
    expect(result.errors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'iva_rate', error_code: 'CATALOG_DECIMAL_INVALID' }),
        expect.objectContaining({ column: 'ieps_mode', error_code: 'CATALOG_IEPS_INVALID' }),
      ]),
    )
  })

  it('cuts duplicate Item identities before reparsing the same ancillary aggregate', async () => {
    const workbook = validWorkbook()
    const itemTemplate = workbook.sheets.Items.rows[0]!.values
    workbook.sheets.Items.rows = Array.from({ length: 64 }, (_, index) => row(index + 2, { ...itemTemplate }))
    let valueTypeReads = 0
    const valueTemplate = workbook.sheets.OrganizationValues.rows[0]!.values
    workbook.sheets.OrganizationValues.rows = Array.from({ length: 64 }, (_, index) => {
      const values = { ...valueTemplate }
      Object.defineProperty(values, 'value_type', {
        enumerable: true,
        get: () => {
          valueTypeReads += 1
          return index % 2 === 0 ? text('SALE_PRICE') : text('PURCHASE_COST')
        },
      })
      return row(index + 2, values)
    })

    const result = await makeHarness(workbook).service.preview(context, upload)

    // WHY: One normalized SKU denotes one aggregate; duplicate Item rows are
    // already invalid and must not multiply ancillary scans or staged arrays.
    expect(result).toMatchObject({ canConfirm: false, previewToken: null })
    expect(valueTypeReads).toBeLessThanOrEqual(256)
  })

  it('fails preview for retired targets, RETIRE identity mismatch, UPDATE SKU collision, and duplicate target IDs', async () => {
    const cases = [
      {
        workbook: makeUpdateWorkbook(),
        rows: [itemRow('catalog-item-1', 'SKU-001', 'SKU-001', { status: 'RETIRED' })],
        code: 'CATALOG_ITEM_RETIRED',
      },
      {
        workbook: (() => {
          const value = validWorkbook()
          const item = value.sheets.Items.rows[0]!.values
          item.operation = text('RETIRE')
          item.catalog_item_id = text('catalog-item-1')
          item.expected_revision = number('8')
          return value
        })(),
        rows: [itemRow('catalog-item-1', 'SKU-OTHER', 'SKU-OTHER')],
        code: 'CATALOG_TARGET_IDENTITY_MISMATCH',
      },
      {
        workbook: makeUpdateWorkbook(),
        rows: [itemRow('catalog-item-1', 'SKU-OLD', 'SKU-OLD'), itemRow('catalog-item-2', 'SKU-001', 'SKU-001')],
        code: 'CATALOG_VALUE_ALREADY_EXISTS',
      },
      {
        workbook: (() => {
          const value = makeUpdateWorkbook()
          value.sheets.Items.rows.push({
            sourceRow: 3,
            values: { ...value.sheets.Items.rows[0]!.values, corporate_sku: text('SKU-002') },
          })
          return value
        })(),
        rows: [itemRow('catalog-item-1', 'SKU-001', 'SKU-001')],
        code: 'CATALOG_WORKBOOK_DUPLICATE',
      },
    ]

    for (const testCase of cases) {
      const h = makeHarness(testCase.workbook)
      h.tx.catalogItem.findMany.mockResolvedValue(testCase.rows)
      const result = await h.service.preview(context, upload)
      expect(result).toMatchObject({ canConfirm: false, previewToken: null })
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ error_code: testCase.code })]))
    }
  })

  it.each([
    ['missing', blank()],
    ['stale', number('99')],
  ])('reports %s retained value revision on the exact ancillary row', async (_label, revisionCell) => {
    const workbook = makeUpdateWorkbook()
    workbook.sheets.OrganizationValues.rows[0]!.values.expected_rule_revision = revisionCell
    const h = makeHarness(workbook)
    h.tx.catalogItem.findMany.mockResolvedValue([itemRow('catalog-item-1', 'SKU-001', 'SKU-001')])
    h.tx.catalogItemPrice.findMany.mockResolvedValue([
      {
        id: 'price-sale',
        catalogItemId: 'catalog-item-1',
        kind: 'SALE_PRICE',
        scope: 'ORGANIZATION',
        currency: 'MXN',
        revision: 2,
        active: true,
      },
      {
        id: 'price-cost',
        catalogItemId: 'catalog-item-1',
        kind: 'PURCHASE_COST',
        scope: 'ORGANIZATION',
        currency: 'MXN',
        revision: 3,
        active: true,
      },
    ])

    const result = await h.service.preview(context, upload)

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_sheet: 'OrganizationValues',
          source_row: 2,
          column: 'expected_rule_revision',
          error_code: 'CATALOG_VALUE_REVISION_CONFLICT',
        }),
      ]),
    )
  })

  it('rejects expected revisions on newly introduced organization-value keys', async () => {
    const workbook = makeUpdateWorkbook()
    workbook.sheets.OrganizationValues.rows.push(
      row(4, {
        corporate_sku: text('SKU-001'),
        value_type: text('SALE_PRICE'),
        amount: number('12.00'),
        currency: text('USD'),
        expected_rule_revision: number('7'),
      }),
      row(5, {
        corporate_sku: text('SKU-001'),
        value_type: text('PURCHASE_COST'),
        amount: number('8.00'),
        currency: text('USD'),
        expected_rule_revision: number('8'),
      }),
    )
    const h = makeHarness(workbook)
    h.tx.catalogItem.findMany.mockResolvedValue([itemRow('catalog-item-1', 'SKU-001', 'SKU-001')])
    h.tx.catalogItemPrice.findMany.mockResolvedValue([
      {
        id: 'price-sale',
        catalogItemId: 'catalog-item-1',
        kind: 'SALE_PRICE',
        scope: 'ORGANIZATION',
        currency: 'MXN',
        revision: 2,
        active: true,
      },
      {
        id: 'price-cost',
        catalogItemId: 'catalog-item-1',
        kind: 'PURCHASE_COST',
        scope: 'ORGANIZATION',
        currency: 'MXN',
        revision: 3,
        active: true,
      },
    ])

    const result = await h.service.preview(context, upload)

    // WHY: A new durable rule has no revision authority to compare; carrying a
    // submitted CAS value is a row error, not a confirm-time Task 5 surprise.
    expect(result).toMatchObject({ canConfirm: false, previewToken: null })
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_row: 4, column: 'expected_rule_revision', error_code: 'CATALOG_VALUE_REVISION_CONFLICT' }),
        expect.objectContaining({ source_row: 5, column: 'expected_rule_revision', error_code: 'CATALOG_VALUE_REVISION_CONFLICT' }),
      ]),
    )
  })

  it('keeps invalid target IDs out of the tenant FK and reports identity/revision independently', async () => {
    const workbook = makeUpdateWorkbook()
    workbook.sheets.Items.rows[0]!.values.catalog_item_id = text('foreign-item')
    workbook.sheets.Items.rows[0]!.values.expected_revision = blank()
    const h = makeHarness(workbook)

    const result = await h.service.preview(context, upload)

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'catalog_item_id', error_code: 'CATALOG_TARGET_NOT_FOUND' }),
        expect.objectContaining({ column: 'expected_revision', error_code: 'CATALOG_REVISION_INVALID' }),
      ]),
    )
    expect(result.errors).not.toEqual(expect.arrayContaining([expect.objectContaining({ error_code: 'CATALOG_ITEM_RETIRED' })]))
    const staged = h.tx.catalogImportLine.createMany.mock.calls[0]?.[0].data as Array<{ sourceSheet: string; catalogItemId: string | null }>
    expect(staged.find(line => line.sourceSheet === 'Items')?.catalogItemId).toBeNull()
  })

  it('rejects invalid binding action, cross-venue Product, foreign category, money, and Venue currency', async () => {
    const workbook = validWorkbook()
    workbook.sheets.VenueBindingRequests.rows.push(
      row(2, {
        corporate_sku: text('SKU-001'),
        venue_id: text('venue-a'),
        requested_action: text('DELETE'),
        product_id: blank(),
        local_sku: blank(),
        category_id: blank(),
        initial_price: blank(),
        currency: blank(),
      }),
      row(3, {
        corporate_sku: text('SKU-001'),
        venue_id: text('venue-a'),
        requested_action: text('LINK'),
        product_id: text('product-b'),
        local_sku: blank(),
        category_id: blank(),
        initial_price: blank(),
        currency: blank(),
      }),
      row(4, {
        corporate_sku: text('SKU-001'),
        venue_id: text('venue-a'),
        requested_action: text('CREATE'),
        product_id: blank(),
        local_sku: text('LOCAL-1'),
        category_id: text('category-b'),
        initial_price: number('999999999.999'),
        currency: text('usd'),
      }),
    )
    const h = makeHarness(workbook)
    h.tx.venue.findMany.mockResolvedValue([{ id: 'venue-a', currency: 'MXN' }])
    h.tx.product.findMany.mockResolvedValue([{ id: 'product-b', venueId: 'venue-b' }])
    h.tx.menuCategory.findMany.mockResolvedValue([{ id: 'category-b', venueId: 'venue-b' }])

    const result = await h.service.preview(context, upload)

    expect(result).toMatchObject({ canConfirm: false, previewToken: null })
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_row: 2, column: 'requested_action', error_code: 'CATALOG_BINDING_ACTION_INVALID' }),
        expect.objectContaining({ source_row: 3, column: 'product_id', error_code: 'CATALOG_TARGET_NOT_FOUND' }),
        expect.objectContaining({ source_row: 4, column: 'category_id', error_code: 'CATALOG_TARGET_NOT_FOUND' }),
        expect.objectContaining({ source_row: 4, column: 'initial_price', error_code: 'CATALOG_MONEY_INVALID' }),
        expect.objectContaining({ source_row: 4, column: 'currency', error_code: 'CATALOG_CURRENCY_INVALID' }),
      ]),
    )
  })

  it('reports every independent fiscal/unit error on its exact column with safe message and suggestion', async () => {
    const workbook = validWorkbook()
    const item = workbook.sheets.Items.rows[0]!.values
    item.unit = text('BAD_UNIT')
    item.iva_rate = number('2.0000')
    item.sat_product_key = text('abc')
    item.sat_unit_key = text('')
    item.objeto_imp = text('99')
    item.ieps_mode = text('BAD_IEPS')

    const result = await makeHarness(workbook).service.preview(context, upload)

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'unit', error_code: 'CATALOG_UNIT_INVALID' }),
        expect.objectContaining({ column: 'iva_rate', error_code: 'CATALOG_DECIMAL_INVALID' }),
        expect.objectContaining({ column: 'sat_product_key', error_code: 'CATALOG_SAT_PRODUCT_KEY_INVALID' }),
        expect.objectContaining({ column: 'sat_unit_key', error_code: 'CATALOG_BASELINE_INCOMPLETE' }),
        expect.objectContaining({ column: 'objeto_imp', error_code: 'CATALOG_OBJETO_IMP_INVALID' }),
        expect.objectContaining({ column: 'ieps_mode', error_code: 'CATALOG_IEPS_INVALID' }),
      ]),
    )
    expect(result.errors.every(error => Boolean(error.message.trim()) && Boolean(error.suggestion.trim()))).toBe(true)
    expect(result.errors.every(error => (error.rejected_value?.length ?? 0) <= 128)).toBe(true)
  })

  it('attributes independent IEPS decimal and unit failures to their submitted cells', async () => {
    const workbook = validWorkbook()
    const item = workbook.sheets.Items.rows[0]!.values
    item.ieps_mode = text('BOTH')
    item.ieps_rate = number('0.1234567')
    item.ieps_quota = number('100000000.0000')
    item.ieps_quota_unit = text('BAD_UNIT')

    const result = await makeHarness(workbook).service.preview(context, upload)

    // WHY: The user can repair all three independent cells in one pass; an
    // aggregate ieps_mode error must not hide the rejected numeric/unit value.
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'ieps_rate', error_code: 'CATALOG_DECIMAL_INVALID', rejected_value: '0.1234567' }),
        expect.objectContaining({ column: 'ieps_quota', error_code: 'CATALOG_DECIMAL_INVALID', rejected_value: '100000000.0000' }),
        expect.objectContaining({ column: 'ieps_quota_unit', error_code: 'CATALOG_IEPS_INVALID', rejected_value: 'BAD_UNIT' }),
      ]),
    )
  })

  it('keeps retired/ambiguous reference errors tenant-safe while preserving stable status vocabulary', async () => {
    const h = makeHarness()
    h.tx.catalogBrand.findMany.mockResolvedValue([
      {
        id: 'brand-retired',
        name: 'Marca Uno',
        normalizedName: 'MARCA UNO',
        status: CatalogReferenceStatus.RETIRED,
        revision: 2,
      },
    ])
    const result = await h.service.preview(context, upload)
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ column: 'brand', error_code: 'CATALOG_REFERENCE_RETIRED' })]),
    )
  })

  it('rejects a FAMILY name reused as both root and leaf before confirmation', async () => {
    const workbook = validWorkbook()
    workbook.sheets.Items.rows[0]!.values.family = text('Snacks')
    workbook.sheets.Items.rows[0]!.values.subfamily = text(' snacks ')
    const h = makeHarness(workbook)
    h.tx.catalogFamily.findMany.mockResolvedValue([])

    const result = await h.service.preview(context, upload)

    expect(result).toMatchObject({ canConfirm: false, previewToken: null })
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ column: 'subfamily', error_code: 'CATALOG_FAMILY_HIERARCHY_CONFLICT' })]),
    )
  })

  it('fails closed for applicable profile rules without a V1 evaluator but ignores non-applicable rules', async () => {
    const unsupportedProfile = {
      id: 'profile-1',
      active: true,
      profileVersion: 2,
      rulesSchemaVersion: 1,
      businessType: BusinessType.RETAIL_STORE,
      operationalRole: null,
      requiredFields: [],
      additionalRules: { enforcePositiveShelfLife: true },
    }
    const blocked = makeHarness()
    blocked.tx.catalogValidationProfile.findMany.mockResolvedValue([unsupportedProfile])

    const result = await blocked.service.preview(context, upload)

    expect(result).toMatchObject({ canConfirm: false, previewToken: null })
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ error_code: 'CATALOG_VALIDATION_RULE_UNSUPPORTED' })]))

    const unrelated = makeHarness()
    unrelated.tx.catalogValidationProfile.findMany.mockResolvedValue([{ ...unsupportedProfile, businessType: BusinessType.RESTAURANT }])
    await expect(unrelated.service.preview(context, upload)).resolves.toMatchObject({ canConfirm: true, errors: [] })
  })
})
