import { Decimal } from '@prisma/client/runtime/library'
import { MovementType } from '@prisma/client'

// import AppError from '../../../../src/errors/AppError'
import { prismaMock } from '../../../__helpers__/setup'

// Import the service - need to import after mock setup
import * as productInventoryIntegrationService from '../../../../src/services/dashboard/productInventoryIntegration.service'

// Helper to create mock Product
const createMockProduct = (overrides: Record<string, any> = {}) => ({
  id: 'product-123',
  venueId: 'venue-123',
  name: 'Test Product',
  price: new Decimal(100),
  cost: new Decimal(50),
  trackInventory: true,
  inventoryMethod: 'QUANTITY' as const,
  externalData: null,
  recipe: null,
  ...overrides,
})

// Helper to create mock Inventory
const createMockInventory = (overrides: Record<string, any> = {}) => ({
  id: 'inventory-123',
  productId: 'product-123',
  venueId: 'venue-123',
  currentStock: new Decimal(100),
  reservedStock: new Decimal(0),
  minimumStock: new Decimal(10),
  maximumStock: null,
  lastCountedAt: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-20'),
  ...overrides,
})

describe('ProductInventoryIntegration Service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('deductInventoryForProduct - QUANTITY method', () => {
    /**
     * ✅ FIX VALIDATION: This test validates the 2025-11-29 fix
     * that deductSimpleStock now uses the Inventory table
     * instead of the RawMaterial table
     */
    it('should deduct stock from Inventory table for QUANTITY products', async () => {
      const mockProduct = createMockProduct({
        inventoryMethod: 'QUANTITY',
        trackInventory: true,
      })
      const mockInventory = createMockInventory({
        currentStock: new Decimal(100),
      })

      // Mock top-level product.findUnique (called by getProductInventoryMethod)
      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)

      // Mock interactive transaction (callback pattern)
      prismaMock.$transaction.mockImplementation(async (callback: any) => {
        const txMock = {
          product: {
            findUnique: jest.fn().mockResolvedValue(mockProduct),
          },
          inventory: {
            findUnique: jest.fn().mockResolvedValue(mockInventory),
            update: jest.fn().mockResolvedValue({
              ...mockInventory,
              currentStock: new Decimal(98),
            }),
          },
          inventoryMovement: {
            create: jest.fn().mockResolvedValue({
              id: 'movement-123',
              inventoryId: mockInventory.id,
              type: MovementType.SALE,
              quantity: new Decimal(-2),
              previousStock: new Decimal(100),
              newStock: new Decimal(98),
            }),
          },
        }
        return callback(txMock)
      })

      const result = await productInventoryIntegrationService.deductInventoryForProduct(
        'venue-123',
        'product-123',
        2, // quantity
        'order-123',
        'staff-123',
      )

      // Verify result structure
      expect(result).toEqual({
        inventoryMethod: 'QUANTITY',
        inventoryId: 'inventory-123',
        quantityDeducted: 2,
        remainingStock: 98,
        message: 'Deducted 2 unit(s) from inventory tracking',
      })
    })

    it('should throw 404 error when no Inventory record exists', async () => {
      const mockProduct = createMockProduct({
        inventoryMethod: 'QUANTITY',
        trackInventory: true,
        name: 'Orphan Product',
      })

      // Mock top-level product.findUnique (called by getProductInventoryMethod)
      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)

      // Mock interactive transaction - returns null for inventory
      prismaMock.$transaction.mockImplementation(async (callback: any) => {
        const txMock = {
          product: {
            findUnique: jest.fn().mockResolvedValue(mockProduct),
          },
          inventory: {
            findUnique: jest.fn().mockResolvedValue(null), // No inventory!
          },
        }
        return callback(txMock)
      })

      await expect(
        productInventoryIntegrationService.deductInventoryForProduct('venue-123', 'product-123', 2, 'order-123'),
      ).rejects.toThrow(/No inventory record for product/)
    })

    it('should throw 400 error when insufficient stock', async () => {
      const mockProduct = createMockProduct({
        inventoryMethod: 'QUANTITY',
        trackInventory: true,
        name: 'Low Stock Product',
      })
      const mockInventory = createMockInventory({
        currentStock: new Decimal(5), // Only 5 units
      })

      // Mock top-level product.findUnique (called by getProductInventoryMethod)
      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)

      // Mock interactive transaction - checks fail before update
      prismaMock.$transaction.mockImplementation(async (callback: any) => {
        const txMock = {
          product: {
            findUnique: jest.fn().mockResolvedValue(mockProduct),
          },
          inventory: {
            findUnique: jest.fn().mockResolvedValue(mockInventory),
          },
        }
        return callback(txMock)
      })

      // Try to deduct 10 units (more than available)
      await expect(
        productInventoryIntegrationService.deductInventoryForProduct('venue-123', 'product-123', 10, 'order-123'),
      ).rejects.toThrow(/Insufficient stock/)
    })

    it('should create InventoryMovement with correct audit data', async () => {
      const mockProduct = createMockProduct({
        inventoryMethod: 'QUANTITY',
        trackInventory: true,
        name: 'Audited Product',
      })
      const mockInventory = createMockInventory({
        id: 'inv-456',
        currentStock: new Decimal(50),
      })

      const movementCreateMock = jest.fn().mockResolvedValue({
        id: 'movement-456',
        inventoryId: 'inv-456',
        type: MovementType.SALE,
        quantity: new Decimal(-5),
        previousStock: new Decimal(50),
        newStock: new Decimal(45),
        reason: 'Sold 5x Audited Product',
        reference: 'order-789',
        createdBy: 'staff-456',
      })

      // Mock top-level product.findUnique (called by getProductInventoryMethod)
      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)

      // Mock interactive transaction
      prismaMock.$transaction.mockImplementation(async (callback: any) => {
        const txMock = {
          product: {
            findUnique: jest.fn().mockResolvedValue(mockProduct),
          },
          inventory: {
            findUnique: jest.fn().mockResolvedValue(mockInventory),
            update: jest.fn().mockResolvedValue({
              ...mockInventory,
              currentStock: new Decimal(45),
            }),
          },
          inventoryMovement: {
            create: movementCreateMock,
          },
        }
        return callback(txMock)
      })

      await productInventoryIntegrationService.deductInventoryForProduct('venue-123', 'product-123', 5, 'order-789', 'staff-456')

      // Verify InventoryMovement was created with correct audit data
      expect(movementCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            inventoryId: 'inv-456',
            type: MovementType.SALE,
            reason: 'Sold 5x Audited Product',
            reference: 'order-789',
            createdBy: 'staff-456',
          }),
        }),
      )
    })

    it('should handle exact stock deduction (stock goes to zero)', async () => {
      const mockProduct = createMockProduct({
        inventoryMethod: 'QUANTITY',
        trackInventory: true,
      })
      const mockInventory = createMockInventory({
        currentStock: new Decimal(10), // Exactly 10 units
      })

      // Mock top-level product.findUnique (called by getProductInventoryMethod)
      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)

      // Mock interactive transaction
      prismaMock.$transaction.mockImplementation(async (callback: any) => {
        const txMock = {
          product: {
            findUnique: jest.fn().mockResolvedValue(mockProduct),
          },
          inventory: {
            findUnique: jest.fn().mockResolvedValue(mockInventory),
            update: jest.fn().mockResolvedValue({
              ...mockInventory,
              currentStock: new Decimal(0),
            }),
          },
          inventoryMovement: {
            create: jest.fn().mockResolvedValue({
              id: 'movement-123',
              inventoryId: mockInventory.id,
              type: MovementType.SALE,
              quantity: new Decimal(-10),
              previousStock: new Decimal(10),
              newStock: new Decimal(0),
            }),
          },
        }
        return callback(txMock)
      })

      const result = await productInventoryIntegrationService.deductInventoryForProduct(
        'venue-123',
        'product-123',
        10, // Deduct all 10
        'order-123',
      )

      // Cast to expected type for QUANTITY method
      expect((result as any).remainingStock).toBe(0)
    })
  })

  describe('getProductInventoryMethod', () => {
    it('should return QUANTITY when inventoryMethod is set to QUANTITY', async () => {
      const mockProduct = createMockProduct({
        trackInventory: true,
        inventoryMethod: 'QUANTITY',
      })

      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)

      const result = await productInventoryIntegrationService.getProductInventoryMethod('product-123')

      expect(result).toBe('QUANTITY')
    })

    it('should return RECIPE when inventoryMethod is set to RECIPE', async () => {
      const mockProduct = createMockProduct({
        trackInventory: true,
        inventoryMethod: 'RECIPE',
      })

      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)

      const result = await productInventoryIntegrationService.getProductInventoryMethod('product-123')

      expect(result).toBe('RECIPE')
    })

    it('should return null when trackInventory is false', async () => {
      const mockProduct = createMockProduct({
        trackInventory: false,
        inventoryMethod: null,
      })

      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)

      const result = await productInventoryIntegrationService.getProductInventoryMethod('product-123')

      expect(result).toBeNull()
    })

    it('should fallback to RECIPE when product has recipe relation but no inventoryMethod', async () => {
      const mockProduct = createMockProduct({
        trackInventory: true,
        inventoryMethod: null, // Legacy product without explicit method
        recipe: { id: 'recipe-123' }, // Has a recipe
      })

      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)

      const result = await productInventoryIntegrationService.getProductInventoryMethod('product-123')

      expect(result).toBe('RECIPE')
    })
  })

  describe('getProductInventoryStatus - QUANTITY method', () => {
    it('should return status from Inventory table for QUANTITY products', async () => {
      const mockProduct = createMockProduct({
        trackInventory: true,
        inventoryMethod: 'QUANTITY',
        recipe: null,
      })
      const mockInventory = createMockInventory({
        currentStock: new Decimal(75),
        minimumStock: new Decimal(10),
      })

      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)
      prismaMock.inventory.findUnique.mockResolvedValue(mockInventory as any)

      const result = await productInventoryIntegrationService.getProductInventoryStatus('venue-123', 'product-123')

      expect(result).toEqual({
        inventoryMethod: 'QUANTITY',
        available: true,
        currentStock: 75,
        reorderPoint: 10,
        lowStock: false,
        message: '75 unit(s) in stock',
      })
    })

    it('should detect low stock correctly', async () => {
      const mockProduct = createMockProduct({
        trackInventory: true,
        inventoryMethod: 'QUANTITY',
        recipe: null,
      })
      const mockInventory = createMockInventory({
        currentStock: new Decimal(8), // Below minimum of 10
        minimumStock: new Decimal(10),
      })

      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)
      prismaMock.inventory.findUnique.mockResolvedValue(mockInventory as any)

      const result = await productInventoryIntegrationService.getProductInventoryStatus('venue-123', 'product-123')

      expect(result.lowStock).toBe(true)
    })

    it('should return not available when stock is zero', async () => {
      const mockProduct = createMockProduct({
        trackInventory: true,
        inventoryMethod: 'QUANTITY',
        recipe: null,
      })
      const mockInventory = createMockInventory({
        currentStock: new Decimal(0),
        minimumStock: new Decimal(10),
      })

      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)
      prismaMock.inventory.findUnique.mockResolvedValue(mockInventory as any)

      const result = await productInventoryIntegrationService.getProductInventoryStatus('venue-123', 'product-123')

      expect(result.available).toBe(false)
    })
  })

  describe('Regression tests - ensure no breaking changes', () => {
    it('should not query RawMaterial for QUANTITY products', async () => {
      const mockProduct = createMockProduct({
        inventoryMethod: 'QUANTITY',
        trackInventory: true,
      })
      const mockInventory = createMockInventory({
        currentStock: new Decimal(50),
      })

      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)
      prismaMock.inventory.findUnique.mockResolvedValue(mockInventory as any)
      // Mock array-based $transaction
      prismaMock.$transaction.mockResolvedValue([mockInventory, { id: 'movement-123' }])

      await productInventoryIntegrationService.deductInventoryForProduct('venue-123', 'product-123', 5, 'order-123')

      // CRITICAL: Should NOT query RawMaterial for QUANTITY products
      expect(prismaMock.rawMaterial.findUnique).not.toHaveBeenCalled()
      expect(prismaMock.rawMaterial.findFirst).not.toHaveBeenCalled()
      expect(prismaMock.rawMaterial.create).not.toHaveBeenCalled()
    })

    it('should not create RawMaterialMovement for QUANTITY products', async () => {
      const mockProduct = createMockProduct({
        inventoryMethod: 'QUANTITY',
        trackInventory: true,
      })
      const mockInventory = createMockInventory({
        currentStock: new Decimal(50),
      })

      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)
      prismaMock.inventory.findUnique.mockResolvedValue(mockInventory as any)
      // Mock array-based $transaction
      prismaMock.$transaction.mockResolvedValue([mockInventory, { id: 'movement-123' }])

      await productInventoryIntegrationService.deductInventoryForProduct('venue-123', 'product-123', 5, 'order-123')

      // CRITICAL: Should NOT create RawMaterialMovement for QUANTITY products
      // The rawMaterialMovement mock should NOT be called
      expect(prismaMock.rawMaterialMovement.create).not.toHaveBeenCalled()
    })

    it('should skip deduction for products without inventory tracking', async () => {
      const mockProduct = createMockProduct({
        trackInventory: false,
        inventoryMethod: null,
      })

      prismaMock.product.findUnique.mockResolvedValue(mockProduct as any)

      const result = await productInventoryIntegrationService.deductInventoryForProduct('venue-123', 'product-123', 5, 'order-123')

      expect(result.inventoryMethod).toBeNull()
      expect(result.message).toContain('No inventory deduction needed')

      // Should not query any inventory tables
      expect(prismaMock.inventory.findUnique).not.toHaveBeenCalled()
      expect(prismaMock.rawMaterial.findUnique).not.toHaveBeenCalled()
    })
  })
})
