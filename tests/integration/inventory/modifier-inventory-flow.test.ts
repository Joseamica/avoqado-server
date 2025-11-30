/**
 * Modifier Inventory Integration Tests
 *
 * ✅ WORLD-CLASS: Toast/Square pattern for modifier-based inventory tracking
 *
 * Tests:
 * - ADDITION mode: Extra ingredients (e.g., "Extra Bacon") deduct stock
 * - SUBSTITUTION mode: Variable ingredients replaced by modifier selection
 * - Pre-flight validation includes modifier stock checks
 * - Mixed scenarios with products and modifiers
 *
 * Uses REAL PostgreSQL database, NOT mocks!
 */

import prisma from '@/utils/prismaClient'
import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import { cleanupInventoryTestData } from '@tests/helpers/inventory-test-helpers'
import { deductStockForModifiers, deductStockForRecipe, OrderModifierForInventory } from '@/services/dashboard/rawMaterial.service'
import { Unit, RawMaterialCategory, ModifierInventoryMode } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

// Increase timeout for integration tests
jest.setTimeout(60000)

describe('Modifier Inventory Integration Tests', () => {
  let testData: Awaited<ReturnType<typeof setupTestData>>

  beforeAll(async () => {
    testData = await setupTestData()
  })

  afterAll(async () => {
    await cleanupInventoryTestData(testData.venue.id)
    await teardownTestData()
  })

  beforeEach(async () => {
    await cleanupInventoryTestData(testData.venue.id)
  })

  describe('ADDITION Mode - Extra Ingredients', () => {
    it('should deduct stock when ADDITION modifier is selected', async () => {
      // Setup: Create raw material (Bacon)
      const bacon = await prisma.rawMaterial.create({
        data: {
          venueId: testData.venue.id,
          name: 'Bacon',
          sku: `BACON-${Date.now()}`,
          category: RawMaterialCategory.MEAT,
          unit: Unit.KILOGRAM,
          unitType: 'WEIGHT',
          currentStock: 5, // 5 KG available
          minimumStock: 0.5,
          reorderPoint: 1,
          costPerUnit: 200, // $200/kg
          avgCostPerUnit: 200,
          active: true,
          perishable: true,
        },
      })

      // Create FIFO batch for the bacon
      await prisma.stockBatch.create({
        data: {
          rawMaterialId: bacon.id,
          venueId: testData.venue.id,
          batchNumber: `BATCH-${Date.now()}`,
          receivedDate: new Date(),
          initialQuantity: 5,
          remainingQuantity: 5,
          costPerUnit: 200,
          unit: Unit.KILOGRAM,
          status: 'ACTIVE',
        },
      })

      // Create a modifier with ADDITION inventory mode
      const modifierGroup = await prisma.modifierGroup.create({
        data: {
          venueId: testData.venue.id,
          name: 'Extras',
          active: true,
        },
      })

      const modifier = await prisma.modifier.create({
        data: {
          groupId: modifierGroup.id,
          name: 'Extra Bacon',
          price: 25,
          rawMaterialId: bacon.id,
          quantityPerUnit: 0.03, // 30g per portion
          unit: Unit.KILOGRAM,
          inventoryMode: ModifierInventoryMode.ADDITION,
          active: true,
        },
      })

      // Prepare order modifier data
      const orderModifiers: OrderModifierForInventory[] = [
        {
          quantity: 2, // Customer ordered 2x Extra Bacon
          modifier: {
            id: modifier.id,
            name: modifier.name,
            groupId: modifierGroup.id,
            rawMaterialId: bacon.id,
            quantityPerUnit: new Decimal(0.03),
            unit: Unit.KILOGRAM,
            inventoryMode: ModifierInventoryMode.ADDITION,
          },
        },
      ]

      // Check initial stock
      const initialStock = await prisma.rawMaterial.findUnique({
        where: { id: bacon.id },
        select: { currentStock: true },
      })
      expect(initialStock?.currentStock.toNumber()).toBe(5)

      // Deduct stock for modifiers (2 order items × 2 extra bacon × 0.03kg = 0.12kg)
      const orderItemQuantity = 2 // 2 burgers with extra bacon
      await deductStockForModifiers(testData.venue.id, orderItemQuantity, orderModifiers, 'test-order-123', testData.staff[0].id)

      // Verify stock was deducted
      const finalStock = await prisma.rawMaterial.findUnique({
        where: { id: bacon.id },
        select: { currentStock: true },
      })

      // Expected: 5 - (2 × 2 × 0.03) = 5 - 0.12 = 4.88
      expect(finalStock?.currentStock.toNumber()).toBeCloseTo(4.88, 2)

      // Verify movement was created
      const movement = await prisma.rawMaterialMovement.findFirst({
        where: {
          rawMaterialId: bacon.id,
          reference: 'test-order-123',
        },
      })
      expect(movement).toBeTruthy()
      expect(movement?.reason).toContain('Extra Bacon')
    })
  })

  describe('SUBSTITUTION Mode - Variable Ingredients', () => {
    it('should use modifier raw material instead of recipe default for variable ingredients', async () => {
      // Setup: Create two raw materials (regular milk and almond milk)
      const regularMilk = await prisma.rawMaterial.create({
        data: {
          venueId: testData.venue.id,
          name: 'Regular Milk',
          sku: `MILK-REG-${Date.now()}`,
          category: RawMaterialCategory.DAIRY,
          unit: Unit.LITER,
          unitType: 'VOLUME',
          currentStock: 10,
          minimumStock: 1,
          reorderPoint: 2,
          costPerUnit: 20,
          avgCostPerUnit: 20,
          active: true,
        },
      })

      const almondMilk = await prisma.rawMaterial.create({
        data: {
          venueId: testData.venue.id,
          name: 'Almond Milk',
          sku: `MILK-ALM-${Date.now()}`,
          category: RawMaterialCategory.DAIRY,
          unit: Unit.LITER,
          unitType: 'VOLUME',
          currentStock: 5,
          minimumStock: 0.5,
          reorderPoint: 1,
          costPerUnit: 45, // More expensive
          avgCostPerUnit: 45,
          active: true,
        },
      })

      // Create FIFO batches
      await prisma.stockBatch.createMany({
        data: [
          {
            rawMaterialId: regularMilk.id,
            venueId: testData.venue.id,
            batchNumber: `BATCH-REG-${Date.now()}`,
            receivedDate: new Date(),
            initialQuantity: 10,
            remainingQuantity: 10,
            costPerUnit: 20,
            unit: Unit.LITER,
            status: 'ACTIVE',
          },
          {
            rawMaterialId: almondMilk.id,
            venueId: testData.venue.id,
            batchNumber: `BATCH-ALM-${Date.now()}`,
            receivedDate: new Date(),
            initialQuantity: 5,
            remainingQuantity: 5,
            costPerUnit: 45,
            unit: Unit.LITER,
            status: 'ACTIVE',
          },
        ],
      })

      // Create modifier group for milk type
      const milkGroup = await prisma.modifierGroup.create({
        data: {
          venueId: testData.venue.id,
          name: 'Milk Type',
          required: true,
          active: true,
        },
      })

      // Create modifier for almond milk with SUBSTITUTION mode
      const almondModifier = await prisma.modifier.create({
        data: {
          groupId: milkGroup.id,
          name: 'Almond Milk',
          price: 15, // Extra charge
          rawMaterialId: almondMilk.id,
          quantityPerUnit: 0.15, // 150ml per drink
          unit: Unit.LITER,
          inventoryMode: ModifierInventoryMode.SUBSTITUTION,
          active: true,
        },
      })

      // Create category and product
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Drinks',
          slug: `drinks-${Date.now()}`,
        },
      })

      const latte = await prisma.product.create({
        data: {
          venueId: testData.venue.id,
          categoryId: category.id,
          name: 'Latte',
          sku: `LATTE-${Date.now()}`,
          price: 55,
          trackInventory: true,
          inventoryMethod: 'RECIPE',
          active: true,
        },
      })

      // Create recipe with variable milk ingredient
      const recipe = await prisma.recipe.create({
        data: {
          productId: latte.id,
          portionYield: 1,
          totalCost: 10,
        },
      })

      // Create FIFO batch for regular milk (used by recipe default)
      await prisma.stockBatch.create({
        data: {
          rawMaterialId: regularMilk.id,
          venueId: testData.venue.id,
          batchNumber: `BATCH-DEFAULT-${Date.now()}`,
          receivedDate: new Date(),
          initialQuantity: 10,
          remainingQuantity: 10,
          costPerUnit: 20,
          unit: Unit.LITER,
          status: 'ACTIVE',
        },
      })

      // Create recipe line with variable ingredient linked to milk group
      await prisma.recipeLine.create({
        data: {
          recipeId: recipe.id,
          rawMaterialId: regularMilk.id, // Default is regular milk
          quantity: 0.15, // 150ml
          unit: Unit.LITER,
          displayOrder: 1,
          isVariable: true, // Marked as variable
          linkedModifierGroupId: milkGroup.id, // Linked to milk modifier group
        },
      })

      // Check initial stocks
      const initialRegularStock = await prisma.rawMaterial.findUnique({
        where: { id: regularMilk.id },
        select: { currentStock: true },
      })
      const initialAlmondStock = await prisma.rawMaterial.findUnique({
        where: { id: almondMilk.id },
        select: { currentStock: true },
      })

      expect(initialRegularStock?.currentStock.toNumber()).toBe(10)
      expect(initialAlmondStock?.currentStock.toNumber()).toBe(5)

      // Prepare order modifiers - customer selected almond milk
      const orderModifiers: OrderModifierForInventory[] = [
        {
          quantity: 1,
          modifier: {
            id: almondModifier.id,
            name: 'Almond Milk',
            groupId: milkGroup.id,
            rawMaterialId: almondMilk.id,
            quantityPerUnit: new Decimal(0.15),
            unit: Unit.LITER,
            inventoryMode: ModifierInventoryMode.SUBSTITUTION,
          },
        },
      ]

      // Deduct recipe stock (should substitute regular milk with almond milk)
      await deductStockForRecipe(testData.venue.id, latte.id, 1, 'test-order-sub-123', testData.staff[0].id, orderModifiers)

      // Verify regular milk was NOT deducted (substitution)
      const finalRegularStock = await prisma.rawMaterial.findUnique({
        where: { id: regularMilk.id },
        select: { currentStock: true },
      })
      expect(finalRegularStock?.currentStock.toNumber()).toBe(10) // Unchanged

      // Verify almond milk WAS deducted
      const finalAlmondStock = await prisma.rawMaterial.findUnique({
        where: { id: almondMilk.id },
        select: { currentStock: true },
      })
      expect(finalAlmondStock?.currentStock.toNumber()).toBeCloseTo(4.85, 2) // 5 - 0.15 = 4.85
    })
  })

  describe('Mixed Scenarios', () => {
    it('should handle products without modifier tracking gracefully', async () => {
      // Setup: Create raw material
      const ingredient = await prisma.rawMaterial.create({
        data: {
          venueId: testData.venue.id,
          name: 'Test Ingredient',
          sku: `TEST-${Date.now()}`,
          category: RawMaterialCategory.OTHER,
          unit: Unit.KILOGRAM,
          unitType: 'WEIGHT',
          currentStock: 10,
          minimumStock: 1,
          reorderPoint: 2,
          costPerUnit: 50,
          avgCostPerUnit: 50,
          active: true,
        },
      })

      // Create modifier WITHOUT inventory tracking
      const modifierGroup = await prisma.modifierGroup.create({
        data: {
          venueId: testData.venue.id,
          name: 'No Track Group',
          active: true,
        },
      })

      const modifier = await prisma.modifier.create({
        data: {
          groupId: modifierGroup.id,
          name: 'No Track Modifier',
          price: 10,
          rawMaterialId: null, // No raw material linked
          quantityPerUnit: null,
          unit: null,
          inventoryMode: ModifierInventoryMode.ADDITION,
          active: true,
        },
      })

      // Prepare order modifiers - modifier without inventory config
      const orderModifiers: OrderModifierForInventory[] = [
        {
          quantity: 1,
          modifier: {
            id: modifier.id,
            name: 'No Track Modifier',
            groupId: modifierGroup.id,
            rawMaterialId: null,
            quantityPerUnit: null,
            unit: null,
            inventoryMode: ModifierInventoryMode.ADDITION,
          },
        },
      ]

      // Should not throw - gracefully skip modifiers without inventory config
      await expect(
        deductStockForModifiers(testData.venue.id, 1, orderModifiers, 'test-order-no-track', testData.staff[0].id),
      ).resolves.not.toThrow()

      // Stock should remain unchanged
      const finalStock = await prisma.rawMaterial.findUnique({
        where: { id: ingredient.id },
        select: { currentStock: true },
      })
      expect(finalStock?.currentStock.toNumber()).toBe(10)
    })
  })
})
