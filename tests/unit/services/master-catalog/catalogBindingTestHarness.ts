import { CatalogItemKind, CatalogItemStatus, ProductType, Unit } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { createCatalogBindingService } from '@/services/master-catalog/catalogBinding.service'
import type { CatalogBindingDecisionInput } from '@/types/master-catalog'

export const NOW = new Date('2026-08-09T12:00:00.000Z')

export const context = {
  organizationId: 'org-1',
  actor: { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: false },
}

export function catalogItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    organizationId: 'org-1',
    sku: 'Corp-SKU',
    kind: CatalogItemKind.RETAIL_PRODUCT,
    status: CatalogItemStatus.ACTIVE,
    revision: 7,
    name: 'Producto maestro',
    description: 'Descripción maestra',
    imageUrl: 'https://example.test/item.png',
    unit: Unit.PIECE,
    taxRate: new Decimal('0.1600'),
    satProductKey: '50192100',
    satUnitKey: 'H87',
    objetoImp: '02',
    productType: ProductType.REGULAR,
    prices: [
      {
        id: 'cost-1',
        kind: 'PURCHASE_COST',
        scope: 'ORGANIZATION',
        amount: new Decimal('12.50'),
        currency: 'MXN',
        active: true,
        revision: 3,
        updatedAt: NOW,
      },
    ],
    ...overrides,
  }
}

export function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 'product-1',
    venueId: 'venue-1',
    sku: 'Corp-SKU',
    gtin: null,
    name: 'Local existente',
    description: null,
    categoryId: 'category-1',
    type: ProductType.REGULAR,
    price: new Decimal('20.00'),
    cost: new Decimal('10.00'),
    taxRate: new Decimal('0.1600'),
    satProductKey: null,
    satUnitKey: null,
    objetoImp: '02',
    imageUrl: null,
    unit: Unit.PIECE,
    active: false,
    deletedAt: null,
    updatedAt: NOW,
    ...overrides,
  }
}

export function recipeLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'recipe-line-1',
    displayOrder: 0,
    rawMaterialId: 'raw-1',
    quantity: new Decimal('1.000'),
    unit: Unit.KILOGRAM,
    costPerServing: new Decimal('62.5000'),
    rawMaterial: {
      id: 'raw-1',
      venueId: 'venue-1',
      unit: Unit.GRAM,
      costPerUnit: new Decimal('0.5000'),
      active: true,
      deletedAt: null,
    },
    ...overrides,
  }
}

export function preparedRecipe(overrides: Record<string, unknown> = {}) {
  return {
    id: 'recipe-1',
    portionYield: 8,
    prepTime: 10,
    totalCost: new Decimal('62.5000'),
    updatedAt: NOW,
    lines: [recipeLine()],
    ...overrides,
  }
}

export function bindingTransaction() {
  return {
    catalogItem: { findFirst: jest.fn().mockResolvedValue(catalogItem()) },
    venue: {
      findFirst: jest.fn().mockResolvedValue({ id: 'venue-1', organizationId: 'org-1', currency: 'MXN', updatedAt: NOW }),
    },
    product: {
      findMany: jest.fn().mockResolvedValue([product()]),
      create: jest.fn().mockResolvedValue({ id: 'product-created', updatedAt: NOW }),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    menuCategory: { findFirst: jest.fn().mockResolvedValue({ id: 'category-1', venueId: 'venue-1', updatedAt: NOW }) },
    catalogVenueBinding: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'binding-1', revision: 1 }),
    },
    recipe: { findFirst: jest.fn().mockResolvedValue(null) },
    catalogBindingBatch: {
      create: jest.fn().mockResolvedValue({ id: 'batch-1' }),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogBindingLine: {
      create: jest.fn().mockResolvedValue({ id: 'line-1' }),
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogIdempotencyRecord: {
      create: jest.fn().mockResolvedValue({ id: 'idem-1' }),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(0),
  }
}

export function bindingHarness(tx = bindingTransaction()) {
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    catalogIdempotencyRecord: { findFirst: jest.fn() },
  }
  const dependencies = {
    prisma: prisma as never,
    assertLiveAccessTx: jest.fn().mockResolvedValue(undefined),
    acquireMutationLockTx: jest.fn().mockResolvedValue(undefined),
    writeCatalogAudit: jest.fn().mockResolvedValue(undefined),
    evaluatePreparedDishBinding: jest.fn(),
    now: jest.fn(() => NOW),
    randomToken: jest.fn(() => 'preview-token'),
    randomAttemptId: jest.fn(() => 'attempt-1'),
  }
  return { tx, prisma, dependencies, service: createCatalogBindingService(dependencies) }
}

export async function stageConfirmablePreview(h: ReturnType<typeof bindingHarness>, decision: CatalogBindingDecisionInput) {
  const preview = await h.service.preview(context, {
    lines: [{ catalogItemId: 'item-1', venueId: 'venue-1', decision }],
  })
  if (!preview.bindingBatchId || !preview.previewToken) throw new Error('expected confirmable preview')
  const batchData = h.tx.catalogBindingBatch.create.mock.calls[0]?.[0].data
  const storedBatch = {
    id: preview.bindingBatchId,
    ...batchData,
    result: null,
    attemptId: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    appliedAt: null,
    completedAt: null,
    updatedAt: NOW,
  }
  h.tx.catalogBindingBatch.findFirst.mockResolvedValue(storedBatch)
  h.tx.catalogBindingLine.findMany.mockResolvedValue(
    h.tx.catalogBindingLine.create.mock.calls.map((call, index) => ({
      id: `line-${index + 1}`,
      ...call[0].data,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  )
  return { preview, storedBatch }
}

export function configureAppliedLinkReplay(
  h: ReturnType<typeof bindingHarness>,
  storedBatch: Awaited<ReturnType<typeof stageConfirmablePreview>>['storedBatch'],
  idempotencyKey: string,
) {
  const result = {
    bindingBatchId: storedBatch.id,
    state: 'APPLIED' as const,
    lines: [
      {
        catalogItemId: 'item-1',
        venueId: 'venue-1',
        decision: 'LINK' as const,
        status: 'APPLIED' as const,
        productId: 'product-1',
        bindingId: 'binding-1',
        readiness: null,
      },
    ],
  }
  const appliedBatch = { ...storedBatch, state: 'APPLIED', result }
  const durableLines = h.tx.catalogBindingLine.create.mock.calls.map((call, index) => ({
    id: `line-${index + 1}`,
    ...call[0].data,
    status: 'APPLIED',
    productId: 'product-1',
    after: { bindingId: 'binding-1', productId: 'product-1' },
  }))
  const record = {
    organizationId: 'org-1',
    operation: 'CATALOG_BINDING',
    idempotencyKey,
    requestHash: storedBatch.requestHash,
    requestHashVersion: 1,
    targetHash: storedBatch.targetHash,
    dependencies: storedBatch.dependencies,
    resourceType: 'CatalogBindingBatch',
    resourceId: storedBatch.id,
    actorType: 'HUMAN',
    staffId: 'staff-1',
    state: 'APPLIED',
    result,
  }
  h.tx.catalogBindingBatch.findFirst.mockResolvedValue(appliedBatch)
  h.tx.catalogBindingLine.findMany.mockResolvedValue(durableLines)
  h.tx.catalogVenueBinding.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    where.id === 'binding-1'
      ? {
          id: 'binding-1',
          revision: 1,
          productId: 'product-1',
          product: { id: 'product-1', venueId: 'venue-1' },
          catalogItem: { id: 'item-1', revision: 7 },
        }
      : null,
  )
  h.tx.catalogIdempotencyRecord.findFirst.mockResolvedValue(record)
  return { result, appliedBatch, durableLines, record }
}
