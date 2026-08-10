/**
 * Tests: printStationId on Product (print-station routing)
 *
 * Verifies:
 *  - createProduct persists printStationId when provided
 *  - createProduct defaults printStationId to null when not provided
 *  - updateProduct persists printStationId when provided
 *  - updateProduct WITHOUT printStationId does not overwrite existing value (regression)
 *  - updateProduct allows clearing printStationId by passing null
 */

import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import * as productService from '../../../../src/services/dashboard/product.dashboard.service'
import {
  assertLegacyProductReferencesForVenue,
  writeLegacyServiceProductCreationAuditForVenue,
} from '../../../../src/services/master-catalog/catalogGovernance.service'
import AppError from '../../../../src/errors/AppError'

const humanActor = { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: false }
const serviceActor = { type: 'SERVICE' as const, servicePrincipalId: 'DEMO_VENUE_SEED' }

// Minimal mock product factory — typed as any to avoid Prisma payload shape strictness
const makeMockProduct = (overrides: Record<string, any> = {}): any => ({
  id: 'product-abc',
  venueId: 'venue-xyz',
  name: 'Producto Test',
  description: null,
  sku: 'SKU001',
  gtin: null,
  categoryId: 'cat-001',
  price: new Decimal(100),
  cost: null,
  taxRate: new Decimal(0.16),
  type: 'REGULAR' as const,
  active: true,
  displayOrder: 1,
  imageUrl: null,
  featured: false,
  tags: [],
  allergens: [],
  calories: null,
  prepTime: null,
  cookingNotes: null,
  trackInventory: false,
  inventoryMethod: null,
  unit: null,
  availableFrom: null,
  availableUntil: null,
  isAlcoholic: false,
  kitchenName: null,
  abbreviation: null,
  duration: null,
  eventDate: null,
  eventTime: null,
  eventEndTime: null,
  eventCapacity: null,
  eventLocation: null,
  downloadUrl: null,
  downloadLimit: null,
  fileSize: null,
  suggestedAmounts: [],
  allowCustomAmount: true,
  donationCause: null,
  allowCreditRedemption: true,
  requireCreditForBooking: false,
  durationMinutes: null,
  maxParticipants: null,
  layoutConfig: null,
  deletedAt: null,
  deletedBy: null,
  externalData: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  // SAT fields
  satProductKey: null,
  satUnitKey: null,
  objetoImp: '02',
  // Print station (ruteo de comandas)
  printStationId: null,
  // Relations (used by createProduct / updateProduct return)
  category: { id: 'cat-001', name: 'Categoría Test' },
  modifierGroups: [],
  inventory: null,
  recipe: null,
  ...overrides,
})

// Mock Socket.IO so getBroadcastingService() returns null (no broadcasts)
jest.mock('../../../../src/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))

jest.mock('../../../../src/services/master-catalog/catalogGovernance.service', () => ({
  assertLegacyCatalogGovernanceForVenue: jest.fn().mockResolvedValue(undefined),
  assertLegacyCatalogProductUpdateGovernance: jest.fn().mockResolvedValue({ id: 'product-abc', active: true }),
  assertLegacyProductReferencesForVenue: jest.fn().mockResolvedValue(undefined),
  writeLegacyServiceProductCreationAuditForVenue: jest.fn().mockResolvedValue(undefined),
}))

describe('getProducts — recipe/modifier trees are opt-out (perf: fan-out to ~10 pages)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('DEFAULT (no options) loads BOTH the modifier tree and the recipe tree (backward-compatible)', async () => {
    prismaMock.product.findMany.mockResolvedValue([] as any)
    await productService.getProducts('venue-xyz')
    const arg = (prismaMock.product.findMany as jest.Mock).mock.calls[0][0]
    expect(arg.include.modifierGroups).toBeDefined()
    expect(arg.include.recipe).toBeDefined()
  })

  it('🔒 includeRecipe:false + includeModifiers:false SKIP both deep trees (light path for dropdowns)', async () => {
    prismaMock.product.findMany.mockResolvedValue([] as any)
    await productService.getProducts('venue-xyz', { includeRecipe: false, includeModifiers: false })
    const arg = (prismaMock.product.findMany as jest.Mock).mock.calls[0][0]
    expect(arg.include.modifierGroups).toBeUndefined()
    expect(arg.include.recipe).toBeUndefined()
    expect(arg.include.category).toBe(true) // light fields still loaded
    expect(arg.include.inventory).toBe(true)
  })

  it('honors includeRecipe INDEPENDENTLY (regression: the flag used to be ignored — recipe always loaded)', async () => {
    prismaMock.product.findMany.mockResolvedValue([] as any)
    await productService.getProducts('venue-xyz', { includeRecipe: false }) // modifiers default ON
    const arg = (prismaMock.product.findMany as jest.Mock).mock.calls[0][0]
    expect(arg.include.recipe).toBeUndefined() // recipe skipped
    expect(arg.include.modifierGroups).toBeDefined() // modifiers still loaded (default ON)
  })

  it('light path does NOT compute availableQuantity; the default path does', async () => {
    prismaMock.product.findMany.mockResolvedValue([makeMockProduct()] as any)
    const light = await productService.getProducts('venue-xyz', { includeRecipe: false })
    expect(light[0]).not.toHaveProperty('availableQuantity')

    prismaMock.product.findMany.mockResolvedValue([makeMockProduct()] as any)
    const heavy = await productService.getProducts('venue-xyz')
    expect(heavy[0]).toHaveProperty('availableQuantity') // computeInventoryAvailability ran
  })
})

describe('Product printStationId (print-station routing)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ──────────────────────────────────────────────────────────────
  // CREATE (direct product creation)
  // ──────────────────────────────────────────────────────────────
  describe('createProduct — printStationId', () => {
    it('persists printStationId when provided', async () => {
      const createdProduct = makeMockProduct({ printStationId: 'station-001' })

      // Serializable transaction mock: findFirst returns displayOrder, then create returns product
      prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
      prismaMock.product.findFirst.mockResolvedValue({ displayOrder: 0 })
      prismaMock.product.create.mockResolvedValue(createdProduct)

      const result = await productService.createProduct(
        'venue-xyz',
        {
          name: 'Producto Test',
          sku: 'SKU001',
          price: 100,
          type: 'REGULAR' as any,
          categoryId: 'cat-001',
          printStationId: 'station-001',
        },
        humanActor,
      )

      const createCall = prismaMock.product.create.mock.calls[0][0]
      expect(createCall.data.printStationId).toBe('station-001')
      expect(createCall.data.createdById).toBe('staff-1')
      expect(result.printStationId).toBe('station-001')
    })

    it('defaults printStationId to null when not provided', async () => {
      const createdProduct = makeMockProduct()

      prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
      prismaMock.product.findFirst.mockResolvedValue({ displayOrder: 0 })
      prismaMock.product.create.mockResolvedValue(createdProduct)

      await productService.createProduct(
        'venue-xyz',
        {
          name: 'Producto Test',
          sku: 'SKU001',
          price: 100,
          type: 'REGULAR' as any,
          categoryId: 'cat-001',
        },
        humanActor,
      )

      const createCall = prismaMock.product.create.mock.calls[0][0]
      expect(createCall.data.printStationId).toBeNull()
    })

    it('co-commits exact SERVICE provenance while HUMAN creation has no duplicate legacy audit', async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
      prismaMock.product.findFirst.mockResolvedValue({ displayOrder: 0 })
      prismaMock.product.create.mockResolvedValue(makeMockProduct())
      const input = { name: 'Producto Test', sku: 'SKU001', price: 100, type: 'REGULAR' as any, categoryId: 'cat-001' }

      await productService.createProduct('venue-xyz', input, humanActor)
      expect(writeLegacyServiceProductCreationAuditForVenue).not.toHaveBeenCalled()

      await productService.createProduct('venue-xyz', input, serviceActor)
      expect(prismaMock.product.create.mock.calls[1][0].data.createdById).toBeNull()
      expect(writeLegacyServiceProductCreationAuditForVenue).toHaveBeenCalledTimes(1)
      expect(writeLegacyServiceProductCreationAuditForVenue).toHaveBeenCalledWith(prismaMock, {
        venueId: 'venue-xyz',
        productId: 'product-abc',
        actor: serviceActor,
      })
    })

    it('does not resolve the SERVICE transaction when provenance audit fails', async () => {
      let committed = false
      prismaMock.$transaction.mockImplementationOnce(async (cb: any) => {
        const result = await cb(prismaMock)
        committed = true
        return result
      })
      prismaMock.product.findFirst.mockResolvedValue({ displayOrder: 0 })
      prismaMock.product.create.mockResolvedValue(makeMockProduct())
      ;(writeLegacyServiceProductCreationAuditForVenue as jest.Mock).mockRejectedValueOnce(new Error('audit unavailable'))

      await expect(
        productService.createProduct(
          'venue-xyz',
          { name: 'Producto Test', sku: 'SKU001', price: 100, type: 'REGULAR' as any, categoryId: 'cat-001' },
          serviceActor,
        ),
      ).rejects.toThrow('audit unavailable')
      expect(prismaMock.product.create).toHaveBeenCalledTimes(1)
      expect(committed).toBe(false)
    })
  })

  // ──────────────────────────────────────────────────────────────
  // UPDATE
  // ──────────────────────────────────────────────────────────────
  describe('updateProduct — printStationId', () => {
    it('persists printStationId when updating a product with it', async () => {
      const existing = makeMockProduct()
      const updated = makeMockProduct({ printStationId: 'station-002' })

      prismaMock.product.findFirst.mockResolvedValue(existing)
      prismaMock.product.update.mockResolvedValue(updated)

      const result = await productService.updateProduct(
        'venue-xyz',
        'product-abc',
        {
          printStationId: 'station-002',
        },
        humanActor,
      )

      const updateCall = prismaMock.product.update.mock.calls[0][0]
      expect(updateCall.data.printStationId).toBe('station-002')
      expect(result.printStationId).toBe('station-002')
    })

    it('REGRESSION — updating without printStationId does not overwrite existing value', async () => {
      const existing = makeMockProduct({ printStationId: 'station-001' })
      const updated = makeMockProduct({ name: 'Nombre Actualizado', printStationId: 'station-001' })

      prismaMock.product.findFirst.mockResolvedValue(existing)
      prismaMock.product.update.mockResolvedValue(updated)

      // Update with only name — no printStationId provided
      await productService.updateProduct('venue-xyz', 'product-abc', { name: 'Nombre Actualizado' }, humanActor)

      const updateCall = prismaMock.product.update.mock.calls[0][0]
      // printStationId must NOT appear in updateData sent to Prisma
      expect(updateCall.data).not.toHaveProperty('printStationId')
    })

    it('allows clearing printStationId by passing null', async () => {
      const existing = makeMockProduct({ printStationId: 'station-001' })
      const updated = makeMockProduct({ printStationId: null })

      prismaMock.product.findFirst.mockResolvedValue(existing)
      prismaMock.product.update.mockResolvedValue(updated)

      await productService.updateProduct(
        'venue-xyz',
        'product-abc',
        {
          printStationId: null,
        },
        humanActor,
      )

      const updateCall = prismaMock.product.update.mock.calls[0][0]
      expect(updateCall.data.printStationId).toBeNull()
    })
  })
})

describe('Product governed tenant references', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.product.findFirst.mockResolvedValue({ displayOrder: 0 })
  })

  it('does not create a Product when its category belongs to another venue', async () => {
    ;(assertLegacyProductReferencesForVenue as jest.Mock).mockRejectedValueOnce(new AppError('Categoría no encontrada', 404))

    await expect(
      productService.createProduct(
        'venue-xyz',
        {
          name: 'Foreign',
          sku: 'FOREIGN',
          price: 10,
          type: 'REGULAR' as any,
          categoryId: 'foreign-category',
        },
        humanActor,
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.product.create).not.toHaveBeenCalled()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Venta por peso (soldByWeight) — spec 2026-07-18-venta-por-peso-bascula.md
// price becomes precio POR KG and unit is pinned to KILOGRAM when enabled.
// ════════════════════════════════════════════════════════════════════════════
describe('Product soldByWeight (venta por peso)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('createProduct — soldByWeight', () => {
    it('persists soldByWeight=true and forces unit=KILOGRAM', async () => {
      const created = makeMockProduct({ soldByWeight: true, unit: 'KILOGRAM' } as any)
      prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
      prismaMock.product.findFirst.mockResolvedValue({ displayOrder: 0 })
      prismaMock.product.create.mockResolvedValue(created)

      await productService.createProduct(
        'venue-xyz',
        {
          name: 'Jamón serrano',
          sku: 'CHA-001',
          price: 420,
          type: 'REGULAR' as any,
          categoryId: 'cat-001',
          soldByWeight: true,
        },
        humanActor,
      )

      const createCall = prismaMock.product.create.mock.calls[0][0]
      expect(createCall.data.soldByWeight).toBe(true)
      expect(createCall.data.unit).toBe('KILOGRAM')
    })

    it('defaults soldByWeight=false and does NOT force a unit', async () => {
      const created = makeMockProduct()
      prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
      prismaMock.product.findFirst.mockResolvedValue({ displayOrder: 0 })
      prismaMock.product.create.mockResolvedValue(created)

      await productService.createProduct(
        'venue-xyz',
        {
          name: 'Refresco',
          sku: 'BEB-001',
          price: 40,
          type: 'REGULAR' as any,
          categoryId: 'cat-001',
        },
        humanActor,
      )

      const createCall = prismaMock.product.create.mock.calls[0][0]
      expect(createCall.data.soldByWeight).toBe(false)
      expect(createCall.data.unit).toBeUndefined()
    })
  })

  describe('updateProduct — soldByWeight', () => {
    it('forces unit=KILOGRAM when enabling soldByWeight', async () => {
      const existing = makeMockProduct()
      const updated = makeMockProduct({ soldByWeight: true, unit: 'KILOGRAM' } as any)
      prismaMock.product.findFirst.mockResolvedValue(existing)
      prismaMock.product.update.mockResolvedValue(updated)

      await productService.updateProduct('venue-xyz', 'product-abc', { soldByWeight: true } as any, humanActor)

      const updateCall = prismaMock.product.update.mock.calls[0][0]
      expect(updateCall.data.soldByWeight).toBe(true)
      expect(updateCall.data.unit).toBe('KILOGRAM')
    })

    it('REGRESSION — updating without soldByWeight does not inject soldByWeight/unit', async () => {
      const existing = makeMockProduct({ soldByWeight: true, unit: 'KILOGRAM' } as any)
      const updated = makeMockProduct({ name: 'Nombre Actualizado' })
      prismaMock.product.findFirst.mockResolvedValue(existing)
      prismaMock.product.update.mockResolvedValue(updated)

      await productService.updateProduct('venue-xyz', 'product-abc', { name: 'Nombre Actualizado' }, humanActor)

      const updateCall = prismaMock.product.update.mock.calls[0][0]
      expect(updateCall.data).not.toHaveProperty('soldByWeight')
      expect(updateCall.data).not.toHaveProperty('unit')
    })

    it('does NOT force unit when disabling soldByWeight (no reversion logic)', async () => {
      const existing = makeMockProduct({ soldByWeight: true, unit: 'KILOGRAM' } as any)
      const updated = makeMockProduct({ soldByWeight: false } as any)
      prismaMock.product.findFirst.mockResolvedValue(existing)
      prismaMock.product.update.mockResolvedValue(updated)

      await productService.updateProduct('venue-xyz', 'product-abc', { soldByWeight: false } as any, humanActor)

      const updateCall = prismaMock.product.update.mock.calls[0][0]
      expect(updateCall.data.soldByWeight).toBe(false)
      // unit is left as-is (not forced) when turning weight off
      expect(updateCall.data).not.toHaveProperty('unit')
    })
  })
})
