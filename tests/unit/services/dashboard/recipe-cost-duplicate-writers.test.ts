import { Unit } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { addRecipeLine, createRecipe, updateRecipe } from '@/services/dashboard/recipe.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    recipe: { findFirst: jest.fn(), update: jest.fn() },
    recipeLine: { create: jest.fn(), update: jest.fn() },
    rawMaterial: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/dashboard/recipe-cost-graph-lock', () => ({
  acquireRecipeCostGraphVenueLockV1: jest.fn(),
  lockRecipeCostGraphRowsV1: jest.fn().mockResolvedValue(true),
  lockRecipeCostProductForUpdateV1: jest.fn().mockResolvedValue(true),
  lockRecipeCostRawMaterialsForShareV1: jest.fn().mockImplementation(async (_tx, _venue, ids) => ids),
}))

const duplicateLines = [
  { rawMaterialId: 'raw-1', quantity: 1, unit: Unit.GRAM, isOptional: false },
  { rawMaterialId: 'raw-1', quantity: 2, unit: Unit.GRAM, isOptional: false },
]

describe('recipe graph writers — duplicate ingredient boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async callback => callback(prisma))
  })

  it.each([
    ['create', () => createRecipe('venue-1', 'product-1', { portionYield: 1, lines: duplicateLines } as any)],
    ['full update', () => updateRecipe('venue-1', 'product-1', { lines: duplicateLines } as any)],
  ])('rejects duplicate RMs before any %s transaction or write', async (_label, mutate) => {
    await expect(mutate()).rejects.toMatchObject({ statusCode: 400, code: 'RECIPE_DUPLICATE_INGREDIENT' })

    // WHY: The service boundary owns this validation so Prisma P2002 never
    // becomes a 500 and an update never deletes the old graph first.
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.recipe.update).not.toHaveBeenCalled()
    expect(prisma.recipeLine.create).not.toHaveBeenCalled()
  })

  it('rejects add-line when the locked graph already contains that RM', async () => {
    const graph = {
      id: 'recipe-1',
      productId: 'product-1',
      portionYield: 1,
      totalCost: new Decimal('1'),
      product: { id: 'product-1', venueId: 'venue-1' },
      lines: [
        {
          id: 'line-1',
          rawMaterialId: 'raw-1',
          displayOrder: 0,
          quantity: new Decimal('1'),
          unit: Unit.GRAM,
          costPerServing: new Decimal('1'),
          rawMaterial: { id: 'raw-1', venueId: 'venue-1', name: 'Flour', unit: Unit.GRAM, costPerUnit: new Decimal('1') },
        },
      ],
    }
    ;(prisma.recipe.findFirst as jest.Mock).mockImplementation(async ({ select }: any) => (select ? { id: graph.id } : graph))

    await expect(addRecipeLine('venue-1', 'product-1', { rawMaterialId: 'raw-1', quantity: 2, unit: Unit.GRAM })).rejects.toMatchObject({
      statusCode: 400,
      code: 'RECIPE_DUPLICATE_INGREDIENT',
    })

    expect(prisma.rawMaterial.findFirst).not.toHaveBeenCalled()
    expect(prisma.recipeLine.create).not.toHaveBeenCalled()
    expect(prisma.recipe.update).not.toHaveBeenCalled()
  })
})
