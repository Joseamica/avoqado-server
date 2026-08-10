import { createHash } from 'node:crypto'
import { BusinessType, CatalogReferenceStatus, ProductType } from '@prisma/client'
import {
  CATALOG_IMPORT_CONFIRM_TRANSACTION_OPTIONS,
  CATALOG_IMPORT_PREVIEW_TRANSACTION_OPTIONS,
} from '@/services/master-catalog/catalogImport.types'
import {
  CATALOG_IMPORT_LINE_CHUNK_SIZE,
  CATALOG_IMPORT_PREVIEW_ERROR_LIMIT,
} from '@/services/master-catalog/catalogImportStagingPersistence.service'
import type { ParsedMasterCatalogWorkbook } from '@/workers/masterCatalogXlsx.worker'
import {
  blank,
  context,
  makeHarness,
  number,
  organizationId,
  referenceRows,
  row,
  text,
  upload,
  validWorkbook,
} from './catalogImportTestHarness'

describe('catalogImport.service preview', () => {
  it('rejects a revoked actor before parsing and rechecks access before staging', async () => {
    const denied = makeHarness()
    denied.assertLiveAccessTx.mockRejectedValueOnce(Object.assign(new Error('denied'), { statusCode: 403, code: 'FORBIDDEN' }))

    await expect(denied.service.preview(context, upload)).rejects.toMatchObject({ statusCode: 403 })
    expect(denied.parseWorkbook).not.toHaveBeenCalled()
    expect(denied.tx.catalogImportBatch.create).not.toHaveBeenCalled()

    const revokedDuringParse = makeHarness()
    revokedDuringParse.assertLiveAccessTx
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('revoked'), { statusCode: 403, code: 'FORBIDDEN' }))
    await expect(revokedDuringParse.service.preview(context, upload)).rejects.toMatchObject({ statusCode: 403 })
    expect(revokedDuringParse.parseWorkbook).toHaveBeenCalledTimes(1)
    expect(revokedDuringParse.tx.catalogImportBatch.create).not.toHaveBeenCalled()
  })

  it('stages a complete valid workbook and never writes CatalogItem, Product, or bindings during preview', async () => {
    const h = makeHarness()

    const result = await h.service.preview(context, upload)

    expect(result).toMatchObject({
      importBatchId: 'import-batch-1',
      canConfirm: true,
      previewToken: 'preview-secret-token',
      errors: [],
      blockingReasons: [],
      capacity: { measurement: 'EXACT', workUnits: 42, withinLimit: true },
    })
    expect(h.tx.catalogImportBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId,
          state: 'PREVIEWED',
          previewTokenHash: createHash('sha256').update('preview-secret-token').digest('hex'),
          dependencies: expect.objectContaining({
            capacity: expect.objectContaining({ measurement: 'EXACT', workUnits: 42, withinLimit: true }),
          }),
        }),
      }),
    )
    expect(h.tx.catalogImportLine.createMany).toHaveBeenCalled()
    const durableLines = h.tx.catalogImportLine.createMany.mock.calls.flatMap(call => call[0].data) as Array<{
      sourceSheet: string
      sourceRow: number
      payload: Record<string, unknown>
    }>
    // WHY: Preview persists the natural source-coordinate grain, including
    // valid ancillary rows, so human review and confirm hash identical data.
    expect(durableLines.map(line => `${line.sourceSheet}:${line.sourceRow}`)).toEqual([
      'BusinessTypes:2',
      'Items:2',
      'OrganizationValues:2',
      'OrganizationValues:3',
    ])
    expect(durableLines.find(line => line.sourceSheet === 'OrganizationValues')?.payload).toMatchObject({
      section: 'ORGANIZATION_VALUES',
      corporateSku: 'SKU-001',
      amount: '100.00',
    })
    expect(h.tx.catalogItem.create).not.toHaveBeenCalled()
    expect(h.tx.product.create).not.toHaveBeenCalled()
    expect(h.tx.catalogVenueBinding.create).not.toHaveBeenCalled()
    expect(h.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), CATALOG_IMPORT_PREVIEW_TRANSACTION_OPTIONS)
  })

  it('maps Prisma transaction timeouts to one stable rollback-safe error for preview and confirm', async () => {
    for (const operation of ['preview', 'confirm'] as const) {
      const h = makeHarness()
      h.prisma.$transaction.mockRejectedValue(Object.assign(new Error('Transaction already closed'), { code: 'P2028' }))
      const promise =
        operation === 'preview'
          ? h.service.preview(context, upload)
          : h.service.confirm(context, {
              importBatchId: 'import-batch-1',
              previewToken: 'token',
              confirm: true,
              idempotencyKey: 'key-1',
            })
      await expect(promise).rejects.toMatchObject({ statusCode: 503, code: 'CATALOG_IMPORT_TRANSACTION_TIMEOUT' })
      if (operation === 'confirm') {
        expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), CATALOG_IMPORT_CONFIRM_TRANSACTION_OPTIONS)
      }
    }
  })

  it('returns multiple stable errors for one hostile row and makes confirmation unavailable', async () => {
    const workbook = validWorkbook()
    const values = workbook.sheets.Items.rows[0]!.values
    values.corporate_sku = number('123')
    values.item_kind = text('UNKNOWN')
    values.image_url = text('javascript:alert(1)')
    values.product_type = text('UNKNOWN_ALIAS')
    values.iva_rate = number('1e-1')
    values.ieps_mode = text('RATE')
    workbook.sheets.OrganizationValues.rows[0]!.values.currency = text('mxn')
    const h = makeHarness(workbook)

    const result = await h.service.preview(context, upload)

    expect(result.canConfirm).toBe(false)
    expect(result.previewToken).toBeNull()
    expect(result).toMatchObject({
      capacity: { measurement: 'EXACT', withinLimit: true },
      blockingReasons: [expect.objectContaining({ code: 'CATALOG_IMPORT_VALIDATION_FAILED' })],
    })
    expect(result.errors.filter(error => error.source_sheet === 'Items' && error.source_row === 2).length).toBeGreaterThan(1)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'corporate_sku', error_code: 'CATALOG_CODE_MUST_BE_TEXT' }),
        expect.objectContaining({ column: 'image_url', error_code: 'CATALOG_IMAGE_URL_INVALID' }),
        expect.objectContaining({ column: 'product_type', error_code: 'CATALOG_PRODUCT_TYPE_MAPPING_MISSING' }),
        expect.objectContaining({ column: 'currency', error_code: 'CATALOG_CURRENCY_INVALID' }),
      ]),
    )
    expect(result.errors.every(error => (error.rejected_value?.length ?? 0) <= 128)).toBe(true)
    expect(h.tx.catalogImportBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'FAILED',
          failureCode: 'CATALOG_IMPORT_VALIDATION_FAILED',
          failureMessage: expect.any(String),
          completedAt: new Date('2026-08-08T20:00:00.000Z'),
        }),
      }),
    )
    expect(h.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
  })

  it('stages maximum-shaped diagnostics in checked chunks and bounds the immediate API response', async () => {
    const workbook = validWorkbook()
    const template = workbook.sheets.Items.rows[0]!.values
    workbook.sheets.Items.rows = Array.from({ length: CATALOG_IMPORT_LINE_CHUNK_SIZE + 1 }, (_, index) =>
      row(index + 2, { ...template, corporate_sku: text(`SKU-${index}`), unit: text('INVALID_UNIT') }),
    )
    const h = makeHarness(workbook)
    h.tx.catalogImportLine.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }))

    const result = await h.service.preview(context, upload)

    // WHY: Full findings stay durable, while HTTP serialization is explicitly
    // bounded and every Prisma statement stays below the bind envelope.
    expect(h.tx.catalogImportLine.createMany.mock.calls.length).toBeGreaterThan(1)
    for (const [call] of h.tx.catalogImportLine.createMany.mock.calls) {
      expect(call.data.length).toBeLessThanOrEqual(CATALOG_IMPORT_LINE_CHUNK_SIZE)
    }
    expect(result.errors).toHaveLength(CATALOG_IMPORT_PREVIEW_ERROR_LIMIT)
    expect(result).toMatchObject({ errorsTruncated: true, errorCount: expect.any(Number) })
    expect(result.errorCount).toBeGreaterThan(result.errors.length)
  })

  it('rejects an import with zero Items during preview and never returns a confirmation token', async () => {
    const workbook = validWorkbook()
    workbook.sheets.Items.rows = []
    workbook.sheets.OrganizationValues.rows = []
    workbook.sheets.BusinessTypes.rows = []
    const h = makeHarness(workbook)

    const result = await h.service.preview(context, upload)

    expect(result).toMatchObject({ canConfirm: false, previewToken: null })
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ source_sheet: 'Items', error_code: 'CATALOG_IMPORT_EMPTY' })]),
    )
  })

  it.each([
    [
      'schema version',
      (workbook: ParsedMasterCatalogWorkbook) => (workbook.sheets.Metadata.rows[1]!.values.value = text('2')),
      'CATALOG_WORKBOOK_SCHEMA_UNSUPPORTED',
    ],
    [
      'duplicate item',
      (workbook: ParsedMasterCatalogWorkbook) => workbook.sheets.Items.rows.push({ ...workbook.sheets.Items.rows[0]!, sourceRow: 3 }),
      'CATALOG_WORKBOOK_DUPLICATE',
    ],
    [
      'retired reference',
      (_workbook: ParsedMasterCatalogWorkbook, h: ReturnType<typeof makeHarness>) =>
        (h.tx.catalogBrand.findMany = jest
          .fn()
          .mockResolvedValue([{ ...referenceRows().brands[0], status: CatalogReferenceStatus.RETIRED }])),
      'CATALOG_REFERENCE_RETIRED',
    ],
    [
      'incomplete profile',
      (_workbook: ParsedMasterCatalogWorkbook, h: ReturnType<typeof makeHarness>) =>
        h.tx.catalogValidationProfile.findMany.mockResolvedValue([
          {
            rulesSchemaVersion: 1,
            businessType: null,
            operationalRole: null,
            requiredFields: ['supplierCode'],
            active: true,
            id: 'profile-1',
            profileVersion: 2,
          },
        ]),
      'CATALOG_PROFILE_FIELD_MISSING',
    ],
  ])('fails closed for %s without operational writes', async (_label, arrange, code) => {
    const workbook = validWorkbook()
    const h = makeHarness(workbook)
    arrange(workbook, h)

    const result = await h.service.preview(context, upload)

    expect(result.canConfirm).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ error_code: code })]))
    expect(h.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
  })

  it('stages venue requests only after tenant-safe venue/Product validation and never materializes them', async () => {
    const workbook = validWorkbook()
    workbook.sheets.VenueBindingRequests.rows.push(
      row(2, {
        corporate_sku: text('SKU-001'),
        venue_id: text('venue-foreign'),
        requested_action: text('LINK'),
        product_id: text('product-foreign'),
        local_sku: blank(),
        category_id: blank(),
        initial_price: blank(),
        currency: blank(),
      }),
    )
    const h = makeHarness(workbook)

    const result = await h.service.preview(context, upload)

    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ source_sheet: 'VenueBindingRequests', error_code: 'CATALOG_TARGET_NOT_FOUND' })]),
    )
    expect(h.tx.product.create).not.toHaveBeenCalled()
    expect(h.tx.product.update).not.toHaveBeenCalled()
    expect(h.tx.catalogVenueBinding.create).not.toHaveBeenCalled()
  })

  it('lets canonical ProductType bypass aliases but captures one active versioned alias dependency', async () => {
    const canonical = makeHarness()
    await canonical.service.preview(context, upload)
    expect(canonical.tx.catalogProductTypeMapping.findMany).not.toHaveBeenCalled()

    const workbook = validWorkbook()
    workbook.sheets.Items.rows[0]!.values.product_type = text('ARTICULO_REGULAR')
    const alias = makeHarness(workbook)
    alias.tx.catalogProductTypeMapping.findMany.mockResolvedValue([
      { id: 'mapping-1', catalogProductType: 'ARTICULO_REGULAR', productType: ProductType.REGULAR, mappingVersion: 7, active: true },
    ])

    const result = await alias.service.preview(context, upload)

    expect(result.canConfirm).toBe(true)
    expect(alias.tx.catalogImportBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dependencies: expect.objectContaining({
            mappings: expect.arrayContaining([expect.objectContaining({ id: 'mapping-1', mappingVersion: 7 })]),
          }),
        }),
      }),
    )
  })

  it('stages normalized CREATE_REFERENCE proposals instead of silently inserting unknown references during preview', async () => {
    const h = makeHarness()
    h.tx.catalogBrand.findMany.mockResolvedValue([])
    h.tx.catalogManufacturer.findMany.mockResolvedValue([])
    h.tx.catalogFamily.findMany.mockResolvedValue([])

    const result = await h.service.preview(context, upload)

    expect(result.canConfirm).toBe(true)
    const staged = h.tx.catalogImportLine.createMany.mock.calls[0]?.[0].data as Array<{ sourceSheet: string; payload: unknown }>
    expect(staged.find(line => line.sourceSheet === 'Items')?.payload).toEqual(
      expect.objectContaining({
        referenceProposals: expect.arrayContaining([
          expect.objectContaining({ operation: 'CREATE', referenceType: 'BRAND', name: 'Marca Uno' }),
          expect.objectContaining({ operation: 'CREATE', referenceType: 'MANUFACTURER', name: 'Fabricante Uno' }),
          expect.objectContaining({ operation: 'CREATE', referenceType: 'FAMILY', name: 'Familia Uno', parentId: null }),
          expect.objectContaining({ operation: 'CREATE', referenceType: 'FAMILY', name: 'Subfamilia Uno' }),
        ]),
      }),
    )
    expect(h.applyCatalogReferenceProposalsTx).not.toHaveBeenCalled()
  })

  it('synthesizes revision-bound deactivations for active organization values omitted by a complete UPDATE', async () => {
    const workbook = validWorkbook()
    const item = workbook.sheets.Items.rows[0]!.values
    item.operation = text('UPDATE')
    item.catalog_item_id = text('catalog-item-1')
    item.expected_revision = number('8')
    workbook.sheets.OrganizationValues.rows[0]!.values.expected_rule_revision = number('2')
    workbook.sheets.OrganizationValues.rows[1]!.values.expected_rule_revision = number('3')
    const h = makeHarness(workbook)
    h.tx.catalogItem.findMany.mockResolvedValue([
      {
        id: 'catalog-item-1',
        sku: 'SKU-001',
        normalizedSku: 'SKU-001',
        status: 'ACTIVE',
        revision: 8,
        invariantVersion: 12n,
        businessTypes: [{ businessType: BusinessType.RETAIL_STORE }],
      },
    ])
    h.tx.catalogItemPrice.findMany.mockResolvedValue([
      {
        id: 'price-1',
        catalogItemId: 'catalog-item-1',
        kind: 'SALE_PRICE',
        scope: 'ORGANIZATION',
        currency: 'MXN',
        revision: 2,
        active: true,
      },
      {
        id: 'price-2',
        catalogItemId: 'catalog-item-1',
        kind: 'PURCHASE_COST',
        scope: 'ORGANIZATION',
        currency: 'MXN',
        revision: 3,
        active: true,
      },
      {
        id: 'price-3',
        catalogItemId: 'catalog-item-1',
        kind: 'SALE_PRICE',
        scope: 'ORGANIZATION',
        currency: 'USD',
        revision: 4,
        active: true,
      },
      {
        id: 'price-history',
        catalogItemId: 'catalog-item-1',
        kind: 'PURCHASE_COST',
        scope: 'ORGANIZATION',
        currency: 'EUR',
        revision: 1,
        active: false,
      },
    ])

    const result = await h.service.preview(context, upload)

    expect(result.canConfirm).toBe(true)
    const staged = h.tx.catalogImportLine.createMany.mock.calls[0]?.[0].data as Array<{
      sourceSheet: string
      payload: { command: { input: { organizationValueDeactivations: unknown[] } } }
    }>
    expect(staged.find(line => line.sourceSheet === 'Items')?.payload.command.input.organizationValueDeactivations).toEqual([
      { kind: 'SALE_PRICE', currency: 'USD', expectedRuleRevision: 4 },
    ])
    expect(h.tx.catalogImportBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dependencies: expect.objectContaining({
            items: [
              expect.objectContaining({
                id: 'catalog-item-1',
                revision: 8,
                invariantVersion: '12',
                status: 'ACTIVE',
                businessTypes: [BusinessType.RETAIL_STORE],
              }),
            ],
            organizationValues: expect.arrayContaining([expect.objectContaining({ id: 'price-3', scope: 'ORGANIZATION', active: true })]),
          }),
        }),
      }),
    )
    const dependencySnapshot = h.tx.catalogImportBatch.create.mock.calls[0]?.[0].data.dependencies as {
      organizationValues: Array<{ id: string }>
    }
    expect(dependencySnapshot.organizationValues.map(value => value.id)).not.toContain('price-history')
  })

  it('classifies duplicate normalized references as ambiguous and stages no hidden choice', async () => {
    const h = makeHarness()
    h.tx.catalogBrand.findMany.mockResolvedValue([
      referenceRows().brands[0],
      { ...referenceRows().brands[0], id: 'brand-duplicate', revision: 9 },
    ])

    const result = await h.service.preview(context, upload)

    expect(result.canConfirm).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ column: 'brand', error_code: 'CATALOG_REFERENCE_AMBIGUOUS' })]),
    )
  })

  it('classifies an ACTIVE FAMILY reused as its own leaf as a hierarchy conflict', async () => {
    const workbook = validWorkbook()
    workbook.sheets.Items.rows[0]!.values.subfamily = text('Familia Uno')
    const h = makeHarness(workbook)

    const result = await h.service.preview(context, upload)

    expect(result.errors.filter(error => error.column === 'subfamily')).toEqual([
      expect.objectContaining({ error_code: 'CATALOG_FAMILY_HIERARCHY_CONFLICT', source_sheet: 'Items', source_row: 2 }),
    ])
    expect(result.canConfirm).toBe(false)
  })

  it('rejects every ancillary coordinate attached to identity-only RETIRE before issuing a bearer', async () => {
    const workbook = validWorkbook()
    const item = workbook.sheets.Items.rows[0]!.values
    item.operation = text('RETIRE')
    item.catalog_item_id = text('catalog-item-1')
    item.expected_revision = number('7')
    workbook.sheets.VenueBindingRequests.rows = [
      row(2, {
        corporate_sku: text('SKU-001'),
        venue_id: text('venue-1'),
        requested_action: text('SKIP'),
        product_id: blank(),
        local_sku: blank(),
        category_id: blank(),
        initial_price: blank(),
        currency: blank(),
      }),
    ]
    const h = makeHarness(workbook)
    h.tx.catalogItem.findMany.mockResolvedValue([
      {
        id: 'catalog-item-1',
        sku: 'SKU-001',
        normalizedSku: 'SKU-001',
        status: 'ACTIVE',
        revision: 7,
        invariantVersion: 1n,
        businessTypes: [{ businessType: BusinessType.RETAIL_STORE }],
      },
    ])
    h.tx.venue.findMany.mockResolvedValue([{ id: 'venue-1', currency: 'MXN' }])

    const result = await h.service.preview(context, upload)

    expect(result).toMatchObject({ canConfirm: false, previewToken: null })
    expect(
      result.errors
        .filter(error => error.error_code === 'CATALOG_RETIRE_ANCILLARY_FORBIDDEN')
        .map(error => `${error.source_sheet}:${error.source_row}`),
    ).toEqual(['OrganizationValues:2', 'OrganizationValues:3', 'BusinessTypes:2', 'VenueBindingRequests:2'])
  })
})
