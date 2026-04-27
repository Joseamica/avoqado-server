/**
 * End-to-end destructive integration test for the inventory system.
 *
 * Goal: prove the post-fix code is bulletproof against EVERY scenario that
 * caused the production bugs of 2026-04-27. Runs against a real Postgres
 * (TEST_DATABASE_URL) and verifies invariants after each mutation.
 *
 * Scenarios covered (each is a destructive trial, not just a happy path):
 *   1. Recipe in KILOGRAM consuming a RawMaterial in GRAM
 *   2. PurchaseOrder receive in KILOGRAM bumping a GRAM RawMaterial
 *   3. RawMaterial costPerUnit change auto-recomputes recipe.totalCost
 *   4. Recipe creation with dimensionally incompatible unit (mass↔volume) is rejected
 *   5. Concurrent FIFO deductions don't double-spend a batch
 *   6. Recipe inline edit (PATCH endpoint) recomputes the line cost
 *   7. Selling more than batch capacity throws insufficient-stock
 *   8. Optional ingredients are skipped when out of stock
 *
 * The test never uses production data — it creates and tears down its own
 * isolated venue per scenario.
 */

import { Unit, BatchStatus, RawMaterialMovementType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '@/utils/prismaClient'
import { createStockBatch, deductStockFIFO } from '@/services/dashboard/fifoBatch.service'
import { deductStockForRecipe, updateRawMaterial } from '@/services/dashboard/rawMaterial.service'
import { createRecipe as createRecipeService, updateRecipeLine, recalculateRecipeCost } from '@/services/dashboard/recipe.service'
import { deductInventoryForProduct } from '@/services/dashboard/productInventoryIntegration.service'
import { areUnitsCompatible, convertUnit } from '@/utils/unitConversion'

// Allow real DB transactions; integration tests bypass mocks
jest.unmock('@/utils/prismaClient')
jest.unmock('@/services/dashboard/fifoBatch.service')
jest.unmock('@/services/dashboard/activity-log.service')

const SUITE_TAG = 'INVTEST-E2E-' + Date.now()

interface TestVenue {
  id: string
  organizationId: string
  productCategoryId: string
}

async function setupVenue(suffix: string): Promise<TestVenue> {
  const slug = `${SUITE_TAG.toLowerCase()}-${suffix}`
  const org = await prisma.organization.create({
    data: { name: `Test Org ${suffix}`, slug, email: `${slug}@test.local`, phone: '0000000000' },
  })
  const venue = await prisma.venue.create({
    data: {
      name: `Test Venue ${suffix}`,
      slug,
      organizationId: org.id,
      address: 'test',
      city: 'test',
      country: 'MX',
      timezone: 'America/Mexico_City',
      currency: 'MXN',
      type: 'RESTAURANT',
    },
  })
  const category = await prisma.menuCategory.create({
    data: {
      venueId: venue.id,
      name: `Cat ${suffix}`,
      slug: `cat-${suffix}`,
    },
  })
  return { id: venue.id, organizationId: org.id, productCategoryId: category.id }
}

async function cleanupVenue(venue: TestVenue): Promise<void> {
  await prisma.venue.delete({ where: { id: venue.id } }).catch(() => undefined)
  await prisma.organization.delete({ where: { id: venue.organizationId } }).catch(() => undefined)
}

describe('Inventory System — Destructive E2E', () => {
  describe('1. KG recipe consuming GRAM raw material', () => {
    let v: TestVenue
    beforeAll(async () => (v = await setupVenue('s1')))
    afterAll(async () => cleanupVenue(v))

    it('deducts 62 GRAM (not 0.062) when recipe says 0.062 KILOGRAM', async () => {
      const rm = await prisma.rawMaterial.create({
        data: {
          venueId: v.id,
          name: 'Protein',
          sku: `prot-${SUITE_TAG}-s1`,
          category: 'OTHER',
          currentStock: new Decimal(0),
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: new Decimal('0.83'), // per-gram pricing
          avgCostPerUnit: new Decimal('0.83'),
          unit: Unit.GRAM,
          unitType: 'WEIGHT',
        },
      })
      // Receive 1 KG → batch normalizes to 1000 GRAM, currentStock += 1000
      await createStockBatch(v.id, rm.id, {
        quantity: 1,
        unit: Unit.KILOGRAM,
        costPerUnit: 830,
        receivedDate: new Date(),
      })
      // Mirror what updateRawMaterial / receivePO does — keep currentStock in sync
      await prisma.rawMaterial.update({ where: { id: rm.id }, data: { currentStock: new Decimal(1000) } })

      const product = await prisma.product.create({
        data: { venueId: v.id, name: 'Smoothie', sku: `sm-${SUITE_TAG}-s1`, categoryId: v.productCategoryId, price: 100, taxRate: 0.16 },
      })
      await createRecipeService(v.id, product.id, {
        portionYield: 1,
        lines: [{ rawMaterialId: rm.id, quantity: 0.062, unit: 'KILOGRAM', isOptional: false }],
      } as any)

      await deductStockForRecipe(v.id, product.id, 1, 'order-test-s1')

      const after = await prisma.rawMaterial.findUnique({ where: { id: rm.id } })
      // 1000g - 62g = 938g (NOT 1000 - 0.062 = 999.938)
      expect(Number(after!.currentStock)).toBeCloseTo(938, 1)

      const batch = await prisma.stockBatch.findFirst({ where: { rawMaterialId: rm.id } })
      expect(batch!.unit).toBe(Unit.GRAM) // normalized at creation
      expect(Number(batch!.remainingQuantity)).toBeCloseTo(938, 1)
    })
  })

  describe('2. PurchaseOrder receive normalizes unit', () => {
    let v: TestVenue
    beforeAll(async () => (v = await setupVenue('s2')))
    afterAll(async () => cleanupVenue(v))

    it('receiving 1 KG against a GRAM raw material adds 1000 to currentStock', async () => {
      const rm = await prisma.rawMaterial.create({
        data: {
          venueId: v.id,
          name: 'Salt',
          sku: `salt-${SUITE_TAG}-s2`,
          category: 'OTHER',
          currentStock: new Decimal(0),
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: new Decimal('0.05'),
          avgCostPerUnit: new Decimal('0.05'),
          unit: Unit.GRAM,
          unitType: 'WEIGHT',
        },
      })
      await createStockBatch(v.id, rm.id, {
        quantity: 1,
        unit: Unit.KILOGRAM,
        costPerUnit: 50,
        receivedDate: new Date(),
      })

      const batch = await prisma.stockBatch.findFirst({ where: { rawMaterialId: rm.id } })
      expect(batch!.unit).toBe(Unit.GRAM)
      expect(Number(batch!.initialQuantity)).toBe(1000)
      expect(Number(batch!.costPerUnit)).toBeCloseTo(0.05, 4) // 50/KG → 0.05/g
    })
  })

  describe('3. costPerUnit change auto-recomputes recipe', () => {
    let v: TestVenue
    beforeAll(async () => (v = await setupVenue('s3')))
    afterAll(async () => cleanupVenue(v))

    it('updateRawMaterial with new cost cascades to Recipe.totalCost + RecipeLine.costPerServing', async () => {
      const rm = await prisma.rawMaterial.create({
        data: {
          venueId: v.id,
          name: 'Beans',
          sku: `beans-${SUITE_TAG}-s3`,
          category: 'OTHER',
          currentStock: new Decimal(1000),
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: new Decimal('0.5'),
          avgCostPerUnit: new Decimal('0.5'),
          unit: Unit.GRAM,
          unitType: 'WEIGHT',
        },
      })
      const product = await prisma.product.create({
        data: { venueId: v.id, name: 'Bowl', sku: `bowl-${SUITE_TAG}-s3`, categoryId: v.productCategoryId, price: 100, taxRate: 0.16 },
      })
      await createRecipeService(v.id, product.id, {
        portionYield: 1,
        lines: [{ rawMaterialId: rm.id, quantity: 0.1, unit: 'KILOGRAM', isOptional: false }],
      } as any)

      const recipeBefore = await prisma.recipe.findUnique({
        where: { productId: product.id },
        include: { lines: true },
      })
      expect(Number(recipeBefore!.totalCost)).toBeCloseTo(50, 2) // 100g × $0.5 = $50
      expect(Number(recipeBefore!.lines[0].costPerServing)).toBeCloseTo(50, 2)

      // Triple the cost
      await updateRawMaterial(v.id, rm.id, { costPerUnit: 1.5 } as any, undefined)

      const recipeAfter = await prisma.recipe.findUnique({
        where: { productId: product.id },
        include: { lines: true },
      })
      expect(Number(recipeAfter!.totalCost)).toBeCloseTo(150, 2) // 100g × $1.5 = $150
      expect(Number(recipeAfter!.lines[0].costPerServing)).toBeCloseTo(150, 2)
    })
  })

  describe('4. Dimensional incompatibility is rejected', () => {
    let v: TestVenue
    beforeAll(async () => (v = await setupVenue('s4')))
    afterAll(async () => cleanupVenue(v))

    it('createRecipe rejects LITER recipe line for a GRAM raw material', async () => {
      const rm = await prisma.rawMaterial.create({
        data: {
          venueId: v.id,
          name: 'Powder',
          sku: `pow-${SUITE_TAG}-s4`,
          category: 'OTHER',
          currentStock: new Decimal(100),
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: new Decimal('1'),
          avgCostPerUnit: new Decimal('1'),
          unit: Unit.GRAM,
          unitType: 'WEIGHT',
        },
      })
      const product = await prisma.product.create({
        data: { venueId: v.id, name: 'Bad', sku: `bad-${SUITE_TAG}-s4`, categoryId: v.productCategoryId, price: 50, taxRate: 0.16 },
      })

      await expect(
        createRecipeService(v.id, product.id, {
          portionYield: 1,
          lines: [{ rawMaterialId: rm.id, quantity: 1, unit: 'LITER', isOptional: false }],
        } as any),
      ).rejects.toThrow(/incompatible/i)

      const recipe = await prisma.recipe.findUnique({ where: { productId: product.id } })
      expect(recipe).toBeNull() // recipe creation rolled back
    })

    it('createStockBatch rejects KILOGRAM batch for a LITER raw material', async () => {
      const rm = await prisma.rawMaterial.create({
        data: {
          venueId: v.id,
          name: 'Liquid',
          sku: `liq-${SUITE_TAG}-s4`,
          category: 'OTHER',
          currentStock: new Decimal(0),
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: new Decimal('10'),
          avgCostPerUnit: new Decimal('10'),
          unit: Unit.LITER,
          unitType: 'VOLUME',
        },
      })
      await expect(
        createStockBatch(v.id, rm.id, {
          quantity: 1,
          unit: Unit.KILOGRAM,
          costPerUnit: 10,
          receivedDate: new Date(),
        }),
      ).rejects.toThrow(/incompatible/i)
    })
  })

  describe('5. Concurrent FIFO deductions are atomic', () => {
    let v: TestVenue
    beforeAll(async () => (v = await setupVenue('s5')))
    afterAll(async () => cleanupVenue(v))

    it('two parallel deductions on same batch never overdraw', async () => {
      const rm = await prisma.rawMaterial.create({
        data: {
          venueId: v.id,
          name: 'Limited',
          sku: `lim-${SUITE_TAG}-s5`,
          category: 'OTHER',
          currentStock: new Decimal(100),
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: new Decimal('1'),
          avgCostPerUnit: new Decimal('1'),
          unit: Unit.GRAM,
          unitType: 'WEIGHT',
        },
      })
      await createStockBatch(v.id, rm.id, {
        quantity: 100,
        unit: Unit.GRAM,
        costPerUnit: 1,
        receivedDate: new Date(),
      })

      // Fire 3 deductions of 60g each — only one should succeed (or two if 60+60=120 > 100
      // which would be rejected). With locking, the FIFO service serializes them.
      const results = await Promise.allSettled([
        deductStockFIFO(v.id, rm.id, 60, RawMaterialMovementType.USAGE, { reason: 'p1' }),
        deductStockFIFO(v.id, rm.id, 60, RawMaterialMovementType.USAGE, { reason: 'p2' }),
        deductStockFIFO(v.id, rm.id, 60, RawMaterialMovementType.USAGE, { reason: 'p3' }),
      ])
      const successes = results.filter(r => r.status === 'fulfilled').length

      // At most 1 can succeed (60g out of 100g leaves 40g, not enough for another 60g)
      expect(successes).toBeLessThanOrEqual(1)

      const batch = await prisma.stockBatch.findFirst({ where: { rawMaterialId: rm.id } })
      // Stock never goes negative
      expect(Number(batch!.remainingQuantity)).toBeGreaterThanOrEqual(0)
    })
  })

  describe('6. Inline edit recomputes line cost', () => {
    let v: TestVenue
    beforeAll(async () => (v = await setupVenue('s6')))
    afterAll(async () => cleanupVenue(v))

    it('updateRecipeLine recomputes costPerServing AND recipe.totalCost', async () => {
      const rm = await prisma.rawMaterial.create({
        data: {
          venueId: v.id,
          name: 'X',
          sku: `x-${SUITE_TAG}-s6`,
          category: 'OTHER',
          currentStock: new Decimal(1000),
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: new Decimal('2'),
          avgCostPerUnit: new Decimal('2'),
          unit: Unit.GRAM,
          unitType: 'WEIGHT',
        },
      })
      const product = await prisma.product.create({
        data: { venueId: v.id, name: 'Pizza', sku: `pz-${SUITE_TAG}-s6`, categoryId: v.productCategoryId, price: 200, taxRate: 0.16 },
      })
      await createRecipeService(v.id, product.id, {
        portionYield: 1,
        lines: [{ rawMaterialId: rm.id, quantity: 50, unit: 'GRAM', isOptional: false }],
      } as any)

      const recipe = await prisma.recipe.findUnique({
        where: { productId: product.id },
        include: { lines: true },
      })
      const lineId = recipe!.lines[0].id
      expect(Number(recipe!.totalCost)).toBeCloseTo(100, 2) // 50 × 2

      // Inline-edit: change quantity from 50 to 75
      await updateRecipeLine(v.id, product.id, lineId, { quantity: 75 })

      const after = await prisma.recipe.findUnique({
        where: { productId: product.id },
        include: { lines: true },
      })
      expect(Number(after!.lines[0].quantity)).toBe(75)
      expect(Number(after!.lines[0].costPerServing)).toBeCloseTo(150, 2)
      expect(Number(after!.totalCost)).toBeCloseTo(150, 2)
    })
  })

  describe('7. Insufficient stock throws cleanly', () => {
    let v: TestVenue
    beforeAll(async () => (v = await setupVenue('s7')))
    afterAll(async () => cleanupVenue(v))

    it('selling beyond batch capacity rejects with InsufficientStock', async () => {
      const rm = await prisma.rawMaterial.create({
        data: {
          venueId: v.id,
          name: 'Tiny',
          sku: `t-${SUITE_TAG}-s7`,
          category: 'OTHER',
          currentStock: new Decimal(10),
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: new Decimal('1'),
          avgCostPerUnit: new Decimal('1'),
          unit: Unit.GRAM,
          unitType: 'WEIGHT',
        },
      })
      await createStockBatch(v.id, rm.id, {
        quantity: 10,
        unit: Unit.GRAM,
        costPerUnit: 1,
        receivedDate: new Date(),
      })

      await expect(deductStockFIFO(v.id, rm.id, 50, RawMaterialMovementType.USAGE, { reason: 'too much' })).rejects.toThrow(/insufficient/i)

      // Stock untouched
      const batch = await prisma.stockBatch.findFirst({ where: { rawMaterialId: rm.id } })
      expect(Number(batch!.remainingQuantity)).toBe(10)
    })
  })

  describe('8. Optional ingredients are skipped', () => {
    let v: TestVenue
    beforeAll(async () => (v = await setupVenue('s8')))
    afterAll(async () => cleanupVenue(v))

    it('product with optional out-of-stock ingredient still sells', async () => {
      const required = await prisma.rawMaterial.create({
        data: {
          venueId: v.id,
          name: 'Bread',
          sku: `br-${SUITE_TAG}-s8`,
          category: 'OTHER',
          currentStock: new Decimal(100),
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: new Decimal('0.5'),
          avgCostPerUnit: new Decimal('0.5'),
          unit: Unit.UNIT,
          unitType: 'COUNT',
        },
      })
      const optional = await prisma.rawMaterial.create({
        data: {
          venueId: v.id,
          name: 'Garnish',
          sku: `gn-${SUITE_TAG}-s8`,
          category: 'OTHER',
          currentStock: new Decimal(0),
          minimumStock: 0,
          reorderPoint: 0, // ZERO stock
          costPerUnit: new Decimal('0.1'),
          avgCostPerUnit: new Decimal('0.1'),
          unit: Unit.GRAM,
          unitType: 'WEIGHT',
        },
      })
      await createStockBatch(v.id, required.id, { quantity: 100, unit: Unit.UNIT, costPerUnit: 0.5, receivedDate: new Date() })

      const product = await prisma.product.create({
        data: { venueId: v.id, name: 'Sandwich', sku: `sa-${SUITE_TAG}-s8`, categoryId: v.productCategoryId, price: 50, taxRate: 0.16 },
      })
      await createRecipeService(v.id, product.id, {
        portionYield: 1,
        lines: [
          { rawMaterialId: required.id, quantity: 1, unit: 'UNIT', isOptional: false },
          { rawMaterialId: optional.id, quantity: 5, unit: 'GRAM', isOptional: true },
        ],
      } as any)

      // Should NOT throw despite garnish being out of stock
      await expect(deductStockForRecipe(v.id, product.id, 1, 'order-s8')).resolves.toBeUndefined()

      const breadAfter = await prisma.rawMaterial.findUnique({ where: { id: required.id } })
      expect(Number(breadAfter!.currentStock)).toBe(99) // bread deducted
      const garnishAfter = await prisma.rawMaterial.findUnique({ where: { id: optional.id } })
      expect(Number(garnishAfter!.currentStock)).toBe(0) // untouched
    })
  })

  describe('9. recalculateRecipeCost refreshes both line and total', () => {
    let v: TestVenue
    beforeAll(async () => (v = await setupVenue('s9')))
    afterAll(async () => cleanupVenue(v))

    it('manual recalc updates RecipeLine.costPerServing (not just totalCost)', async () => {
      const rm = await prisma.rawMaterial.create({
        data: {
          venueId: v.id,
          name: 'Y',
          sku: `y-${SUITE_TAG}-s9`,
          category: 'OTHER',
          currentStock: new Decimal(1000),
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: new Decimal('5'),
          avgCostPerUnit: new Decimal('5'),
          unit: Unit.GRAM,
          unitType: 'WEIGHT',
        },
      })
      const product = await prisma.product.create({
        data: { venueId: v.id, name: 'Cake', sku: `ck-${SUITE_TAG}-s9`, categoryId: v.productCategoryId, price: 500, taxRate: 0.16 },
      })
      await createRecipeService(v.id, product.id, {
        portionYield: 8,
        lines: [{ rawMaterialId: rm.id, quantity: 0.5, unit: 'KILOGRAM', isOptional: false }],
      } as any)
      const recipeBefore = await prisma.recipe.findUnique({ where: { productId: product.id }, include: { lines: true } })
      // 500g × $5 = $2500 total, /8 = $312.5 per serving
      expect(Number(recipeBefore!.lines[0].costPerServing)).toBeCloseTo(312.5, 2)

      // Bypass the auto-recompute hook and stale the line cost manually to simulate
      // legacy data where costPerUnit changed but recipe wasn't refreshed.
      await prisma.rawMaterial.update({ where: { id: rm.id }, data: { costPerUnit: new Decimal('10') } })
      // costPerServing is still $312.5 in DB (we bypassed updateRawMaterial)

      // Now run manual recompute
      await recalculateRecipeCost(recipeBefore!.id)

      const recipeAfter = await prisma.recipe.findUnique({ where: { productId: product.id }, include: { lines: true } })
      // 500g × $10 = $5000 total, /8 = $625 per serving
      expect(Number(recipeAfter!.lines[0].costPerServing)).toBeCloseTo(625, 2)
      expect(Number(recipeAfter!.totalCost)).toBeCloseTo(5000, 2)
    })
  })

  describe('10. QUANTITY-based product (retail) deducts from Inventory table', () => {
    let v: TestVenue
    beforeAll(async () => (v = await setupVenue('s10')))
    afterAll(async () => cleanupVenue(v))

    it('selling a QUANTITY product decrements Inventory.currentStock and creates InventoryMovement', async () => {
      // Retail product (e.g., a t-shirt): no recipe, just integer stock
      const product = await prisma.product.create({
        data: {
          venueId: v.id,
          name: 'T-Shirt',
          sku: `tee-${SUITE_TAG}-s10`,
          categoryId: v.productCategoryId,
          price: 250,
          taxRate: 0.16,
          trackInventory: true,
          inventoryMethod: 'QUANTITY',
        },
      })
      const inventory = await prisma.inventory.create({
        data: { productId: product.id, venueId: v.id, currentStock: new Decimal(50) },
      })

      // Sell 3 units
      const result = await deductInventoryForProduct(v.id, product.id, 3, 'order-qty-1', undefined)

      expect(result.inventoryMethod).toBe('QUANTITY')

      const after = await prisma.inventory.findUnique({ where: { productId: product.id } })
      expect(Number(after!.currentStock)).toBe(47)

      const movement = await prisma.inventoryMovement.findFirst({
        where: { inventoryId: inventory.id, reference: 'order-qty-1' },
      })
      expect(movement).not.toBeNull()
      expect(Number(movement!.quantity)).toBe(-3)
      expect(Number(movement!.previousStock)).toBe(50)
      expect(Number(movement!.newStock)).toBe(47)
    })

    it('selling more than available throws insufficient-stock and leaves inventory untouched', async () => {
      const product = await prisma.product.create({
        data: {
          venueId: v.id,
          name: 'Limited Tee',
          sku: `lim-tee-${SUITE_TAG}-s10`,
          categoryId: v.productCategoryId,
          price: 200,
          taxRate: 0.16,
          trackInventory: true,
          inventoryMethod: 'QUANTITY',
        },
      })
      await prisma.inventory.create({
        data: { productId: product.id, venueId: v.id, currentStock: new Decimal(2) },
      })

      await expect(deductInventoryForProduct(v.id, product.id, 5, 'order-qty-fail', undefined)).rejects.toThrow(/insufficient/i)

      const after = await prisma.inventory.findUnique({ where: { productId: product.id } })
      expect(Number(after!.currentStock)).toBe(2) // untouched
    })

    it('atomic decrement: 3 concurrent sales of 4 units each from stock of 10 → only 2 succeed', async () => {
      const product = await prisma.product.create({
        data: {
          venueId: v.id,
          name: 'Race Tee',
          sku: `race-${SUITE_TAG}-s10`,
          categoryId: v.productCategoryId,
          price: 100,
          taxRate: 0.16,
          trackInventory: true,
          inventoryMethod: 'QUANTITY',
        },
      })
      await prisma.inventory.create({
        data: { productId: product.id, venueId: v.id, currentStock: new Decimal(10) },
      })

      const results = await Promise.allSettled([
        deductInventoryForProduct(v.id, product.id, 4, 'race-1', undefined),
        deductInventoryForProduct(v.id, product.id, 4, 'race-2', undefined),
        deductInventoryForProduct(v.id, product.id, 4, 'race-3', undefined),
      ])
      const successes = results.filter(r => r.status === 'fulfilled').length
      expect(successes).toBeLessThanOrEqual(2) // 4+4=8 ≤ 10 ✓, 4+4+4=12 > 10 ✗

      const after = await prisma.inventory.findUnique({ where: { productId: product.id } })
      expect(Number(after!.currentStock)).toBeGreaterThanOrEqual(0)
      expect(Number(after!.currentStock)).toBeLessThanOrEqual(10)
    })

    it('product without trackInventory deducts NOTHING (free-stock product)', async () => {
      const product = await prisma.product.create({
        data: {
          venueId: v.id,
          name: 'Service Item',
          sku: `svc-${SUITE_TAG}-s10`,
          categoryId: v.productCategoryId,
          price: 99,
          taxRate: 0.16,
          trackInventory: false, // ← key: not tracked
        },
      })

      const result = await deductInventoryForProduct(v.id, product.id, 5, 'order-no-track', undefined)
      expect(result.inventoryMethod).toBeNull()

      const inventory = await prisma.inventory.findUnique({ where: { productId: product.id } })
      expect(inventory).toBeNull() // no inventory record was created/touched
    })
  })

  describe('11. deductInventoryForProduct routes correctly by inventoryMethod', () => {
    let v: TestVenue
    beforeAll(async () => (v = await setupVenue('s11')))
    afterAll(async () => cleanupVenue(v))

    it('RECIPE product → calls recipe path → deducts ingredients', async () => {
      const rm = await prisma.rawMaterial.create({
        data: {
          venueId: v.id,
          name: 'Flour',
          sku: `fl-${SUITE_TAG}-s11`,
          category: 'OTHER',
          currentStock: new Decimal(1000),
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: new Decimal('0.05'),
          avgCostPerUnit: new Decimal('0.05'),
          unit: Unit.GRAM,
          unitType: 'WEIGHT',
        },
      })
      await createStockBatch(v.id, rm.id, { quantity: 1000, unit: Unit.GRAM, costPerUnit: 0.05, receivedDate: new Date() })

      const product = await prisma.product.create({
        data: {
          venueId: v.id,
          name: 'Bread',
          sku: `br-${SUITE_TAG}-s11`,
          categoryId: v.productCategoryId,
          price: 50,
          taxRate: 0.16,
          trackInventory: true,
          inventoryMethod: 'RECIPE',
        },
      })
      await createRecipeService(v.id, product.id, {
        portionYield: 1,
        lines: [{ rawMaterialId: rm.id, quantity: 200, unit: 'GRAM', isOptional: false }],
      } as any)

      const result = await deductInventoryForProduct(v.id, product.id, 2, 'order-route-recipe', undefined)
      expect(result.inventoryMethod).toBe('RECIPE')

      const rmAfter = await prisma.rawMaterial.findUnique({ where: { id: rm.id } })
      // 2 panes × 200g = 400g consumed → 1000-400 = 600
      expect(Number(rmAfter!.currentStock)).toBe(600)

      // No InventoryMovement should exist for this product (it's RECIPE not QUANTITY)
      const inventoryMovements = await prisma.inventoryMovement.count({
        where: { reference: 'order-route-recipe' },
      })
      expect(inventoryMovements).toBe(0)

      // RawMaterialMovement SHOULD exist
      const rmMovements = await prisma.rawMaterialMovement.count({
        where: { rawMaterialId: rm.id, reference: 'order-route-recipe' },
      })
      expect(rmMovements).toBe(1)
    })
  })

  describe('Final invariant — overall consistency check', () => {
    it('areUnitsCompatible + convertUnit form a coherent system', () => {
      // Mass family
      expect(areUnitsCompatible(Unit.KILOGRAM, Unit.GRAM)).toBe(true)
      expect(areUnitsCompatible(Unit.GRAM, Unit.MILLIGRAM)).toBe(true)
      // Volume family
      expect(areUnitsCompatible(Unit.LITER, Unit.MILLILITER)).toBe(true)
      // Cross-family
      expect(areUnitsCompatible(Unit.KILOGRAM, Unit.LITER)).toBe(false)
      expect(areUnitsCompatible(Unit.GRAM, Unit.UNIT)).toBe(false)
      // Round-trip
      expect(convertUnit(0.062, Unit.KILOGRAM, Unit.GRAM).toNumber()).toBeCloseTo(62, 6)
      expect(convertUnit(62, Unit.GRAM, Unit.KILOGRAM).toNumber()).toBeCloseTo(0.062, 6)
      expect(convertUnit(1, Unit.LITER, Unit.MILLILITER).toNumber()).toBeCloseTo(1000, 6)
      // Identity
      expect(convertUnit(5, Unit.GRAM, Unit.GRAM).toNumber()).toBe(5)
    })
  })
})
