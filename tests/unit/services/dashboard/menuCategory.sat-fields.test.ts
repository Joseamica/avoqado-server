/**
 * Tests: SAT fiscal fields on MenuCategory (defaultSatProductKey, defaultSatUnitKey)
 *
 * Verifies:
 *  - createMenuCategory persists SAT fields when provided
 *  - updateMenuCategory persists SAT fields when provided
 *  - updateMenuCategory WITHOUT SAT fields does not overwrite existing values (regression)
 *  - getMenuCategoryById returns SAT fields
 */

import { prismaMock } from '../../../__helpers__/setup'
import * as menuService from '../../../../src/services/dashboard/menu.dashboard.service'

// Mock Socket.IO
jest.mock('../../../../src/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))

// Mock slug utility so we don't depend on its internals
jest.mock('../../../../src/utils/slugify', () => ({
  generateSlug: jest.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
}))

const makeMockCategory = (overrides: Record<string, any> = {}) => ({
  id: 'cat-001',
  venueId: 'venue-xyz',
  name: 'Alimentos',
  slug: 'alimentos',
  description: null,
  displayOrder: 0,
  imageUrl: null,
  color: null,
  icon: null,
  parentId: null,
  active: true,
  availableFrom: null,
  availableUntil: null,
  availableDays: [],
  defaultSatProductKey: null,
  defaultSatUnitKey: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  ...overrides,
})

describe('MenuCategory SAT fiscal fields', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ──────────────────────────────────────────────────────────────
  // CREATE
  // ──────────────────────────────────────────────────────────────
  describe('createMenuCategory — SAT fields', () => {
    it('persists defaultSatProductKey and defaultSatUnitKey when provided', async () => {
      const createdCategory = makeMockCategory({
        defaultSatProductKey: '43232500',
        defaultSatUnitKey: 'H87',
      })

      // No duplicate slug
      prismaMock.menuCategory.findUnique.mockResolvedValue(null)
      prismaMock.menuCategory.create.mockResolvedValue(createdCategory as any)

      const result = await menuService.createMenuCategory('venue-xyz', {
        name: 'Alimentos',
        defaultSatProductKey: '43232500',
        defaultSatUnitKey: 'H87',
      })

      const createCall = prismaMock.menuCategory.create.mock.calls[0][0]
      expect(createCall.data.defaultSatProductKey).toBe('43232500')
      expect(createCall.data.defaultSatUnitKey).toBe('H87')

      expect(result.defaultSatProductKey).toBe('43232500')
      expect(result.defaultSatUnitKey).toBe('H87')
    })

    it('does NOT include SAT fields in create data when not provided', async () => {
      const createdCategory = makeMockCategory()

      prismaMock.menuCategory.findUnique.mockResolvedValue(null)
      prismaMock.menuCategory.create.mockResolvedValue(createdCategory as any)

      await menuService.createMenuCategory('venue-xyz', { name: 'Alimentos' })

      const createCall = prismaMock.menuCategory.create.mock.calls[0][0]
      expect(createCall.data).not.toHaveProperty('defaultSatProductKey')
      expect(createCall.data).not.toHaveProperty('defaultSatUnitKey')
    })
  })

  // ──────────────────────────────────────────────────────────────
  // UPDATE
  // ──────────────────────────────────────────────────────────────
  describe('updateMenuCategory — SAT fields', () => {
    it('persists SAT fields when updating a category with them', async () => {
      const existing = makeMockCategory()
      const updated = makeMockCategory({
        defaultSatProductKey: '43232500',
        defaultSatUnitKey: 'E48',
      })

      prismaMock.menuCategory.findUnique.mockResolvedValue(existing as any)
      prismaMock.menuCategory.update.mockResolvedValue(updated as any)
      // product count for socket broadcast
      prismaMock.product.count.mockResolvedValue(0)

      const result = await menuService.updateMenuCategory('venue-xyz', 'cat-001', {
        defaultSatProductKey: '43232500',
        defaultSatUnitKey: 'E48',
      })

      const updateCall = prismaMock.menuCategory.update.mock.calls[0][0]
      expect(updateCall.data.defaultSatProductKey).toBe('43232500')
      expect(updateCall.data.defaultSatUnitKey).toBe('E48')

      expect(result.defaultSatProductKey).toBe('43232500')
      expect(result.defaultSatUnitKey).toBe('E48')
    })

    it('REGRESSION — updating without SAT fields does not overwrite existing SAT values', async () => {
      const existing = makeMockCategory({
        defaultSatProductKey: '43232500',
        defaultSatUnitKey: 'H87',
      })
      const updated = makeMockCategory({
        name: 'Nombre Nuevo',
        defaultSatProductKey: '43232500',
        defaultSatUnitKey: 'H87',
      })

      prismaMock.menuCategory.findUnique.mockResolvedValue(existing as any)
      prismaMock.menuCategory.update.mockResolvedValue(updated as any)
      prismaMock.product.count.mockResolvedValue(0)

      // Update with only name — no SAT fields
      await menuService.updateMenuCategory('venue-xyz', 'cat-001', { name: 'Nombre Nuevo' })

      const updateCall = prismaMock.menuCategory.update.mock.calls[0][0]
      // SAT fields must NOT appear in the updateData sent to Prisma
      expect(updateCall.data).not.toHaveProperty('defaultSatProductKey')
      expect(updateCall.data).not.toHaveProperty('defaultSatUnitKey')
    })

    it('allows clearing SAT fields by passing null', async () => {
      const existing = makeMockCategory({
        defaultSatProductKey: '43232500',
        defaultSatUnitKey: 'H87',
      })
      const updated = makeMockCategory({ defaultSatProductKey: null, defaultSatUnitKey: null })

      prismaMock.menuCategory.findUnique.mockResolvedValue(existing as any)
      prismaMock.menuCategory.update.mockResolvedValue(updated as any)
      prismaMock.product.count.mockResolvedValue(0)

      await menuService.updateMenuCategory('venue-xyz', 'cat-001', {
        defaultSatProductKey: null,
        defaultSatUnitKey: null,
      })

      const updateCall = prismaMock.menuCategory.update.mock.calls[0][0]
      expect(updateCall.data.defaultSatProductKey).toBeNull()
      expect(updateCall.data.defaultSatUnitKey).toBeNull()
    })
  })

  // ──────────────────────────────────────────────────────────────
  // GET
  // ──────────────────────────────────────────────────────────────
  describe('getMenuCategoryById — SAT fields', () => {
    it('returns defaultSatProductKey and defaultSatUnitKey in the category detail', async () => {
      const dbCategory = makeMockCategory({
        defaultSatProductKey: '43232500',
        defaultSatUnitKey: 'H87',
        products: [],
        menus: [],
      })

      prismaMock.menuCategory.findUnique.mockResolvedValue(dbCategory as any)

      const result = await menuService.getMenuCategoryById('venue-xyz', 'cat-001')

      expect(result.defaultSatProductKey).toBe('43232500')
      expect(result.defaultSatUnitKey).toBe('H87')
    })

    it('returns null SAT fields when not set', async () => {
      const dbCategory = makeMockCategory({ products: [], menus: [] })

      prismaMock.menuCategory.findUnique.mockResolvedValue(dbCategory as any)

      const result = await menuService.getMenuCategoryById('venue-xyz', 'cat-001')

      expect(result.defaultSatProductKey).toBeNull()
      expect(result.defaultSatUnitKey).toBeNull()
    })
  })
})
