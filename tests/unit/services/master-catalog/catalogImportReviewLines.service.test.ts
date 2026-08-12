import { BusinessType, type Prisma } from '@prisma/client'
import {
  assertCatalogImportReviewLinesMatchItemsV1,
  buildCatalogImportReviewLinesV1,
  parseCatalogImportReviewLinesV1,
} from '@/services/master-catalog/catalogImportReviewLines.service'
import type { CatalogImportRowError, CatalogImportStagedLine } from '@/services/master-catalog/catalogImport.types'
import type { CatalogImportLineRowV1 } from '@/services/master-catalog/catalogImportStagedPayload.service'
import { blank, durableJsonFixture, number, row, text, validStagedPayload, validWorkbook } from './catalogImportTestHarness'

function durableReviewLines(lines: readonly CatalogImportStagedLine[]): CatalogImportLineRowV1[] {
  return lines.map((line, index) => ({ ...line, id: `review-${index}`, payload: durableJsonFixture(line.payload), errors: null }))
}

function reviewPayload(line: CatalogImportLineRowV1): Prisma.JsonObject {
  if (line.payload === null || Array.isArray(line.payload) || typeof line.payload !== 'object') {
    throw new Error('CATALOG_IMPORT_TEST_FIXTURE_INVALID')
  }
  return line.payload
}

describe('catalog import review-line authority', () => {
  it('projects every original ancillary coordinate into a closed normalized line', async () => {
    const workbook = validWorkbook()
    workbook.sheets.VenueBindingRequests.rows = [
      row(7, {
        corporate_sku: text(' sku-001 '),
        venue_id: text('venue-1'),
        requested_action: text('CREATE'),
        product_id: blank(),
        local_sku: text(' local-1 '),
        category_id: text('category-1'),
        initial_price: number('25.5'),
        currency: text('MXN'),
      }),
    ]

    const lines = await buildCatalogImportReviewLinesV1(workbook, [], async () => undefined)

    expect(lines).toEqual([
      {
        sourceSheet: 'OrganizationValues',
        sourceRow: 2,
        status: 'READY',
        payload: {
          schemaVersion: 1,
          section: 'ORGANIZATION_VALUES',
          corporateSku: 'SKU-001',
          kind: 'SALE_PRICE',
          amount: '100.00',
          currency: 'MXN',
          expectedRuleRevision: null,
        },
        errors: [],
        catalogItemId: null,
      },
      {
        sourceSheet: 'OrganizationValues',
        sourceRow: 3,
        status: 'READY',
        payload: {
          schemaVersion: 1,
          section: 'ORGANIZATION_VALUES',
          corporateSku: 'SKU-001',
          kind: 'PURCHASE_COST',
          amount: '50.00',
          currency: 'MXN',
          expectedRuleRevision: null,
        },
        errors: [],
        catalogItemId: null,
      },
      {
        sourceSheet: 'BusinessTypes',
        sourceRow: 2,
        status: 'READY',
        payload: {
          schemaVersion: 1,
          section: 'BUSINESS_TYPES',
          corporateSku: 'SKU-001',
          businessType: BusinessType.RETAIL_STORE,
        },
        errors: [],
        catalogItemId: null,
      },
      {
        sourceSheet: 'VenueBindingRequests',
        sourceRow: 7,
        status: 'READY',
        payload: {
          schemaVersion: 1,
          section: 'VENUE_BINDING_REQUESTS',
          corporateSku: 'SKU-001',
          venueId: 'venue-1',
          requestedAction: 'CREATE',
          productId: null,
          localSku: 'LOCAL-1',
          categoryId: 'category-1',
          initialPrice: '25.50',
          currency: 'MXN',
        },
        errors: [],
        catalogItemId: null,
      },
    ])
  })

  it('keeps invalid source rows reviewable with null canonical fields and exact findings', async () => {
    const workbook = validWorkbook()
    workbook.sheets.OrganizationValues.rows = [
      row(9, {
        corporate_sku: blank(),
        value_type: text('WAT'),
        amount: text('secret-amount'),
        currency: text('mxn'),
        expected_rule_revision: text('bad'),
      }),
    ]
    const errors: CatalogImportRowError[] = [
      {
        source_sheet: 'OrganizationValues',
        source_row: 9,
        column: 'amount',
        error_code: 'CATALOG_DECIMAL_INVALID',
        rejected_value: 'secret-amount',
        message: 'Decimal inválido.',
        suggestion: 'Corrige la celda.',
      },
    ]

    const [line] = await buildCatalogImportReviewLinesV1(workbook, errors, async () => undefined)

    expect(line).toEqual({
      sourceSheet: 'OrganizationValues',
      sourceRow: 9,
      status: 'INVALID',
      payload: {
        schemaVersion: 1,
        section: 'ORGANIZATION_VALUES',
        corporateSku: null,
        kind: null,
        amount: null,
        currency: null,
        expectedRuleRevision: null,
      },
      errors,
      catalogItemId: null,
    })
  })

  it('keeps a 4096-scalar padded local SKU canonical, reviewable, and cross-checkable', async () => {
    const workbook = validWorkbook()
    const rawLocalSku = `${' '.repeat(3_840)}${'😀'.repeat(256)}`
    const localSku = '😀'.repeat(256)
    workbook.sheets.VenueBindingRequests.rows = [
      row(7, {
        corporate_sku: text('SKU-001'),
        venue_id: text('venue-1'),
        requested_action: text('CREATE'),
        product_id: blank(),
        local_sku: text(rawLocalSku),
        category_id: text('category-1'),
        initial_price: number('25.00'),
        currency: text('MXN'),
      }),
    ]
    const lines = await buildCatalogImportReviewLinesV1(workbook, [], async () => undefined)
    const reviews = await parseCatalogImportReviewLinesV1(durableReviewLines(lines))
    const item = validStagedPayload()
    item.command.input.organizationValues = [
      { kind: 'SALE_PRICE', amount: '100.00', currency: 'MXN' },
      { kind: 'PURCHASE_COST', amount: '50.00', currency: 'MXN' },
    ]
    item.venueBindingRequests = [
      {
        corporateSku: 'SKU-001',
        venueId: 'venue-1',
        requestedAction: 'CREATE',
        productId: null,
        localSku,
        categoryId: 'category-1',
        initialPrice: '25.00',
        currency: 'MXN',
      },
    ]

    expect(reviews).toEqual(expect.arrayContaining([expect.objectContaining({ section: 'VENUE_BINDING_REQUESTS', localSku })]))
    await expect(assertCatalogImportReviewLinesMatchItemsV1([item], reviews)).resolves.toBeUndefined()
  })

  it('parses closed review payloads and rejects drift from the item command arrays', async () => {
    const workbook = validWorkbook()
    const reviewLines = await buildCatalogImportReviewLinesV1(workbook, [], async () => undefined)
    const durableLines = durableReviewLines(reviewLines)
    const reviews = await parseCatalogImportReviewLinesV1(durableLines)
    const item = validStagedPayload()
    item.command.input.sku = '  sku-001  '
    item.command.input.organizationValues = [
      { kind: 'SALE_PRICE', amount: '100.00', currency: 'MXN' },
      { kind: 'PURCHASE_COST', amount: '50.00', currency: 'MXN' },
    ]

    await expect(assertCatalogImportReviewLinesMatchItemsV1([item], reviews)).resolves.toBeUndefined()

    const tampered = structuredClone(durableLines)
    reviewPayload(tampered[0]!).amount = '999.99'
    await expect(
      parseCatalogImportReviewLinesV1(tampered).then(parsed => assertCatalogImportReviewLinesMatchItemsV1([item], parsed)),
    ).rejects.toEqual(expect.objectContaining({ code: 'CATALOG_IMPORT_STAGING_INVALID', statusCode: 409 }))

    for (const drifted of [durableLines.slice(1), [...durableLines, durableLines[0]!]]) {
      await expect(
        parseCatalogImportReviewLinesV1(drifted).then(parsed => assertCatalogImportReviewLinesMatchItemsV1([item], parsed)),
      ).rejects.toEqual(expect.objectContaining({ code: 'CATALOG_IMPORT_STAGING_INVALID', statusCode: 409 }))
    }
  })

  it('accepts an explicitly empty findings array on a READY review line', async () => {
    const [reviewLine] = await buildCatalogImportReviewLinesV1(validWorkbook(), [], async () => undefined)
    if (!reviewLine) throw new Error('CATALOG_IMPORT_TEST_FIXTURE_INVALID')
    const [durableLine] = durableReviewLines([reviewLine])
    if (!durableLine) throw new Error('CATALOG_IMPORT_TEST_FIXTURE_INVALID')
    durableLine.errors = []

    await expect(parseCatalogImportReviewLinesV1([durableLine])).resolves.toHaveLength(1)
  })

  it('compares semantic fields independently of PostgreSQL jsonb key order', async () => {
    const reviewLines = await buildCatalogImportReviewLinesV1(validWorkbook(), [], async () => undefined)
    const reordered = durableReviewLines(reviewLines).map(line => ({
      ...line,
      payload: Object.fromEntries(Object.entries(reviewPayload(line)).reverse()),
    }))
    const item = validStagedPayload()
    item.command.input.organizationValues = [
      { kind: 'SALE_PRICE', amount: '100.00', currency: 'MXN' },
      { kind: 'PURCHASE_COST', amount: '50.00', currency: 'MXN' },
    ]

    const parsed = await parseCatalogImportReviewLinesV1(reordered)

    await expect(assertCatalogImportReviewLinesMatchItemsV1([item], parsed)).resolves.toBeUndefined()
  })

  it.each([
    ['amount', '100.001'],
    ['currency', 'mxn'],
    ['expectedRuleRevision', 0],
  ])('maps malformed durable OrganizationValues %s to one stable staging error', async (field, value) => {
    const lines = await buildCatalogImportReviewLinesV1(validWorkbook(), [], async () => undefined)
    const durable = durableReviewLines(lines)
    reviewPayload(durable[0]!)[field] = value

    await expect(parseCatalogImportReviewLinesV1(durable)).rejects.toEqual(
      expect.objectContaining({ code: 'CATALOG_IMPORT_STAGING_INVALID', statusCode: 409 }),
    )
  })

  it('rejects unknown review keys before command comparison', async () => {
    const lines = await buildCatalogImportReviewLinesV1(validWorkbook(), [], async () => undefined)
    const durable = durableReviewLines(lines)
    reviewPayload(durable[0]!).hidden = 'durable-secret'

    await expect(parseCatalogImportReviewLinesV1(durable)).rejects.toEqual(
      expect.objectContaining({ code: 'CATALOG_IMPORT_STAGING_INVALID', statusCode: 409 }),
    )
  })
})
