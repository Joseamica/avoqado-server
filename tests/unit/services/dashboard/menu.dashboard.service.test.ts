/**
 * Tests: printStationId on MenuCategory (print-station routing)
 *
 * printStationId is a FK with a Prisma relation (`printStation`), and createData/updateData
 * in menu.dashboard.service.ts are explicitly typed as the "checked" Prisma input
 * (MenuCategoryCreateInput / MenuCategoryUpdateInput), so the service writes it via the
 * relation object (`printStation: { connect / disconnect }`) — same pattern as `parentId`/`parent`
 * in this file — rather than as a raw scalar.
 *
 * Verifies:
 *  - createMenuCategory connects printStation when printStationId is provided
 *  - createMenuCategory omits printStation when printStationId is not provided
 *  - updateMenuCategory connects printStation when printStationId is provided
 *  - updateMenuCategory WITHOUT printStationId does not touch the printStation relation (regression)
 *  - updateMenuCategory disconnects printStation when printStationId is passed as null
 */

import { prismaMock } from '../../../__helpers__/setup'
import * as menuService from '../../../../src/services/dashboard/menu.dashboard.service'

// Mock Socket.IO so getBroadcastingService() returns null (no broadcasts)
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
  printStationId: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  ...overrides,
})

describe('MenuCategory printStationId (print-station routing)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ──────────────────────────────────────────────────────────────
  // CREATE
  // ──────────────────────────────────────────────────────────────
  describe('createMenuCategory — printStationId', () => {
    it('connects printStation when printStationId is provided', async () => {
      const createdCategory = makeMockCategory({ printStationId: 'station-001' })

      // No duplicate slug
      prismaMock.menuCategory.findUnique.mockResolvedValue(null)
      prismaMock.menuCategory.create.mockResolvedValue(createdCategory as any)

      const result = await menuService.createMenuCategory('venue-xyz', {
        name: 'Alimentos',
        printStationId: 'station-001',
      })

      const createCall = prismaMock.menuCategory.create.mock.calls[0][0]
      expect(createCall.data.printStation).toEqual({ connect: { id: 'station-001' } })
      expect(result.printStationId).toBe('station-001')
    })

    it('omits printStation when printStationId is not provided', async () => {
      const createdCategory = makeMockCategory()

      prismaMock.menuCategory.findUnique.mockResolvedValue(null)
      prismaMock.menuCategory.create.mockResolvedValue(createdCategory as any)

      await menuService.createMenuCategory('venue-xyz', { name: 'Alimentos' })

      const createCall = prismaMock.menuCategory.create.mock.calls[0][0]
      expect(createCall.data).not.toHaveProperty('printStation')
    })
  })

  // ──────────────────────────────────────────────────────────────
  // UPDATE
  // ──────────────────────────────────────────────────────────────
  describe('updateMenuCategory — printStationId', () => {
    it('connects printStation when updating a category with a printStationId', async () => {
      const existing = makeMockCategory()
      const updated = makeMockCategory({ printStationId: 'station-002' })

      prismaMock.menuCategory.findUnique.mockResolvedValue(existing as any)
      prismaMock.menuCategory.update.mockResolvedValue(updated as any)
      // product count for socket broadcast
      prismaMock.product.count.mockResolvedValue(0)

      const result = await menuService.updateMenuCategory('venue-xyz', 'cat-001', {
        printStationId: 'station-002',
      })

      const updateCall = prismaMock.menuCategory.update.mock.calls[0][0]
      expect(updateCall.data.printStation).toEqual({ connect: { id: 'station-002' } })
      expect(result.printStationId).toBe('station-002')
    })

    it('REGRESSION — updating without printStationId does not touch the printStation relation', async () => {
      const existing = makeMockCategory({ printStationId: 'station-001' })
      const updated = makeMockCategory({ name: 'Nombre Nuevo', printStationId: 'station-001' })

      prismaMock.menuCategory.findUnique.mockResolvedValue(existing as any)
      prismaMock.menuCategory.update.mockResolvedValue(updated as any)
      prismaMock.product.count.mockResolvedValue(0)

      // Update with only name — no printStationId
      await menuService.updateMenuCategory('venue-xyz', 'cat-001', { name: 'Nombre Nuevo' })

      const updateCall = prismaMock.menuCategory.update.mock.calls[0][0]
      // printStation must NOT appear in the updateData sent to Prisma
      expect(updateCall.data).not.toHaveProperty('printStation')
    })

    it('disconnects printStation when printStationId is passed as null', async () => {
      const existing = makeMockCategory({ printStationId: 'station-001' })
      const updated = makeMockCategory({ printStationId: null })

      prismaMock.menuCategory.findUnique.mockResolvedValue(existing as any)
      prismaMock.menuCategory.update.mockResolvedValue(updated as any)
      prismaMock.product.count.mockResolvedValue(0)

      await menuService.updateMenuCategory('venue-xyz', 'cat-001', { printStationId: null })

      const updateCall = prismaMock.menuCategory.update.mock.calls[0][0]
      expect(updateCall.data.printStation).toEqual({ disconnect: true })
    })
  })
})
