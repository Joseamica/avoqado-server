/**
 * Modifier Inventory Analytics Service Tests
 *
 * Tests the analytics functions for modifier inventory usage,
 * cost tracking, and low stock alerts.
 */

import prisma from '@/utils/prismaClient'
import {
  getModifierUsageStats,
  getModifiersLowStock,
  getModifierInventorySummary,
  getModifiersWithInventory,
} from '@/services/dashboard/modifierInventoryAnalytics.service'
import { Decimal } from '@prisma/client/runtime/library'
import { ModifierInventoryMode } from '@prisma/client'

// Re-mock prisma for this specific test file to add missing methods
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    modifier: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    orderItemModifier: {
      findMany: jest.fn(),
    },
    rawMaterial: {
      fields: {
        reorderPoint: 'reorderPoint', // Mock the fields reference for Prisma comparison
      },
    },
    $queryRaw: jest.fn(),
  },
}))

describe('Modifier Inventory Analytics Service', () => {
  const mockVenueId = 'venue-123'

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('getModifierUsageStats', () => {
    it('should return empty array when no modifier usages exist', async () => {
      ;(prisma.orderItemModifier.findMany as jest.Mock).mockResolvedValue([])

      const result = await getModifierUsageStats(mockVenueId)

      expect(result).toEqual([])
      expect(prisma.orderItemModifier.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            orderItem: expect.objectContaining({
              order: expect.objectContaining({
                venueId: mockVenueId,
                status: 'COMPLETED',
              }),
            }),
          }),
        }),
      )
    })

    it('should aggregate usage statistics correctly', async () => {
      const mockUsages = [
        {
          modifier: {
            id: 'mod-1',
            name: 'Extra Cheese',
            group: { id: 'group-1', name: 'Toppings' },
            rawMaterial: {
              id: 'raw-1',
              name: 'Queso',
              unit: 'KILOGRAM',
              currentStock: new Decimal(10),
              costPerUnit: new Decimal(5),
            },
            quantityPerUnit: new Decimal(0.05),
            inventoryMode: 'ADDITION' as ModifierInventoryMode,
          },
          orderItem: { quantity: 2 },
          quantity: 1,
        },
        {
          modifier: {
            id: 'mod-1',
            name: 'Extra Cheese',
            group: { id: 'group-1', name: 'Toppings' },
            rawMaterial: {
              id: 'raw-1',
              name: 'Queso',
              unit: 'KILOGRAM',
              currentStock: new Decimal(10),
              costPerUnit: new Decimal(5),
            },
            quantityPerUnit: new Decimal(0.05),
            inventoryMode: 'ADDITION' as ModifierInventoryMode,
          },
          orderItem: { quantity: 1 },
          quantity: 2,
        },
      ]

      ;(prisma.orderItemModifier.findMany as jest.Mock).mockResolvedValue(mockUsages)

      const result = await getModifierUsageStats(mockVenueId)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        modifierId: 'mod-1',
        modifierName: 'Extra Cheese',
        groupId: 'group-1',
        groupName: 'Toppings',
        timesUsed: 2,
        totalQuantityUsed: 4, // (2*1) + (1*2)
        inventoryMode: 'ADDITION',
        quantityPerUnit: 0.05,
      })
      // Cost impact: 4 uses * 0.05 qty/use * 5 cost/unit = 1.0
      expect(result[0].totalCostImpact).toBeCloseTo(1.0)
    })

    it('should filter by date range when provided', async () => {
      ;(prisma.orderItemModifier.findMany as jest.Mock).mockResolvedValue([])

      const startDate = new Date('2024-01-01')
      const endDate = new Date('2024-01-31')

      await getModifierUsageStats(mockVenueId, { startDate, endDate })

      const callArg = (prisma.orderItemModifier.findMany as jest.Mock).mock.calls[0][0]
      expect(callArg.where.orderItem.order.createdAt.gte).toEqual(startDate)
      expect(callArg.where.orderItem.order.createdAt.lte).toEqual(endDate)
    })

    it('should filter by modifier group when provided', async () => {
      ;(prisma.orderItemModifier.findMany as jest.Mock).mockResolvedValue([])

      await getModifierUsageStats(mockVenueId, { modifierGroupId: 'group-1' })

      expect(prisma.orderItemModifier.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            modifier: expect.objectContaining({
              groupId: 'group-1',
            }),
          }),
        }),
      )
    })

    it('should handle modifiers without raw materials', async () => {
      const mockUsages = [
        {
          modifier: {
            id: 'mod-2',
            name: 'No Ice',
            group: { id: 'group-2', name: 'Options' },
            rawMaterial: null,
            quantityPerUnit: null,
            inventoryMode: 'ADDITION' as ModifierInventoryMode,
          },
          orderItem: { quantity: 1 },
          quantity: 1,
        },
      ]

      ;(prisma.orderItemModifier.findMany as jest.Mock).mockResolvedValue(mockUsages)

      const result = await getModifierUsageStats(mockVenueId)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        modifierId: 'mod-2',
        modifierName: 'No Ice',
        totalCostImpact: 0, // No raw material = no cost
        rawMaterial: undefined,
      })
    })

    it('should limit results when limit is provided', async () => {
      const mockUsages = Array.from({ length: 10 }, (_, i) => ({
        modifier: {
          id: `mod-${i}`,
          name: `Modifier ${i}`,
          group: { id: 'group-1', name: 'Toppings' },
          rawMaterial: null,
          quantityPerUnit: null,
          inventoryMode: 'ADDITION' as ModifierInventoryMode,
        },
        orderItem: { quantity: 1 },
        quantity: 1,
      }))

      ;(prisma.orderItemModifier.findMany as jest.Mock).mockResolvedValue(mockUsages)

      const result = await getModifierUsageStats(mockVenueId, { limit: 5 })

      expect(result).toHaveLength(5)
    })
  })

  describe('getModifiersLowStock', () => {
    it('should return modifiers with low stock raw materials', async () => {
      const mockLowStockModifiers = [
        {
          modifierId: 'mod-1',
          modifierName: 'Extra Cheese',
          groupId: 'group-1',
          groupName: 'Toppings',
          rawMaterialId: 'raw-1',
          rawMaterialName: 'Queso',
          unit: 'KILOGRAM',
          currentStock: 2,
          reorderPoint: 5,
          quantityPerUnit: 0.05,
          inventoryMode: 'ADDITION' as ModifierInventoryMode,
        },
      ]

      ;(prisma.modifier.findMany as jest.Mock).mockResolvedValue([]) // For the initial Prisma query
      ;(prisma.$queryRaw as jest.Mock).mockResolvedValue(mockLowStockModifiers)

      const result = await getModifiersLowStock(mockVenueId)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        modifierId: 'mod-1',
        modifierName: 'Extra Cheese',
        currentStock: 2,
        reorderPoint: 5,
        estimatedUsesRemaining: 40, // 2 / 0.05 = 40
      })
    })

    it('should return empty array when no modifiers have low stock', async () => {
      ;(prisma.modifier.findMany as jest.Mock).mockResolvedValue([])
      ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([])

      const result = await getModifiersLowStock(mockVenueId)

      expect(result).toEqual([])
    })

    it('should handle zero quantityPerUnit gracefully', async () => {
      const mockLowStockModifiers = [
        {
          modifierId: 'mod-1',
          modifierName: 'Custom Mod',
          groupId: 'group-1',
          groupName: 'Custom',
          rawMaterialId: 'raw-1',
          rawMaterialName: 'Material',
          unit: 'UNIT',
          currentStock: 5,
          reorderPoint: 10,
          quantityPerUnit: 0, // Zero quantity per unit
          inventoryMode: 'ADDITION' as ModifierInventoryMode,
        },
      ]

      ;(prisma.modifier.findMany as jest.Mock).mockResolvedValue([])
      ;(prisma.$queryRaw as jest.Mock).mockResolvedValue(mockLowStockModifiers)

      const result = await getModifiersLowStock(mockVenueId)

      expect(result).toHaveLength(1)
      expect(result[0].estimatedUsesRemaining).toBe(0) // Should be 0, not NaN/Infinity
    })
  })

  describe('getModifierInventorySummary', () => {
    it('should return comprehensive inventory summary', async () => {
      // Mock count of modifiers with inventory
      ;(prisma.modifier.count as jest.Mock).mockResolvedValue(5)

      // Mock low stock (from $queryRaw)
      ;(prisma.modifier.findMany as jest.Mock).mockResolvedValue([])
      ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([
        {
          modifierId: 'mod-1',
          modifierName: 'Low Stock Mod',
          groupId: 'group-1',
          groupName: 'Toppings',
          rawMaterialId: 'raw-1',
          rawMaterialName: 'Queso',
          unit: 'KILOGRAM',
          currentStock: 2,
          reorderPoint: 5,
          quantityPerUnit: 0.1,
          inventoryMode: 'ADDITION' as ModifierInventoryMode,
        },
      ])

      // Mock usage stats (from orderItemModifier)
      ;(prisma.orderItemModifier.findMany as jest.Mock).mockResolvedValue([
        {
          modifier: {
            id: 'mod-1',
            name: 'Low Stock Mod',
            group: { id: 'group-1', name: 'Toppings' },
            rawMaterial: {
              id: 'raw-1',
              name: 'Queso',
              unit: 'KILOGRAM',
              currentStock: new Decimal(2),
              costPerUnit: new Decimal(10),
            },
            quantityPerUnit: new Decimal(0.1),
            inventoryMode: 'ADDITION' as ModifierInventoryMode,
          },
          orderItem: { quantity: 5 },
          quantity: 1,
        },
      ])

      const result = await getModifierInventorySummary(mockVenueId)

      expect(result.totalModifiersWithInventory).toBe(5)
      expect(result.totalModifiersLowStock).toBe(1)
      expect(result.lowStockModifiers).toHaveLength(1)
      expect(result.topCostModifiers).toHaveLength(1)
      // Cost impact: 5 uses * 0.1 qty/use * 10 cost/unit = 5.0
      expect(result.totalCostImpactPeriod).toBeCloseTo(5.0)
    })

    it('should filter by date range for cost calculations', async () => {
      ;(prisma.modifier.count as jest.Mock).mockResolvedValue(0)
      ;(prisma.modifier.findMany as jest.Mock).mockResolvedValue([])
      ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([])
      ;(prisma.orderItemModifier.findMany as jest.Mock).mockResolvedValue([])

      const startDate = new Date('2024-01-01')
      const endDate = new Date('2024-01-31')

      await getModifierInventorySummary(mockVenueId, { startDate, endDate })

      // Verify orderItemModifier.findMany was called with date filter
      const callArg = (prisma.orderItemModifier.findMany as jest.Mock).mock.calls[0][0]
      expect(callArg.where.orderItem.order.createdAt.gte).toEqual(startDate)
      expect(callArg.where.orderItem.order.createdAt.lte).toEqual(endDate)
    })
  })

  describe('getModifiersWithInventory', () => {
    it('should return all modifiers with inventory configuration', async () => {
      const mockModifiers = [
        {
          id: 'mod-1',
          name: 'Extra Cheese',
          group: { id: 'group-1', name: 'Toppings' },
          rawMaterialId: 'raw-1',
          rawMaterial: {
            id: 'raw-1',
            name: 'Queso',
            unit: 'KILOGRAM',
            currentStock: new Decimal(10),
          },
          quantityPerUnit: new Decimal(0.05),
          unit: 'KILOGRAM',
          inventoryMode: 'ADDITION' as ModifierInventoryMode,
          cost: new Decimal(0.25),
          active: true,
        },
      ]

      ;(prisma.modifier.findMany as jest.Mock).mockResolvedValue(mockModifiers)

      const result = await getModifiersWithInventory(mockVenueId)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        id: 'mod-1',
        name: 'Extra Cheese',
        groupId: 'group-1',
        groupName: 'Toppings',
        rawMaterialId: 'raw-1',
        rawMaterialName: 'Queso',
        quantityPerUnit: 0.05,
        unit: 'KILOGRAM',
        inventoryMode: 'ADDITION',
        cost: 0.25,
        currentStock: 10,
        active: true,
      })
    })

    it('should filter by modifier group when provided', async () => {
      ;(prisma.modifier.findMany as jest.Mock).mockResolvedValue([])

      await getModifiersWithInventory(mockVenueId, { groupId: 'group-1' })

      expect(prisma.modifier.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            group: expect.objectContaining({
              id: 'group-1',
            }),
          }),
        }),
      )
    })

    it('should include inactive modifiers when requested', async () => {
      ;(prisma.modifier.findMany as jest.Mock).mockResolvedValue([])

      await getModifiersWithInventory(mockVenueId, { includeInactive: true })

      // When includeInactive is true, active filter should not be applied
      expect(prisma.modifier.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.not.objectContaining({
            active: true,
          }),
        }),
      )
    })

    it('should handle modifiers without raw materials', async () => {
      const mockModifiers = [
        {
          id: 'mod-2',
          name: 'No Ice',
          group: { id: 'group-2', name: 'Options' },
          rawMaterialId: null,
          rawMaterial: null,
          quantityPerUnit: null,
          unit: null,
          inventoryMode: 'ADDITION' as ModifierInventoryMode,
          cost: null,
          active: true,
        },
      ]

      ;(prisma.modifier.findMany as jest.Mock).mockResolvedValue(mockModifiers)

      const result = await getModifiersWithInventory(mockVenueId)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        id: 'mod-2',
        name: 'No Ice',
        rawMaterialId: null,
        rawMaterialName: null,
        quantityPerUnit: null,
        cost: null,
        currentStock: null,
      })
    })
  })
})
