import { BusinessType, CatalogIepsMode, CatalogItemKind, CatalogReferenceStatus, ProductType, Unit, type Prisma } from '@prisma/client'
import { createCatalogImportService } from '@/services/master-catalog/catalogImport.service'
import type { CatalogImportStagedPayloadV1 } from '@/services/master-catalog/catalogImportStagedPayload.service'
import type { CatalogItemAggregateCommand } from '@/services/master-catalog/catalogItem.types'
import type { CatalogCommandContext, CatalogWorkbookUpload } from '@/types/master-catalog'
import type { ParsedMasterCatalogWorkbook, ParsedWorkbookCell } from '@/workers/masterCatalogXlsx.worker'

// WHY: Task 7 suites share one deterministic workbook/Prisma seam so security
// matrices exercise the same contract without side effects, database access,
// or divergent hand-built “valid” fixtures.
export const organizationId = 'org-pits'
export const context: CatalogCommandContext = {
  organizationId,
  actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
  orgRole: 'OWNER',
}
export const upload: CatalogWorkbookUpload = {
  buffer: Buffer.from('PK\u0003\u0004fixture', 'binary'),
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  originalFilename: 'catalog-master-import-v1.xlsx',
}

export const text = (value: string): ParsedWorkbookCell => ({ kind: 'TEXT', value })
export const number = (value: string): ParsedWorkbookCell => ({ kind: 'NUMBER', value })
export const blank = (): ParsedWorkbookCell => ({ kind: 'BLANK', value: '' })
export const row = (sourceRow: number, values: Record<string, ParsedWorkbookCell>) => ({ sourceRow, values })

// WHY: Prisma JSON rows cross a serialization boundary. Test fixtures use the
// same JSON round-trip instead of casting domain DTO interfaces into JsonValue.
export function durableJsonFixture(value: unknown): Prisma.JsonValue {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('CATALOG_IMPORT_TEST_FIXTURE_INVALID')
  return JSON.parse(serialized)
}

type ValidCreateStagedPayloadFixtureV1 = CatalogImportStagedPayloadV1 & {
  command: Extract<CatalogItemAggregateCommand, { operation: 'CREATE' }>
}

export function validStagedPayload(): ValidCreateStagedPayloadFixtureV1 {
  // WHY: Confirmation/parser tests share the exact normalized Task 5 command
  // shape produced by preview instead of weakening durable-shape assertions.
  return {
    schemaVersion: 1,
    command: {
      operation: 'CREATE' as const,
      input: {
        sku: 'SKU-001',
        kind: CatalogItemKind.RETAIL_PRODUCT,
        name: 'Producto',
        description: 'Descripción',
        imageUrl: 'https://cdn.example.test/item.png',
        brandId: 'brand-1',
        manufacturerId: 'manufacturer-1',
        familyId: 'subfamily-1',
        presentationLabel: 'Pieza',
        unit: Unit.UNIT,
        taxRate: '0.1600',
        satProductKey: '50161509',
        satUnitKey: 'H87',
        objetoImp: '02',
        productType: ProductType.REGULAR,
        iepsMode: CatalogIepsMode.NONE,
        iepsRate: null,
        iepsQuota: null,
        iepsQuotaUnit: null,
        businessTypes: [BusinessType.RETAIL_STORE],
        organizationValues: [
          { kind: 'SALE_PRICE' as const, amount: '10.00', currency: 'MXN' },
          { kind: 'PURCHASE_COST' as const, amount: '5.00', currency: 'MXN' },
        ],
      },
    },
    referenceProposals: [],
    venueBindingRequests: [],
  }
}

export function validDurableReviewLines() {
  // WHY: Confirmation and recovery tests exercise the same per-coordinate
  // review authority that preview persists, without relying on a database.
  return [
    {
      id: 'review-value-sale',
      status: 'READY',
      sourceSheet: 'OrganizationValues',
      sourceRow: 2,
      errors: null,
      catalogItemId: null,
      payload: {
        schemaVersion: 1,
        section: 'ORGANIZATION_VALUES',
        corporateSku: 'SKU-001',
        kind: 'SALE_PRICE',
        amount: '10.00',
        currency: 'MXN',
        expectedRuleRevision: null,
      },
    },
    {
      id: 'review-value-cost',
      status: 'READY',
      sourceSheet: 'OrganizationValues',
      sourceRow: 3,
      errors: null,
      catalogItemId: null,
      payload: {
        schemaVersion: 1,
        section: 'ORGANIZATION_VALUES',
        corporateSku: 'SKU-001',
        kind: 'PURCHASE_COST',
        amount: '5.00',
        currency: 'MXN',
        expectedRuleRevision: null,
      },
    },
    {
      id: 'review-business',
      status: 'READY',
      sourceSheet: 'BusinessTypes',
      sourceRow: 2,
      errors: null,
      catalogItemId: null,
      payload: { schemaVersion: 1, section: 'BUSINESS_TYPES', corporateSku: 'SKU-001', businessType: BusinessType.RETAIL_STORE },
    },
  ]
}

export function validWorkbook(): ParsedMasterCatalogWorkbook {
  const item = {
    operation: text('CREATE'),
    catalog_item_id: blank(),
    expected_revision: blank(),
    corporate_sku: text('SKU-001'),
    item_kind: text(CatalogItemKind.RETAIL_PRODUCT),
    name: text('Producto corporativo'),
    description: text('Descripción completa'),
    image_url: text('https://cdn.example.test/item.png'),
    brand: text('Marca Uno'),
    manufacturer: text('Fabricante Uno'),
    family: text('Familia Uno'),
    subfamily: text('Subfamilia Uno'),
    presentation: text('Pieza individual'),
    unit: text(Unit.UNIT),
    product_type: text(ProductType.REGULAR),
    iva_rate: number('0.1600'),
    sat_product_key: text('50161509'),
    sat_unit_key: text('H87'),
    objeto_imp: text('02'),
    ieps_mode: text('NONE'),
    ieps_rate: blank(),
    ieps_quota: blank(),
    ieps_quota_unit: blank(),
  }
  return {
    sheetNames: ['Metadata', 'Items', 'OrganizationValues', 'BusinessTypes', 'VenueBindingRequests'],
    sheets: {
      Metadata: {
        columns: ['key', 'value'],
        rows: [
          row(2, { key: text('documentType'), value: text('catalog-master-import') }),
          row(3, { key: text('schemaVersion'), value: text('1') }),
          row(4, { key: text('organizationId'), value: text(organizationId) }),
          row(5, { key: text('timezone'), value: text('America/Mexico_City') }),
        ],
      },
      Items: { columns: Object.keys(item), rows: [row(2, item)] },
      OrganizationValues: {
        columns: ['corporate_sku', 'value_type', 'amount', 'currency', 'expected_rule_revision'],
        rows: [
          row(2, {
            corporate_sku: text('SKU-001'),
            value_type: text('SALE_PRICE'),
            amount: number('100.00'),
            currency: text('MXN'),
            expected_rule_revision: blank(),
          }),
          row(3, {
            corporate_sku: text('SKU-001'),
            value_type: text('PURCHASE_COST'),
            amount: number('50.00'),
            currency: text('MXN'),
            expected_rule_revision: blank(),
          }),
        ],
      },
      BusinessTypes: {
        columns: ['corporate_sku', 'business_type'],
        rows: [row(2, { corporate_sku: text('SKU-001'), business_type: text(BusinessType.RETAIL_STORE) })],
      },
      VenueBindingRequests: {
        columns: ['corporate_sku', 'venue_id', 'requested_action', 'product_id', 'local_sku', 'category_id', 'initial_price', 'currency'],
        rows: [],
      },
    },
  }
}

export function referenceRows() {
  return {
    brands: [{ id: 'brand-1', name: 'Marca Uno', normalizedName: 'MARCA UNO', status: CatalogReferenceStatus.ACTIVE, revision: 2 }],
    manufacturers: [
      {
        id: 'manufacturer-1',
        name: 'Fabricante Uno',
        normalizedName: 'FABRICANTE UNO',
        status: CatalogReferenceStatus.ACTIVE,
        revision: 3,
      },
    ],
    families: [
      {
        id: 'family-1',
        name: 'Familia Uno',
        normalizedName: 'FAMILIA UNO',
        status: CatalogReferenceStatus.ACTIVE,
        revision: 4,
        parentId: null,
      },
      {
        id: 'subfamily-1',
        name: 'Subfamilia Uno',
        normalizedName: 'SUBFAMILIA UNO',
        status: CatalogReferenceStatus.ACTIVE,
        revision: 5,
        parentId: 'family-1',
      },
    ],
  }
}

export function makeHarness(parsed = validWorkbook()) {
  const refs = referenceRows()
  const tx = {
    catalogBrand: { findMany: jest.fn().mockResolvedValue(refs.brands) },
    catalogManufacturer: { findMany: jest.fn().mockResolvedValue(refs.manufacturers) },
    catalogFamily: { findMany: jest.fn().mockResolvedValue(refs.families) },
    catalogItem: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), update: jest.fn() },
    catalogItemPrice: { findMany: jest.fn().mockResolvedValue([]) },
    catalogProductTypeMapping: { findMany: jest.fn().mockResolvedValue([]) },
    catalogValidationProfile: { findMany: jest.fn().mockResolvedValue([]) },
    venue: { findMany: jest.fn().mockResolvedValue([]) },
    product: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), update: jest.fn() },
    menuCategory: { findMany: jest.fn().mockResolvedValue([]) },
    catalogVenueBinding: { create: jest.fn(), update: jest.fn() },
    catalogImportBatch: {
      create: jest.fn().mockResolvedValue({ id: 'import-batch-1' }),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogImportLine: {
      createMany: jest.fn().mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
      findMany: jest.fn(),
    },
    catalogIdempotencyRecord: {
      create: jest.fn().mockResolvedValue({ id: 'idempotency-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  }
  const prisma = {
    $transaction: jest.fn().mockImplementation(async (work: (client: typeof tx) => unknown) => work(tx)),
    catalogIdempotencyRecord: { findUnique: jest.fn() },
  }
  const parseWorkbook = jest.fn().mockResolvedValue(parsed)
  const applyCatalogReferenceProposalsTx = jest.fn().mockResolvedValue({ references: [], auditEnvelopes: [] })
  const applyCatalogItemAggregateTx = jest.fn().mockResolvedValue({
    detail: { id: 'catalog-item-1' },
    auditEnvelope: {
      action: 'CATALOG_ITEM_CREATED',
      entity: 'CatalogItem',
      entityId: 'catalog-item-1',
      batchId: 'import-batch-1',
    },
  })
  const writeCatalogAudit = jest.fn().mockResolvedValue(undefined)
  const assertLiveAccessTx = jest.fn().mockResolvedValue(undefined)
  const service = createCatalogImportService({
    prisma: prisma as never,
    parseWorkbook,
    applyCatalogReferenceProposalsTx,
    applyCatalogItemAggregateTx,
    writeCatalogAudit,
    assertLiveAccessTx,
    now: () => new Date('2026-08-08T20:00:00.000Z'),
    randomToken: () => 'preview-secret-token',
    randomAttemptId: () => 'preview-unused-attempt',
  })
  return {
    service,
    tx,
    prisma,
    parseWorkbook,
    applyCatalogReferenceProposalsTx,
    applyCatalogItemAggregateTx,
    writeCatalogAudit,
    assertLiveAccessTx,
  }
}
