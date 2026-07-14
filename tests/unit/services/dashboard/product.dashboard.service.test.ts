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

      const result = await productService.createProduct('venue-xyz', {
        name: 'Producto Test',
        sku: 'SKU001',
        price: 100,
        type: 'REGULAR' as any,
        categoryId: 'cat-001',
        printStationId: 'station-001',
      })

      const createCall = prismaMock.product.create.mock.calls[0][0]
      expect(createCall.data.printStationId).toBe('station-001')
      expect(result.printStationId).toBe('station-001')
    })

    it('defaults printStationId to null when not provided', async () => {
      const createdProduct = makeMockProduct()

      prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
      prismaMock.product.findFirst.mockResolvedValue({ displayOrder: 0 })
      prismaMock.product.create.mockResolvedValue(createdProduct)

      await productService.createProduct('venue-xyz', {
        name: 'Producto Test',
        sku: 'SKU001',
        price: 100,
        type: 'REGULAR' as any,
        categoryId: 'cat-001',
      })

      const createCall = prismaMock.product.create.mock.calls[0][0]
      expect(createCall.data.printStationId).toBeNull()
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

      const result = await productService.updateProduct('venue-xyz', 'product-abc', {
        printStationId: 'station-002',
      })

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
      await productService.updateProduct('venue-xyz', 'product-abc', { name: 'Nombre Actualizado' })

      const updateCall = prismaMock.product.update.mock.calls[0][0]
      // printStationId must NOT appear in updateData sent to Prisma
      expect(updateCall.data).not.toHaveProperty('printStationId')
    })

    it('allows clearing printStationId by passing null', async () => {
      const existing = makeMockProduct({ printStationId: 'station-001' })
      const updated = makeMockProduct({ printStationId: null })

      prismaMock.product.findFirst.mockResolvedValue(existing)
      prismaMock.product.update.mockResolvedValue(updated)

      await productService.updateProduct('venue-xyz', 'product-abc', {
        printStationId: null,
      })

      const updateCall = prismaMock.product.update.mock.calls[0][0]
      expect(updateCall.data.printStationId).toBeNull()
    })
  })
})
