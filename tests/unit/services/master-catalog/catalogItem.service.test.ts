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
  default: {
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [])),
    catalogItem: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
  },
}))

import prisma from '@/utils/prismaClient'
import {
  applyCatalogItemAggregateTx,
  createCatalogItem,
  getCatalogItem,
  listCatalogItems,
  retireCatalogItem,
  updateCatalogItem,
  type CreateCatalogItemInput,
  type UpdateCatalogItemInput,
} from '@/services/master-catalog/catalogItem.service'
import type { CatalogCommandContext, CatalogReadContext } from '@/types/master-catalog'

const organizationId = 'org-pits'
const staffId = 'staff-owner'
const commandContext: CatalogCommandContext = {
  organizationId,
  actor: { type: 'HUMAN', staffId, impersonating: false },
  orgRole: 'OWNER',
}
const readContext: CatalogReadContext = commandContext

const input: CreateCatalogItemInput = {
  sku: '  sku-001  ',
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
    { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '80.5', currency: 'MXN' },
    { kind: CatalogItemPriceKind.SALE_PRICE, amount: '7.00', currency: 'USD' },
    { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '5.00', currency: 'USD' },
  ],
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'catalog-item-1',
    organizationId,
    ...input,
    normalizedSku: 'SKU-001',
    status: CatalogItemStatus.ACTIVE,
    revision: 1,
    taxRate: new Prisma.Decimal('0.1600'),
    iepsRate: null,
    iepsQuota: null,
    createdById: staffId,
    updatedById: staffId,
    createdAt: new Date('2026-08-08T18:00:00.000Z'),
    updatedAt: new Date('2026-08-08T18:00:00.000Z'),
    brand: { id: 'brand-1', name: 'Marca', status: CatalogReferenceStatus.ACTIVE },
    manufacturer: { id: 'manufacturer-1', name: 'Fabricante', status: CatalogReferenceStatus.ACTIVE },
    family: {
      id: 'family-leaf-1',
      name: 'Subfamilia',
      status: CatalogReferenceStatus.ACTIVE,
      parent: { id: 'family-parent-1', name: 'Familia', status: CatalogReferenceStatus.ACTIVE },
    },
    businessTypes: [{ businessType: BusinessType.RETAIL_STORE }],
    prices: input.organizationValues.map((value, index) => ({
      id: `price-${index}`,
      ...value,
      amount: new Prisma.Decimal(value.amount),
      scope: 'ORGANIZATION',
      active: true,
      revision: 1,
    })),
    _count: { bindings: 0 },
    ...overrides,
  }
}

function persistedPrices(overrides: Record<string, Record<string, unknown>> = {}) {
  return input.organizationValues.map((value, index) => ({
    id: `price-${index}`,
    organizationId,
    catalogItemId: 'catalog-item-1',
    ...value,
    amount: new Prisma.Decimal(value.amount),
    revision: 1,
    active: true,
    ...(overrides[`${value.kind}:${value.currency}`] ?? {}),
  }))
}

function buildTx() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    catalogBrand: {
      findFirst: jest.fn().mockResolvedValue({ id: 'brand-1', organizationId, status: CatalogReferenceStatus.ACTIVE }),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogManufacturer: {
      findFirst: jest.fn().mockResolvedValue({ id: 'manufacturer-1', organizationId, status: CatalogReferenceStatus.ACTIVE }),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogFamily: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'family-leaf-1',
        organizationId,
        status: CatalogReferenceStatus.ACTIVE,
        parentId: 'family-parent-1',
        parent: { id: 'family-parent-1', status: CatalogReferenceStatus.ACTIVE, parentId: null },
        children: [],
      }),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogItem: {
      findFirst: jest.fn().mockResolvedValue(itemRow()),
      create: jest.fn().mockResolvedValue(itemRow()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogIdentifier: {
      create: jest.fn().mockResolvedValue({ id: 'identifier-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogItemBusinessType: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    catalogItemPrice: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      createMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    product: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  }
  return tx
}

let tx = buildTx()

beforeEach(() => {
  jest.clearAllMocks()
  tx = buildTx()
  mockTransaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx))
  mockWriteCatalogAudit.mockResolvedValue(undefined)
})

// Aggregate tests assert externally meaningful writes, not mock existence: a
// wrong tenant/CAS/projection/audit branch changes the recorded transaction.
describe('catalogItem.service aggregate commands', () => {
  it('creates the complete aggregate and one DIRECT audit without touching Product', async () => {
    const result = await createCatalogItem(commandContext, input)

    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.catalogBrand.findFirst.mock.invocationCallOrder[0])
    expect(tx.catalogItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sku: input.sku, normalizedSku: 'SKU-001', createdById: staffId, updatedById: staffId }),
      }),
    )
    expect(tx.catalogIdentifier.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ code: input.sku, normalizedCode: 'SKU-001', type: 'CORPORATE_SKU', status: 'ACTIVE' }),
    })
    expect(tx.catalogItemPrice.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ kind: 'SALE_PRICE', amount: '120.00', currency: 'MXN', active: true }),
        expect.objectContaining({ kind: 'PURCHASE_COST', amount: '80.50', currency: 'MXN', active: true }),
      ]),
    })
    expect(mockWriteCatalogAudit).toHaveBeenCalledTimes(1)
    expect(mockWriteCatalogAudit).toHaveBeenCalledWith(tx, expect.objectContaining({ action: 'CATALOG_ITEM_CREATED' }))
    expect(tx.product.create).not.toHaveBeenCalled()
    expect(tx.product.update).not.toHaveBeenCalled()
    expect(result.detail.validation).toEqual({ state: 'NOT_EVALUATED', summary: null })
  })

  it('returns a BATCH audit envelope without writing per-item ActivityLog', async () => {
    const result = await applyCatalogItemAggregateTx(
      tx as unknown as Prisma.TransactionClient,
      commandContext,
      { operation: 'CREATE', input },
      { auditOwnership: { kind: 'BATCH', batchId: 'import-batch-1' } },
    )

    expect(mockWriteCatalogAudit).not.toHaveBeenCalled()
    expect(result.auditEnvelope).toEqual(
      expect.objectContaining({ action: 'CATALOG_ITEM_CREATED', entityId: 'catalog-item-1', batchId: 'import-batch-1' }),
    )
  })

  it('whitelists CREATE scalars and keeps tenant/actor/revision fields context-owned', async () => {
    const forgedInput = {
      ...input,
      organizationId: 'org-foreign',
      revision: 99,
      invariantVersion: 99n,
      status: CatalogItemStatus.RETIRED,
      createdById: 'staff-attacker',
      updatedById: 'staff-attacker',
      unexpectedField: 'must-not-persist',
    } as CreateCatalogItemInput

    await createCatalogItem(commandContext, forgedInput)

    const data = tx.catalogItem.create.mock.calls[0][0].data
    expect(data).toEqual(
      expect.objectContaining({ organizationId, status: CatalogItemStatus.ACTIVE, createdById: staffId, updatedById: staffId }),
    )
    for (const key of ['revision', 'invariantVersion', 'unexpectedField']) expect(data).not.toHaveProperty(key)
  })

  it('rejects SERVICE and impersonating actors before any FK-backed write', async () => {
    for (const actor of [
      { type: 'SERVICE' as const, servicePrincipalId: 'import-worker' },
      { type: 'HUMAN' as const, staffId, impersonating: true },
    ]) {
      await expect(
        applyCatalogItemAggregateTx(
          tx as unknown as Prisma.TransactionClient,
          { ...commandContext, actor },
          { operation: 'CREATE', input },
          { auditOwnership: { kind: 'DIRECT' } },
        ),
      ).rejects.toMatchObject({ code: 'CATALOG_HUMAN_ACTOR_REQUIRED' })
    }
    expect(tx.catalogItem.create).not.toHaveBeenCalled()
    expect(tx.$executeRaw).not.toHaveBeenCalled()
  })

  it.each(
    (['UPDATE', 'RETIRE'] as const).flatMap(operation =>
      [0, 1.5, 2_147_483_647, 2_147_483_648, Number.MAX_SAFE_INTEGER, Number.NaN, '1', null].map(
        expectedRevision => [operation, expectedRevision] as const,
      ),
    ),
  )('rejects %s revision %p before lock/read/write', async (operation, expectedRevision) => {
    const command =
      operation === 'UPDATE'
        ? {
            operation,
            input: {
              ...input,
              catalogItemId: 'catalog-item-1',
              expectedRevision,
              organizationValueDeactivations: [],
            },
          }
        : { operation, input: { catalogItemId: 'catalog-item-1', expectedRevision } }

    await expect(
      applyCatalogItemAggregateTx(tx as unknown as Prisma.TransactionClient, commandContext, command as never, {
        auditOwnership: { kind: 'DIRECT' },
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_REVISION_INVALID' })
    expect(tx.$executeRaw).not.toHaveBeenCalled()
    expect(tx.catalogItem.findFirst).not.toHaveBeenCalled()
  })

  it('treats a foreign/missing reference as 404 and requires an active leaf with active parent', async () => {
    tx.catalogFamily.findFirst.mockResolvedValueOnce(null)
    await expect(createCatalogItem(commandContext, input)).rejects.toMatchObject({ statusCode: 404 })

    tx.catalogFamily.findFirst.mockResolvedValueOnce({
      id: 'family-root',
      organizationId,
      status: 'ACTIVE',
      parentId: null,
      parent: null,
      children: [],
    })
    await expect(createCatalogItem(commandContext, input)).rejects.toMatchObject({ code: 'CATALOG_FAMILY_LEAF_REQUIRED' })
    expect(tx.catalogItem.create).not.toHaveBeenCalled()
  })

  it('updates the tenant-scoped CAS once and renames SKU plus projection atomically', async () => {
    tx.catalogItem.findFirst.mockResolvedValueOnce(itemRow()).mockResolvedValueOnce(itemRow({ sku: 'NEW-01', revision: 2 }))
    tx.catalogItemPrice.findMany.mockResolvedValueOnce(persistedPrices())
    const organizationValues = input.organizationValues.map(value => ({ ...value, expectedRuleRevision: 1 }))

    const updateInput = {
      ...input,
      organizationValues,
      organizationValueDeactivations: [],
      catalogItemId: 'catalog-item-1',
      expectedRevision: 1,
      sku: ' new-01 ',
      organizationId: 'org-foreign',
      status: CatalogItemStatus.RETIRED,
      createdById: 'staff-attacker',
      unexpectedField: 'must-not-persist',
    } as UpdateCatalogItemInput
    await updateCatalogItem(commandContext, updateInput)

    expect(tx.catalogItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'catalog-item-1', organizationId, revision: 1, status: 'ACTIVE' },
        data: expect.objectContaining({ normalizedSku: 'NEW-01', revision: { increment: 1 } }),
      }),
    )
    const persistedData = tx.catalogItem.updateMany.mock.calls[0][0].data
    for (const key of ['catalogItemId', 'expectedRevision', 'organizationId', 'status', 'createdById', 'unexpectedField']) {
      expect(persistedData).not.toHaveProperty(key)
    }
    expect(tx.catalogIdentifier.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ catalogItemId: 'catalog-item-1', organizationId, type: 'CORPORATE_SKU' }),
        data: expect.objectContaining({ code: ' new-01 ', normalizedCode: 'NEW-01', status: 'ACTIVE' }),
      }),
    )
    expect(tx.catalogItemBusinessType.deleteMany).toHaveBeenCalled()
    expect(tx.catalogItemPrice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'price-0', revision: 1 }),
        data: expect.objectContaining({ amount: '120.00', active: true, revision: { increment: 1 } }),
      }),
    )
    expect(tx.catalogItemPrice).not.toHaveProperty('deleteMany')
  })

  it('returns 409 on a stale revision before replacing any aggregate child', async () => {
    tx.catalogItem.updateMany.mockResolvedValueOnce({ count: 0 })

    // WHY: A stale token must remain structurally valid; malformed/revision-
    // exhausted tokens are covered separately by the pre-lock 422 matrix.
    await expect(
      updateCatalogItem(commandContext, {
        ...input,
        catalogItemId: 'catalog-item-1',
        expectedRevision: 2,
        organizationValueDeactivations: [],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_REVISION_CONFLICT' })
    expect(tx.catalogIdentifier.updateMany).not.toHaveBeenCalled()
    expect(tx.catalogItemBusinessType.deleteMany).not.toHaveBeenCalled()
  })

  it('retires one-way and mirrors the CORPORATE_SKU tombstone without freeing it', async () => {
    tx.catalogItem.findFirst.mockResolvedValueOnce(itemRow()).mockResolvedValueOnce(itemRow({ status: 'RETIRED', revision: 2 }))

    await retireCatalogItem(commandContext, { catalogItemId: 'catalog-item-1', expectedRevision: 1 })

    expect(tx.catalogItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'RETIRED', revision: { increment: 1 } }) }),
    )
    expect(tx.catalogIdentifier.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'RETIRED' } }))
    expect(tx.catalogItemPrice).not.toHaveProperty('deleteMany')
  })

  it('propagates audit failure from the same wrapper transaction', async () => {
    mockWriteCatalogAudit.mockRejectedValueOnce(new Error('audit FK failed'))

    await expect(createCatalogItem(commandContext, input)).rejects.toThrow('audit FK failed')
    expect(mockTransaction).toHaveBeenCalledTimes(1)
  })
})

describe('catalogItem.service bounded reads', () => {
  it('returns tenant-safe detail and stable bounded list without Recipe or modifier graphs', async () => {
    const globalItem = (prisma as unknown as { catalogItem: { findFirst: jest.Mock; findMany: jest.Mock } }).catalogItem
    globalItem.findFirst.mockResolvedValueOnce(itemRow())
    globalItem.findMany.mockResolvedValueOnce([itemRow(), itemRow({ id: 'catalog-item-2' }), itemRow({ id: 'catalog-item-3' })])

    const detail = await getCatalogItem(readContext, 'catalog-item-1')
    const page = await listCatalogItems(readContext, { pageSize: 2 })

    expect(detail.id).toBe('catalog-item-1')
    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBe('catalog-item-2')
    const serializedQueries = JSON.stringify([...globalItem.findFirst.mock.calls, ...globalItem.findMany.mock.calls])
    expect(serializedQueries).not.toContain('recipe')
    expect(serializedQueries).not.toContain('modifier')
    expect(globalItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId }), take: 3, orderBy: [{ id: 'asc' }] }),
    )
  })

  it('makes foreign and missing item IDs indistinguishable', async () => {
    const globalItem = (prisma as unknown as { catalogItem: { findFirst: jest.Mock } }).catalogItem
    globalItem.findFirst.mockResolvedValueOnce(null)

    await expect(getCatalogItem(readContext, 'foreign-id')).rejects.toMatchObject({ statusCode: 404 })
  })
})
