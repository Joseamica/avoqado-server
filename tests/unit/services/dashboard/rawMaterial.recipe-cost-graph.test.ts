import { Unit } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { updateRawMaterial } from '@/services/dashboard/rawMaterial.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { acquireRecipeCostGraphVenueLockV1, lockRecipeCostGraphsForRawMaterialUpdateV1 } from '@/services/dashboard/recipe-cost-graph-lock'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    recipe: { findMany: jest.fn(), update: jest.fn() },
    recipeLine: { update: jest.fn() },
    rawMaterial: { findFirst: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/fifoBatch.service', () => ({
  createStockBatch: jest.fn(),
  deductStockFIFO: jest.fn(),
}))

jest.mock('@/services/dashboard/notification.service', () => ({ sendLowStockAlertNotification: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/dashboard/recipe-cost-graph-lock', () => ({
  acquireRecipeCostGraphVenueLockV1: jest.fn(),
  lockRecipeCostGraphsForRawMaterialUpdateV1: jest.fn(),
}))

const VENUE_ID = 'venue-test'

function rawMaterial(unit: Unit, cost = '0.5') {
  return { id: 'rm-protein', venueId: VENUE_ID, name: 'Proteina', unit, costPerUnit: new Decimal(cost) }
}

function recipeUsing(rawUnit: Unit, lineUnit: Unit, quantity = '1', rawCost = '0.5') {
  return {
    id: 'recipe-1',
    productId: 'product-1',
    portionYield: 1,
    totalCost: new Decimal('31'),
    product: { id: 'product-1', name: 'Hazelnut treat', venueId: VENUE_ID },
    lines: [
      {
        id: 'line-1',
        rawMaterialId: 'rm-protein',
        displayOrder: 0,
        quantity: new Decimal(quantity),
        unit: lineUnit,
        costPerServing: new Decimal('31'),
        rawMaterial: rawMaterial(rawUnit, rawCost),
      },
    ],
  }
}

describe('updateRawMaterial — locked recipe-cost graph', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => callback(prisma))
    ;(lockRecipeCostGraphsForRawMaterialUpdateV1 as jest.Mock).mockImplementation(async (_tx, _venue, recipeIds) => recipeIds)
    ;(prisma.recipeLine.update as jest.Mock).mockResolvedValue({})
    ;(prisma.recipe.update as jest.Mock).mockResolvedValue({})
  })

  it('recomputes aggregate and line costs from the post-lock cost snapshot', async () => {
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(rawMaterial(Unit.GRAM, '0.5'))
    ;(prisma.rawMaterial.update as jest.Mock).mockResolvedValue(rawMaterial(Unit.GRAM, '0.8'))
    ;(prisma.recipe.findMany as jest.Mock).mockResolvedValue([recipeUsing(Unit.GRAM, Unit.GRAM, '62', '0.8')])

    await updateRawMaterial(VENUE_ID, 'rm-protein', { costPerUnit: 0.8 } as any, 'staff-1')

    // WHY: Presence of either cost-or-unit graph input enters the protocol
    // before equality, preventing an outer stale read from skipping recompute.
    expect(acquireRecipeCostGraphVenueLockV1).toHaveBeenCalledWith(prisma, VENUE_ID)
    expect(lockRecipeCostGraphsForRawMaterialUpdateV1).toHaveBeenCalledWith(prisma, VENUE_ID, ['recipe-1'], 'rm-protein')
    expect((acquireRecipeCostGraphVenueLockV1 as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (prisma.rawMaterial.findFirst as jest.Mock).mock.invocationCallOrder[0],
    )
    const lineUpdate = (prisma.recipeLine.update as jest.Mock).mock.calls[0][0]
    expect(new Decimal(lineUpdate.data.costPerServing).toFixed(4)).toBe('49.6000')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'RECIPES_RECOMPUTED',
        data: expect.objectContaining({ trigger: 'raw_material_cost_or_unit_change', oldCost: 0.5, newCost: 0.8 }),
      }),
    )
  })

  it('locks and then skips derived writes when a supplied cost equals the live value', async () => {
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(rawMaterial(Unit.GRAM, '0.5'))
    ;(prisma.rawMaterial.update as jest.Mock).mockResolvedValue(rawMaterial(Unit.GRAM, '0.5'))
    ;(prisma.recipe.findMany as jest.Mock).mockResolvedValue([recipeUsing(Unit.GRAM, Unit.GRAM)])

    await updateRawMaterial(VENUE_ID, 'rm-protein', { costPerUnit: 0.5 } as any, 'staff-1')

    expect(acquireRecipeCostGraphVenueLockV1).toHaveBeenCalled()
    expect(prisma.recipeLine.update).not.toHaveBeenCalled()
    expect(prisma.recipe.update).not.toHaveBeenCalled()
  })

  it('recomputes a compatible GRAM to KILOGRAM unit change atomically', async () => {
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(rawMaterial(Unit.GRAM))
    ;(prisma.rawMaterial.update as jest.Mock).mockResolvedValue(rawMaterial(Unit.KILOGRAM))
    ;(prisma.recipe.findMany as jest.Mock).mockResolvedValue([recipeUsing(Unit.KILOGRAM, Unit.KILOGRAM)])

    await updateRawMaterial(VENUE_ID, 'rm-protein', { unit: Unit.KILOGRAM } as any, 'staff-1')

    expect(acquireRecipeCostGraphVenueLockV1).toHaveBeenCalledWith(prisma, VENUE_ID)
    const lineUpdate = (prisma.recipeLine.update as jest.Mock).mock.calls[0][0]
    expect(new Decimal(lineUpdate.data.costPerServing).toFixed(4)).toBe('0.5000')
  })

  it('rejects an incompatible GRAM to LITER change with no derived writes', async () => {
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(rawMaterial(Unit.GRAM))
    ;(prisma.rawMaterial.update as jest.Mock).mockResolvedValue(rawMaterial(Unit.LITER))
    ;(prisma.recipe.findMany as jest.Mock).mockResolvedValue([recipeUsing(Unit.LITER, Unit.GRAM)])

    await expect(updateRawMaterial(VENUE_ID, 'rm-protein', { unit: Unit.LITER } as any, 'staff-1')).rejects.toMatchObject({
      statusCode: 422,
      code: 'RECIPE_COST_INPUT_INVALID',
    })
    // WHY: The transaction rolls back the RM update; no derived graph write is
    // even attempted after the prospective unit proves incompatible.
    expect(prisma.recipeLine.update).not.toHaveBeenCalled()
    expect(prisma.recipe.update).not.toHaveBeenCalled()
  })

  it('does not take the graph lock for a name-only edit', async () => {
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(rawMaterial(Unit.GRAM))
    ;(prisma.rawMaterial.update as jest.Mock).mockResolvedValue(rawMaterial(Unit.GRAM))

    await updateRawMaterial(VENUE_ID, 'rm-protein', { name: 'Proteina V2' } as any, 'staff-1')

    expect(acquireRecipeCostGraphVenueLockV1).not.toHaveBeenCalled()
    expect(prisma.recipe.findMany).not.toHaveBeenCalled()
  })
})
