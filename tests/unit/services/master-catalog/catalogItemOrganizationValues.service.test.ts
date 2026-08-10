import {
  BusinessType,
  CatalogIepsMode,
  CatalogItemKind,
  CatalogItemPriceKind,
  CatalogItemStatus,
  CatalogReferenceStatus,
  Prisma,
  ProductType,
  Unit,
} from '@prisma/client'

const mockWriteCatalogAudit = jest.fn()
const mockTransaction = jest.fn()

jest.mock('@/services/master-catalog/catalogAudit.service', () => ({
  writeCatalogAudit: (...args: unknown[]) => mockWriteCatalogAudit(...(args as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { $transaction: (...args: unknown[]) => mockTransaction(...(args as [])) },
}))

import { updateCatalogItem, type CreateCatalogItemInput } from '@/services/master-catalog/catalogItem.service'
import type { CatalogCommandContext } from '@/types/master-catalog'

const organizationId = 'org-pits-values'
const staffId = 'staff-owner'
const context: CatalogCommandContext = {
  organizationId,
  actor: { type: 'HUMAN', staffId, impersonating: false },
  orgRole: 'OWNER',
}

// WHY: A two-currency complete aggregate makes omission/reactivation behavior
// observable without weakening the mandatory same-currency pair invariant.
const input: CreateCatalogItemInput = {
  sku: 'SKU-VALUES-001',
  kind: CatalogItemKind.RETAIL_PRODUCT,
  name: 'Café molido',
  description: 'Bolsa de café de origen',
  imageUrl: 'https://cdn.example.test/cafe.jpg',
  brandId: 'brand-1',
  manufacturerId: 'manufacturer-1',
  familyId: 'family-leaf-1',
  presentationLabel: 'Bolsa 1 kg',
  unit: Unit.BAG,
  taxRate: '0.1600',
  satProductKey: '50201706',
  satUnitKey: 'H87',
  objetoImp: '02',
  productType: ProductType.REGULAR,
  iepsMode: CatalogIepsMode.NONE,
  iepsRate: null,
  iepsQuota: null,
  iepsQuotaUnit: null,
  businessTypes: [BusinessType.RETAIL_STORE],
  organizationValues: [
    { kind: CatalogItemPriceKind.SALE_PRICE, amount: '120.00', currency: 'MXN' },
    { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '80.50', currency: 'MXN' },
    { kind: CatalogItemPriceKind.SALE_PRICE, amount: '7.00', currency: 'USD' },
    { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '5.00', currency: 'USD' },
  ],
}

function itemRow(overrides: Record<string, unknown> = {}) {
  // WHY: The wrapper reloads the bounded detail after a successful mutation;
  // this fixture includes exactly the relations consumed by that projection.
  return {
    id: 'catalog-item-1',
    organizationId,
    ...input,
    normalizedSku: input.sku,
    status: CatalogItemStatus.ACTIVE,
    revision: 1,
    taxRate: new Prisma.Decimal(input.taxRate),
    createdById: staffId,
    updatedById: staffId,
    createdAt: new Date('2026-08-08T18:00:00.000Z'),
    updatedAt: new Date('2026-08-08T18:00:00.000Z'),
    brand: { id: 'brand-1', name: 'Marca', status: CatalogReferenceStatus.ACTIVE },
    manufacturer: { id: 'manufacturer-1', name: 'Fabricante', status: CatalogReferenceStatus.ACTIVE },
    family: {
      id: 'family-leaf-1',
      name: 'Hoja',
      status: CatalogReferenceStatus.ACTIVE,
      parent: { id: 'family-root-1', name: 'Raíz', status: CatalogReferenceStatus.ACTIVE },
    },
    businessTypes: [{ businessType: BusinessType.RETAIL_STORE }],
    prices: input.organizationValues.map((value, index) => ({
      id: `price-${index}`,
      ...value,
      amount: new Prisma.Decimal(value.amount),
      active: true,
      revision: 1,
    })),
    _count: { bindings: 0 },
    ...overrides,
  }
}

function persistedPrices(overrides: Record<string, Record<string, unknown>> = {}) {
  // WHY: Stable IDs and independent revisions are the monetary concurrency
  // contract under test; overrides model concurrent child-only writers.
  return input.organizationValues.map((value, index) => ({
    id: `price-${index}`,
    kind: value.kind,
    currency: value.currency,
    revision: 1,
    active: true,
    ...(overrides[`${value.kind}:${value.currency}`] ?? {}),
  }))
}

function buildTx() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(0),
    catalogBrand: { findFirst: jest.fn().mockResolvedValue({ id: 'brand-1' }) },
    catalogManufacturer: { findFirst: jest.fn().mockResolvedValue({ id: 'manufacturer-1' }) },
    catalogFamily: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'family-leaf-1',
        parentId: 'family-root-1',
        parent: { id: 'family-root-1', status: CatalogReferenceStatus.ACTIVE, parentId: null },
        children: [],
      }),
    },
    catalogItem: {
      findFirst: jest.fn().mockResolvedValue(itemRow()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogIdentifier: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    catalogItemBusinessType: { deleteMany: jest.fn(), createMany: jest.fn() },
    catalogItemPrice: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  }
}

let tx = buildTx()

beforeEach(() => {
  // WHY: Each CAS scenario owns a fresh transaction recorder so a rejection
  // cannot inherit writes or mock results from the preceding replacement.
  jest.clearAllMocks()
  tx = buildTx()
  mockTransaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx))
  mockWriteCatalogAudit.mockResolvedValue(undefined)
})

describe('catalogItem.service organization-value replacement', () => {
  it('deactivates omitted rules, reactivates retained inactive rules, and preserves their IDs', async () => {
    tx.catalogItem.findFirst.mockResolvedValueOnce(itemRow()).mockResolvedValueOnce(itemRow({ revision: 2 }))
    tx.catalogItemPrice.findMany.mockResolvedValueOnce(persistedPrices({ 'PURCHASE_COST:MXN': { revision: 3, active: false } }))
    const organizationValues = input.organizationValues
      .filter(value => value.currency === 'MXN')
      .map(value => ({ ...value, expectedRuleRevision: value.kind === CatalogItemPriceKind.PURCHASE_COST ? 3 : 1 }))
    const organizationValueDeactivations = input.organizationValues
      .filter(value => value.currency === 'USD')
      .map(value => ({ kind: value.kind, currency: value.currency, expectedRuleRevision: 1 }))

    await updateCatalogItem(context, {
      ...input,
      catalogItemId: 'catalog-item-1',
      expectedRevision: 1,
      organizationValues,
      organizationValueDeactivations,
    })

    expect(tx.catalogItemPrice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'price-1', revision: 3 }),
        data: expect.objectContaining({ active: true }),
      }),
    )
    for (const id of ['price-2', 'price-3']) {
      expect(tx.catalogItemPrice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id, revision: 1 }), data: expect.objectContaining({ active: false }) }),
      )
    }
    expect(tx.catalogItemPrice.create).not.toHaveBeenCalled()
  })

  it('rejects a stale omitted-rule tombstone before item or child mutation', async () => {
    tx.catalogItemPrice.findMany.mockResolvedValueOnce(persistedPrices({ 'SALE_PRICE:USD': { revision: 2 } }))
    const organizationValues = input.organizationValues
      .filter(value => value.currency === 'MXN')
      .map(value => ({ ...value, expectedRuleRevision: 1 }))
    const organizationValueDeactivations = input.organizationValues
      .filter(value => value.currency === 'USD')
      .map(value => ({ kind: value.kind, currency: value.currency, expectedRuleRevision: 1 }))

    await expect(
      updateCatalogItem(context, {
        ...input,
        catalogItemId: 'catalog-item-1',
        expectedRevision: 1,
        organizationValues,
        organizationValueDeactivations,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_VALUE_REVISION_CONFLICT' })
    expect(tx.catalogItem.updateMany).not.toHaveBeenCalled()
    expect(tx.catalogItemPrice.updateMany).not.toHaveBeenCalled()
  })

  it('requires tombstones to cover exactly every active omitted rule', async () => {
    tx.catalogItemPrice.findMany.mockResolvedValueOnce(persistedPrices())
    const organizationValues = input.organizationValues
      .filter(value => value.currency === 'MXN')
      .map(value => ({ ...value, expectedRuleRevision: 1 }))

    await expect(
      updateCatalogItem(context, {
        ...input,
        catalogItemId: 'catalog-item-1',
        expectedRevision: 1,
        organizationValues,
        organizationValueDeactivations: [{ kind: CatalogItemPriceKind.SALE_PRICE, currency: 'USD', expectedRuleRevision: 1 }],
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_VALUE_DEACTIVATION_SET_INVALID' })
    expect(tx.catalogItem.updateMany).not.toHaveBeenCalled()
  })

  it('rejects a stale retained-rule revision before item or child mutation', async () => {
    tx.catalogItemPrice.findMany.mockResolvedValueOnce(persistedPrices({ 'SALE_PRICE:MXN': { revision: 2 } }))
    const organizationValues = input.organizationValues.map(value => ({ ...value, expectedRuleRevision: 1 }))

    await expect(
      updateCatalogItem(context, {
        ...input,
        catalogItemId: 'catalog-item-1',
        expectedRevision: 1,
        organizationValues,
        organizationValueDeactivations: [],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_VALUE_REVISION_CONFLICT' })
    expect(tx.catalogItem.updateMany).not.toHaveBeenCalled()
    expect(tx.catalogItemBusinessType.deleteMany).not.toHaveBeenCalled()
    expect(tx.catalogItemPrice.updateMany).not.toHaveBeenCalled()
  })
})
