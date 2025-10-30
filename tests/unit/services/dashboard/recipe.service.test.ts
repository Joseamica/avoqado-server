/**
 * Recipe Service Tests - Priority 1B: Active/Deleted Validation
 *
 * Tests the active/deleted ingredient validation added to prevent
 * recipes from being created with inactive or deleted ingredients.
 *
 * World-Class Pattern: Toast POS / Square
 */

import prisma from '@/utils/prismaClient'
import { createRecipe, updateRecipe, addRecipeLine } from '@/services/dashboard/recipe.service'
import AppError from '@/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'

// Mock dependencies
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    product: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    recipe: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    rawMaterial: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    recipeLine: {
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

describe('Recipe Service - Active/Deleted Validation', () => {
  const mockVenueId = 'venue-123'
  const mockProductId = 'product-123'

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('createRecipe - Priority 1B', () => {
    it('should create recipe successfully with active ingredients', async () => {
      // Setup
      const mockProduct = {
        id: mockProductId,
        venueId: mockVenueId,
        name: 'Hamburguesa',
        price: new Decimal(10),
      }

      const mockActiveRawMaterial = {
        id: 'raw-1',
        venueId: mockVenueId,
        name: 'Carne',
        costPerUnit: new Decimal(5),
        active: true,
        deletedAt: null,
      }

      const mockRecipe = {
        id: 'recipe-1',
        productId: mockProductId,
        portionYield: 1,
        totalCost: new Decimal(5),
        lines: [],
        product: mockProduct,
      }

      ;(prisma.product.findFirst as jest.Mock).mockResolvedValue(mockProduct)
      ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue(null)
      ;(prisma.rawMaterial.findMany as jest.Mock).mockResolvedValue([mockActiveRawMaterial])
      ;(prisma.recipe.create as jest.Mock).mockResolvedValue(mockRecipe)

      // Execute
      const result = await createRecipe(mockVenueId, mockProductId, {
        portionYield: 1,
        lines: [
          {
            rawMaterialId: 'raw-1',
            quantity: 1,
            unit: 'KILOGRAM',
            isOptional: false,
          },
        ],
      })

      // Verify
      expect(result).toEqual(mockRecipe)
      expect(prisma.rawMaterial.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['raw-1'] },
          venueId: mockVenueId,
          active: true, // ✅ CRITICAL: Validates active
          deletedAt: null, // ✅ CRITICAL: Validates not deleted
        },
      })
    })

    it('should reject recipe creation with inactive ingredients', async () => {
      // Setup
      const mockProduct = {
        id: mockProductId,
        venueId: mockVenueId,
        name: 'Hamburguesa',
      }

      ;(prisma.product.findFirst as jest.Mock).mockResolvedValue(mockProduct)
      ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue(null)
      // Return empty array - simulates inactive/deleted ingredients not found
      ;(prisma.rawMaterial.findMany as jest.Mock).mockResolvedValue([])

      // Execute & Verify
      await expect(
        createRecipe(mockVenueId, mockProductId, {
          portionYield: 1,
          lines: [
            {
              rawMaterialId: 'raw-inactive',
              quantity: 1,
              unit: 'KILOGRAM',
              isOptional: false,
            },
          ],
        }),
      ).rejects.toThrow(AppError)

      await expect(
        createRecipe(mockVenueId, mockProductId, {
          portionYield: 1,
          lines: [
            {
              rawMaterialId: 'raw-inactive',
              quantity: 1,
              unit: 'KILOGRAM',
              isOptional: false,
            },
          ],
        }),
      ).rejects.toThrow(/inactive.*deleted.*not found/i)
    })

    it('should reject recipe creation with mix of active and inactive ingredients', async () => {
      // Setup
      const mockProduct = {
        id: mockProductId,
        venueId: mockVenueId,
        name: 'Hamburguesa',
      }

      const mockActiveRawMaterial = {
        id: 'raw-active',
        venueId: mockVenueId,
        name: 'Carne',
        active: true,
        deletedAt: null,
      }

      ;(prisma.product.findFirst as jest.Mock).mockResolvedValue(mockProduct)
      ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue(null)
      // Only returns the active one - simulates one inactive
      ;(prisma.rawMaterial.findMany as jest.Mock).mockResolvedValue([mockActiveRawMaterial])

      // Execute & Verify
      await expect(
        createRecipe(mockVenueId, mockProductId, {
          portionYield: 1,
          lines: [
            { rawMaterialId: 'raw-active', quantity: 1, unit: 'KILOGRAM', isOptional: false },
            { rawMaterialId: 'raw-inactive', quantity: 1, unit: 'KILOGRAM', isOptional: false }, // This one is inactive
          ],
        }),
      ).rejects.toThrow(AppError)
    })
  })

  describe('updateRecipe - Priority 1B', () => {
    it('should update recipe successfully with active ingredients', async () => {
      // Setup
      const mockExistingRecipe = {
        id: 'recipe-1',
        productId: mockProductId,
        portionYield: 1,
        totalCost: new Decimal(5),
        product: { venueId: mockVenueId },
      }

      const mockActiveRawMaterial = {
        id: 'raw-1',
        venueId: mockVenueId,
        name: 'Carne',
        costPerUnit: new Decimal(5),
        active: true,
        deletedAt: null,
      }

      const mockUpdatedRecipe = {
        ...mockExistingRecipe,
        lines: [],
      }

      ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue(mockExistingRecipe)
      ;(prisma.rawMaterial.findMany as jest.Mock).mockResolvedValue([mockActiveRawMaterial])
      ;(prisma.$transaction as jest.Mock).mockResolvedValue(mockUpdatedRecipe)

      // Execute
      const result = await updateRecipe(mockVenueId, mockProductId, {
        lines: [
          {
            rawMaterialId: 'raw-1',
            quantity: 2,
            unit: 'KILOGRAM',
            isOptional: false,
          },
        ],
      })

      // Verify
      expect(result).toEqual(mockUpdatedRecipe)
      expect(prisma.rawMaterial.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['raw-1'] },
          venueId: mockVenueId,
          active: true,
          deletedAt: null,
        },
      })
    })

    it('should reject recipe update with inactive ingredients', async () => {
      // Setup
      const mockExistingRecipe = {
        id: 'recipe-1',
        productId: mockProductId,
        portionYield: 1,
        totalCost: new Decimal(5),
        product: { venueId: mockVenueId },
      }

      ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue(mockExistingRecipe)
      ;(prisma.rawMaterial.findMany as jest.Mock).mockResolvedValue([])

      // Execute & Verify
      await expect(
        updateRecipe(mockVenueId, mockProductId, {
          lines: [
            {
              rawMaterialId: 'raw-inactive',
              quantity: 1,
              unit: 'KILOGRAM',
              isOptional: false,
            },
          ],
        }),
      ).rejects.toThrow(AppError)
    })
  })

  describe('addRecipeLine - Priority 1B', () => {
    it('should add recipe line successfully with active ingredient', async () => {
      // Setup
      const mockRecipe = {
        id: 'recipe-1',
        productId: mockProductId,
        portionYield: 1,
        totalCost: new Decimal(5),
        product: { venueId: mockVenueId },
        lines: [],
      }

      const mockActiveRawMaterial = {
        id: 'raw-1',
        venueId: mockVenueId,
        name: 'Tomate',
        costPerUnit: new Decimal(2),
        active: true,
        deletedAt: null,
      }

      const mockRecipeLine = {
        id: 'line-1',
        recipeId: 'recipe-1',
        rawMaterialId: 'raw-1',
        quantity: new Decimal(1),
        rawMaterial: mockActiveRawMaterial,
      }

      ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue(mockRecipe)
      ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(mockActiveRawMaterial)
      ;(prisma.recipeLine.create as jest.Mock).mockResolvedValue(mockRecipeLine)
      ;(prisma.recipe.update as jest.Mock).mockResolvedValue(mockRecipe)

      // Execute
      const result = await addRecipeLine(mockVenueId, mockProductId, {
        rawMaterialId: 'raw-1',
        quantity: 1,
        unit: 'KILOGRAM',
      })

      // Verify
      expect(result).toEqual(mockRecipeLine)
      expect(prisma.rawMaterial.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'raw-1',
          venueId: mockVenueId,
          active: true,
          deletedAt: null,
        },
      })
    })

    it('should reject adding inactive ingredient to recipe', async () => {
      // Setup
      const mockRecipe = {
        id: 'recipe-1',
        productId: mockProductId,
        portionYield: 1,
        totalCost: new Decimal(5),
        product: { venueId: mockVenueId },
        lines: [],
      }

      ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue(mockRecipe)
      ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(null) // Inactive/deleted

      // Execute & Verify
      await expect(
        addRecipeLine(mockVenueId, mockProductId, {
          rawMaterialId: 'raw-inactive',
          quantity: 1,
          unit: 'KILOGRAM',
        }),
      ).rejects.toThrow(AppError)

      await expect(
        addRecipeLine(mockVenueId, mockProductId, {
          rawMaterialId: 'raw-inactive',
          quantity: 1,
          unit: 'KILOGRAM',
        }),
      ).rejects.toThrow(/inactive.*deleted.*not found/i)
    })
  })

  describe('REGRESSION TESTS - Existing functionality', () => {
    it('should still create recipe with empty lines successfully', async () => {
      // This tests that we didn't break recipes with no ingredients (edge case)
      const mockProduct = {
        id: mockProductId,
        venueId: mockVenueId,
        name: 'Producto',
      }

      const mockRecipe = {
        id: 'recipe-1',
        productId: mockProductId,
        portionYield: 2,
        totalCost: new Decimal(0),
        lines: [],
      }

      ;(prisma.product.findFirst as jest.Mock).mockResolvedValue(mockProduct)
      ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue(null)
      ;(prisma.rawMaterial.findMany as jest.Mock).mockResolvedValue([]) // Returns empty array for empty lines
      ;(prisma.recipe.create as jest.Mock).mockResolvedValue(mockRecipe)

      // Execute - empty lines array
      const result = await createRecipe(mockVenueId, mockProductId, {
        portionYield: 2,
        lines: [], // Empty lines - validation runs but with empty array
        prepTime: 10,
        cookTime: 15,
      })

      // Verify - should succeed
      expect(result).toEqual(mockRecipe)
      // Validation was called but with empty ID array
      expect(prisma.rawMaterial.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: [] },
          venueId: mockVenueId,
          active: true,
          deletedAt: null,
        },
      })
    })

    it('should still allow updating recipe metadata without touching lines', async () => {
      const mockExistingRecipe = {
        id: 'recipe-1',
        productId: mockProductId,
        portionYield: 1,
        totalCost: new Decimal(5),
        product: { venueId: mockVenueId },
      }

      const mockUpdatedRecipe = {
        ...mockExistingRecipe,
        prepTime: 20,
        lines: [],
      }

      ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue(mockExistingRecipe)
      ;(prisma.recipe.update as jest.Mock).mockResolvedValue(mockUpdatedRecipe)

      // Execute - no lines update
      const result = await updateRecipe(mockVenueId, mockProductId, {
        prepTime: 20,
      })

      // Verify - should succeed without validation
      expect(result).toEqual(mockUpdatedRecipe)
      expect(prisma.rawMaterial.findMany).not.toHaveBeenCalled()
    })
  })
})
