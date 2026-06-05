/**
 * Tests: SAT fiscal fields on Product (satProductKey, satUnitKey, objetoImp)
 *
 * Verifies:
 *  - createProduct persists SAT fields when provided
 *  - updateProduct persists SAT fields when provided
 *  - updateProduct WITHOUT SAT fields does not overwrite existing values (regression)
 *  - getProduct returns SAT fields
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

describe('Product SAT fiscal fields', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ──────────────────────────────────────────────────────────────
  // CREATE
  // ──────────────────────────────────────────────────────────────
  describe('createProduct — SAT fields', () => {
    it('persists satProductKey, satUnitKey, and objetoImp when provided', async () => {
      const createdProduct = makeMockProduct({
        satProductKey: '81111500',
        satUnitKey: 'E48',
        objetoImp: '02',
      })

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
        satProductKey: '81111500',
        satUnitKey: 'E48',
        objetoImp: '02',
      })

      // Assert Prisma create was called with the SAT fields
      const createCall = prismaMock.product.create.mock.calls[0][0]
      expect(createCall.data.satProductKey).toBe('81111500')
      expect(createCall.data.satUnitKey).toBe('E48')
      expect(createCall.data.objetoImp).toBe('02')

      // Assert the returned product contains them
      expect(result.satProductKey).toBe('81111500')
      expect(result.satUnitKey).toBe('E48')
      expect(result.objetoImp).toBe('02')
    })

    it('does NOT include SAT fields in Prisma create data when not provided', async () => {
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
      expect(createCall.data).not.toHaveProperty('satProductKey')
      expect(createCall.data).not.toHaveProperty('satUnitKey')
      expect(createCall.data).not.toHaveProperty('objetoImp')
    })
  })

  // ──────────────────────────────────────────────────────────────
  // UPDATE
  // ──────────────────────────────────────────────────────────────
  describe('updateProduct — SAT fields', () => {
    it('persists SAT fields when updating a product with them', async () => {
      const existing = makeMockProduct()
      const updated = makeMockProduct({
        name: 'Producto Test',
        satProductKey: '81111500',
        satUnitKey: 'H87',
        objetoImp: '01',
      })

      prismaMock.product.findFirst.mockResolvedValue(existing)
      prismaMock.product.update.mockResolvedValue(updated)

      const result = await productService.updateProduct('venue-xyz', 'product-abc', {
        name: 'Producto Test',
        satProductKey: '81111500',
        satUnitKey: 'H87',
        objetoImp: '01',
      })

      const updateCall = prismaMock.product.update.mock.calls[0][0]
      expect(updateCall.data.satProductKey).toBe('81111500')
      expect(updateCall.data.satUnitKey).toBe('H87')
      expect(updateCall.data.objetoImp).toBe('01')

      expect(result.satProductKey).toBe('81111500')
      expect(result.satUnitKey).toBe('H87')
      expect(result.objetoImp).toBe('01')
    })

    it('REGRESSION — updating without SAT fields does not overwrite existing SAT values', async () => {
      const existing = makeMockProduct({
        satProductKey: '81111500',
        satUnitKey: 'E48',
        objetoImp: '02',
      })
      const updated = makeMockProduct({
        name: 'Nombre Actualizado',
        satProductKey: '81111500',
        satUnitKey: 'E48',
        objetoImp: '02',
      })

      prismaMock.product.findFirst.mockResolvedValue(existing)
      prismaMock.product.update.mockResolvedValue(updated)

      // Update with only name — no SAT fields provided
      await productService.updateProduct('venue-xyz', 'product-abc', { name: 'Nombre Actualizado' })

      const updateCall = prismaMock.product.update.mock.calls[0][0]
      // SAT fields must NOT appear in updateData sent to Prisma
      // (Prisma only writes what's present; omitting = preserve existing value)
      expect(updateCall.data).not.toHaveProperty('satProductKey')
      expect(updateCall.data).not.toHaveProperty('satUnitKey')
      expect(updateCall.data).not.toHaveProperty('objetoImp')
    })

    it('allows clearing satProductKey and satUnitKey by passing null', async () => {
      const existing = makeMockProduct({
        satProductKey: '81111500',
        satUnitKey: 'E48',
      })
      const updated = makeMockProduct({ satProductKey: null, satUnitKey: null })

      prismaMock.product.findFirst.mockResolvedValue(existing)
      prismaMock.product.update.mockResolvedValue(updated)

      await productService.updateProduct('venue-xyz', 'product-abc', {
        satProductKey: null,
        satUnitKey: null,
      })

      const updateCall = prismaMock.product.update.mock.calls[0][0]
      expect(updateCall.data.satProductKey).toBeNull()
      expect(updateCall.data.satUnitKey).toBeNull()
    })
  })

  // ──────────────────────────────────────────────────────────────
  // GET
  // ──────────────────────────────────────────────────────────────
  describe('getProduct — SAT fields', () => {
    it('returns satProductKey, satUnitKey, and objetoImp in the product detail', async () => {
      const dbProduct = makeMockProduct({
        satProductKey: '81111500',
        satUnitKey: 'E48',
        objetoImp: '02',
        trackInventory: false,
      })

      prismaMock.product.findFirst.mockResolvedValue(dbProduct)

      const result = await productService.getProduct('venue-xyz', 'product-abc')

      expect(result).not.toBeNull()
      expect(result.satProductKey).toBe('81111500')
      expect(result.satUnitKey).toBe('E48')
      expect(result.objetoImp).toBe('02')
    })

    it('returns null satProductKey and satUnitKey when not set', async () => {
      const dbProduct = makeMockProduct()

      prismaMock.product.findFirst.mockResolvedValue(dbProduct)

      const result = await productService.getProduct('venue-xyz', 'product-abc')

      expect(result.satProductKey).toBeNull()
      expect(result.satUnitKey).toBeNull()
      expect(result.objetoImp).toBe('02') // Prisma default
    })
  })
})
