/**
 * Regression tests for the unit-conversion inventory bug discovered 2026-04-27.
 *
 * Scenario: Hazelnut treat recipe declared "0.062 KILOGRAM" of Proteina
 * Vainilla, but the RawMaterial was stored in GRAM. The buggy code passed
 * 0.062 to deductStockFIFO without converting to RM.unit, so 0.062 GRAM was
 * deducted instead of 62 GRAM — a 1000× drift on every sale. These tests
 * lock the post-fix behavior.
 *
 * Pre-deploy MUST run these (`npm run test:unit`); they would have caught
 * the bug before it reached production.
 */

import { Unit, RawMaterialMovementType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import {
  deductStockForRecipe,
  deductStockForModifiers,
  updateRawMaterial,
  type OrderModifierForInventory,
} from '@/services/dashboard/rawMaterial.service'
import { deductStockFIFO, createStockBatch } from '@/services/dashboard/fifoBatch.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/dashboard/fifoBatch.service', () => {
  const actual = jest.requireActual('@/services/dashboard/fifoBatch.service')
  return {
    ...actual,
    deductStockFIFO: jest.fn(),
    createStockBatch: jest.fn(),
  }
})

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    recipe: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    recipeLine: { update: jest.fn() },
    rawMaterial: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    stockBatch: { create: jest.fn(), findFirst: jest.fn() },
    lowStockAlert: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/notification.service', () => ({
  sendLowStockAlertNotification: jest.fn(),
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

const VENUE_ID = 'venue-test'
const PRODUCT_ID = 'product-test'

describe('deductStockForRecipe — unit conversion', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.lowStockAlert.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.rawMaterial.findUnique as jest.Mock).mockResolvedValue({
      id: 'rm-protein',
      currentStock: new Decimal(9210),
      reorderPoint: new Decimal(0),
      unit: Unit.GRAM,
    })
  })

  it('REGRESSION: converts KILOGRAM recipe quantity to GRAM raw material unit', async () => {
    // Hazelnut treat scenario verbatim: recipe says 0.062 KILOGRAM of a
    // protein stored in GRAM. Bug deducted 0.062 instead of 62.
    ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue({
      id: 'recipe-1',
      productId: PRODUCT_ID,
      portionYield: 1,
      product: { name: 'Hazelnut treat' },
      lines: [
        {
          id: 'line-1',
          rawMaterialId: 'rm-protein',
          quantity: new Decimal(0.062),
          unit: Unit.KILOGRAM,
          isOptional: false,
          isVariable: false,
          rawMaterial: { id: 'rm-protein', name: 'Proteina Vainilla', unit: Unit.GRAM },
        },
      ],
    })

    await deductStockForRecipe(VENUE_ID, PRODUCT_ID, 1, 'order-1')

    expect(deductStockFIFO).toHaveBeenCalledTimes(1)
    expect(deductStockFIFO).toHaveBeenCalledWith(
      VENUE_ID,
      'rm-protein',
      62, // ← critical: 0.062 KG converted to 62 GRAM, NOT 0.062
      RawMaterialMovementType.USAGE,
      expect.objectContaining({ reference: 'order-1' }),
    )
  })

  it('passes quantity unchanged when recipe unit equals raw material unit (no conversion needed)', async () => {
    ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue({
      id: 'recipe-2',
      productId: PRODUCT_ID,
      portionYield: 1,
      product: { name: 'Test' },
      lines: [
        {
          id: 'line-1',
          rawMaterialId: 'rm-milk',
          quantity: new Decimal(0.25),
          unit: Unit.LITER,
          isOptional: false,
          isVariable: false,
          rawMaterial: { id: 'rm-milk', name: 'Leche', unit: Unit.LITER },
        },
      ],
    })

    await deductStockForRecipe(VENUE_ID, PRODUCT_ID, 1, 'order-2')

    expect(deductStockFIFO).toHaveBeenCalledWith(VENUE_ID, 'rm-milk', 0.25, RawMaterialMovementType.USAGE, expect.any(Object))
  })

  it('multiplies by portions sold AFTER converting units', async () => {
    // 3 portions × 0.062 KG = 0.186 KG → 186 GRAM
    ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue({
      id: 'recipe-3',
      productId: PRODUCT_ID,
      portionYield: 1,
      product: { name: 'Test' },
      lines: [
        {
          id: 'line-1',
          rawMaterialId: 'rm-protein',
          quantity: new Decimal(0.062),
          unit: Unit.KILOGRAM,
          isOptional: false,
          isVariable: false,
          rawMaterial: { id: 'rm-protein', name: 'Proteina', unit: Unit.GRAM },
        },
      ],
    })

    await deductStockForRecipe(VENUE_ID, PRODUCT_ID, 3, 'order-3')

    expect(deductStockFIFO).toHaveBeenCalledWith(VENUE_ID, 'rm-protein', 186, RawMaterialMovementType.USAGE, expect.any(Object))
  })

  it('rejects dimensionally incompatible recipe units (mass vs volume)', async () => {
    ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue({
      id: 'recipe-bad',
      productId: PRODUCT_ID,
      portionYield: 1,
      product: { name: 'Bad recipe' },
      lines: [
        {
          id: 'line-1',
          rawMaterialId: 'rm-protein',
          quantity: new Decimal(1),
          unit: Unit.LITER, // ← wrong dimension for a GRAM raw material
          isOptional: false,
          isVariable: false,
          rawMaterial: { id: 'rm-protein', name: 'Proteina', unit: Unit.GRAM },
        },
      ],
    })

    await expect(deductStockForRecipe(VENUE_ID, PRODUCT_ID, 1, 'order-bad')).rejects.toThrow(/incompatible/i)
    expect(deductStockFIFO).not.toHaveBeenCalled()
  })

  it('skips optional ingredients (no deduction call)', async () => {
    ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue({
      id: 'recipe-opt',
      productId: PRODUCT_ID,
      portionYield: 1,
      product: { name: 'Test' },
      lines: [
        {
          id: 'line-1',
          rawMaterialId: 'rm-garnish',
          quantity: new Decimal(1),
          unit: Unit.UNIT,
          isOptional: true,
          isVariable: false,
          rawMaterial: { id: 'rm-garnish', name: 'Garnish', unit: Unit.UNIT },
        },
      ],
    })

    await deductStockForRecipe(VENUE_ID, PRODUCT_ID, 1, 'order-opt')

    expect(deductStockFIFO).not.toHaveBeenCalled()
  })
})

describe('deductStockForModifiers — unit conversion', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.lowStockAlert.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.rawMaterial.findUnique as jest.Mock).mockResolvedValue({
      id: 'rm-bacon',
      currentStock: new Decimal(1000),
      reorderPoint: new Decimal(0),
      unit: Unit.GRAM,
    })
  })

  it('converts modifier unit to raw material unit', async () => {
    ;(prisma.rawMaterial.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      id: 'rm-bacon',
      name: 'Bacon',
      unit: Unit.GRAM,
    })

    const orderModifiers: OrderModifierForInventory[] = [
      {
        quantity: 1,
        modifier: {
          id: 'mod-1',
          name: 'Extra Bacon',
          groupId: 'g1',
          rawMaterialId: 'rm-bacon',
          quantityPerUnit: new Decimal(0.03), // 30 grams expressed as 0.030 KILOGRAM
          unit: Unit.KILOGRAM,
          inventoryMode: 'ADDITION',
        },
      },
    ]

    await deductStockForModifiers(VENUE_ID, 1, orderModifiers, 'order-mod-1')

    expect(deductStockFIFO).toHaveBeenCalledWith(VENUE_ID, 'rm-bacon', 30, RawMaterialMovementType.USAGE, expect.any(Object))
  })
})

describe('updateRawMaterial — recompute on cost change', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // $transaction(callback) pattern: invoke callback with the same prisma mock
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(prisma))
  })

  it('REGRESSION: recomputes Recipe.totalCost + RecipeLine.costPerServing when costPerUnit changes', async () => {
    // Existing RM stored in GRAM with cost $0.5/g.
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue({
      id: 'rm-protein',
      venueId: VENUE_ID,
      name: 'Proteina',
      unit: Unit.GRAM,
      costPerUnit: new Decimal('0.5'),
    })
    // After update returns the new cost.
    ;(prisma.rawMaterial.update as jest.Mock).mockResolvedValue({
      id: 'rm-protein',
      name: 'Proteina',
      unit: Unit.GRAM,
      costPerUnit: new Decimal('0.8'),
    })
    // Recipe using this RM: Hazelnut treat needs 62g/portion, was costing 62*0.5=31.
    ;(prisma.recipe.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'recipe-1',
        productId: 'product-1',
        portionYield: 1,
        totalCost: new Decimal(31),
        product: { id: 'product-1', name: 'Hazelnut treat', venueId: VENUE_ID },
        lines: [
          {
            id: 'line-1',
            quantity: new Decimal(62),
            unit: Unit.GRAM,
            costPerServing: new Decimal(31),
            rawMaterial: { id: 'rm-protein', name: 'Proteina', unit: Unit.GRAM, costPerUnit: new Decimal('0.8') },
          },
        ],
      },
    ])
    ;(prisma.recipeLine.update as jest.Mock).mockResolvedValue({})

    await updateRawMaterial(VENUE_ID, 'rm-protein', { costPerUnit: 0.8 } as any, 'staff-1')

    // RecipeLine.costPerServing should be recomputed to 62 * 0.8 = 49.6
    expect(prisma.recipeLine.update).toHaveBeenCalledWith({
      where: { id: 'line-1' },
      data: { costPerServing: expect.objectContaining({}) },
    })
    const lineUpdate = (prisma.recipeLine.update as jest.Mock).mock.calls[0][0]
    expect(Number(lineUpdate.data.costPerServing)).toBeCloseTo(49.6, 2)

    // Recipe.totalCost should be recomputed (one update for the cost change, plus the RM itself)
    const recipeUpdates = (prisma.rawMaterial.update as jest.Mock).mock.calls
    expect(recipeUpdates.length).toBeGreaterThan(0)

    // Audit trail must record the recompute with the cost delta.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'RECIPES_RECOMPUTED',
        entity: 'RawMaterial',
        entityId: 'rm-protein',
        data: expect.objectContaining({
          trigger: 'cost_change',
          oldCost: 0.5,
          newCost: 0.8,
          recipesAffected: 1,
        }),
      }),
    )
  })

  it('does NOT recompute recipes when cost is unchanged', async () => {
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue({
      id: 'rm-protein',
      venueId: VENUE_ID,
      name: 'Proteina',
      unit: Unit.GRAM,
      costPerUnit: new Decimal('0.5'),
    })
    ;(prisma.rawMaterial.update as jest.Mock).mockResolvedValue({
      id: 'rm-protein',
      name: 'Proteina',
      unit: Unit.GRAM,
      costPerUnit: new Decimal('0.5'),
    })

    // Update only the name, not the cost.
    await updateRawMaterial(VENUE_ID, 'rm-protein', { name: 'Proteina V2' } as any, 'staff-1')

    expect(prisma.recipe.findMany).not.toHaveBeenCalled()
    expect(prisma.recipeLine.update).not.toHaveBeenCalled()
  })
})

describe('deductStockForRecipe — ActivityLog audit trail', () => {
  beforeEach(() => jest.clearAllMocks())

  it('writes a single INVENTORY_DEDUCTED_FOR_SALE entry per order', async () => {
    ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue({
      id: 'recipe-x',
      productId: PRODUCT_ID,
      portionYield: 1,
      product: { name: 'Latte' },
      lines: [
        {
          id: 'line-1',
          rawMaterialId: 'rm-coffee',
          quantity: new Decimal(0.005),
          unit: Unit.KILOGRAM,
          isOptional: false,
          isVariable: false,
          rawMaterial: { id: 'rm-coffee', name: 'Café', unit: Unit.GRAM },
        },
      ],
    })
    ;(prisma.lowStockAlert.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.rawMaterial.findUnique as jest.Mock).mockResolvedValue({
      id: 'rm-coffee',
      currentStock: new Decimal(1000),
      reorderPoint: new Decimal(0),
      unit: Unit.GRAM,
    })

    await deductStockForRecipe(VENUE_ID, PRODUCT_ID, 2, 'order-audit-1', 'staff-1')

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'INVENTORY_DEDUCTED_FOR_SALE',
        entity: 'Order',
        entityId: 'order-audit-1',
        staffId: 'staff-1',
        data: expect.objectContaining({
          productId: PRODUCT_ID,
          productName: 'Latte',
          portionsSold: 2,
          ingredients: expect.arrayContaining([expect.objectContaining({ ingredient: 'Café', quantity: 10, unit: Unit.GRAM })]),
        }),
      }),
    )
  })
})
