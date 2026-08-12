/**
 * Regression tests for the cost-side unit conversion bugs found in audit
 * (2026-04-27). Two related defects in recipe.service.ts:
 *
 *   - calculateRecipeCost() multiplied line.quantity × rawMaterial.costPerUnit
 *     without converting RecipeLine.unit → RawMaterial.unit. A "0.062 KILOGRAM"
 *     line of a GRAM-stored material returned $0.05 instead of $51.34.
 *
 *   - recalculateRecipeCost() updated Recipe.totalCost but never refreshed the
 *     individual RecipeLine.costPerServing rows, so the dashboard kept showing
 *     stale per-line costs even after a cost recompute was triggered.
 *
 * Both issues silently propagated through:
 *   - costRecalculationTrigger.service.ts (admin "trigger recalc" wizard)
 *   - recipeRecalculation.service.ts (background job)
 *   - chatbot-actions/recipe.actions.ts (AI assistant action)
 */

import { Unit } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { recalculateRecipeCost, updateRecipe } from '@/services/dashboard/recipe.service'
import { acquireRecipeCostGraphVenueLockV1, lockRecipeCostGraphRowsV1 } from '@/services/dashboard/recipe-cost-graph-lock'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    recipe: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    recipeLine: { update: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

jest.mock('@/services/dashboard/recipe-cost-graph-lock', () => ({
  acquireRecipeCostGraphVenueLockV1: jest.fn(),
  lockRecipeCostGraphRowsV1: jest.fn(),
  lockRecipeCostRawMaterialsForShareV1: jest.fn(),
  lockRecipeCostRawMaterialForUpdateV1: jest.fn(),
}))

function mockRecalculationRecipe(row: Record<string, unknown>, venueId = 'venue-1'): void {
  ;(prisma.recipe.findUnique as jest.Mock)
    .mockResolvedValueOnce({ id: row.id, product: { venueId } })
    .mockResolvedValueOnce({ ...row, product: { venueId } })
}

function mockProductRecipeGraph(row: Record<string, unknown>): void {
  ;(prisma.recipe.findFirst as jest.Mock).mockResolvedValueOnce({ id: row.id }).mockResolvedValueOnce(row)
}

describe('recalculateRecipeCost — unit-conversion + per-line refresh', () => {
  beforeEach(() => {
    // WHY: Per-call snapshots model preflight/post-lock rereads; reset removes
    // unused queues from the parameterized update/recalculate cases.
    jest.resetAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(prisma))
    ;(prisma.recipe.update as jest.Mock).mockResolvedValue({ id: 'recipe-1' })
    ;(lockRecipeCostGraphRowsV1 as jest.Mock).mockResolvedValue(true)
  })

  it('REGRESSION: converts KG line quantity to GRAM RM unit when computing total', async () => {
    // Hazelnut treat: 0.062 KG of protein stored in GRAM at $0.83/g.
    // Expected total: 62g × $0.83 = $51.46. Pre-fix returned $0.05.
    mockRecalculationRecipe({
      id: 'recipe-1',
      portionYield: 1,
      lines: [
        {
          id: 'line-1',
          quantity: new Decimal('0.062'),
          unit: Unit.KILOGRAM,
          rawMaterial: { venueId: 'venue-1', unit: Unit.GRAM, costPerUnit: new Decimal('0.83') },
        },
      ],
    })

    await recalculateRecipeCost('recipe-1')

    // Recipe.totalCost
    const recipeUpdateCall = (prisma.recipe.update as jest.Mock).mock.calls[0][0]
    expect(Number(recipeUpdateCall.data.totalCost)).toBeCloseTo(51.46, 2)

    // RecipeLine.costPerServing must be refreshed too (this was missing before)
    expect(prisma.recipeLine.update).toHaveBeenCalledWith({
      where: { id: 'line-1' },
      data: { costPerServing: expect.objectContaining({}) },
    })
    const lineUpdateCall = (prisma.recipeLine.update as jest.Mock).mock.calls[0][0]
    expect(Number(lineUpdateCall.data.costPerServing)).toBeCloseTo(51.46, 2)
  })

  it('divides by portionYield so per-portion cost is correct for batch recipes', async () => {
    // 8 portions per batch: 1 KG of $0.50/g raw material → $500 total → $62.50/portion
    mockRecalculationRecipe({
      id: 'recipe-batch',
      portionYield: 8,
      lines: [
        {
          id: 'line-1',
          quantity: new Decimal('1'),
          unit: Unit.KILOGRAM,
          rawMaterial: { venueId: 'venue-1', unit: Unit.GRAM, costPerUnit: new Decimal('0.5') },
        },
      ],
    })

    await recalculateRecipeCost('recipe-batch')

    // WHY: Recipe.totalCost is the durable H1 source of truth per portion, so a
    // batch yield must divide both the aggregate and every persisted line cost.
    const recipeUpdateCall = (prisma.recipe.update as jest.Mock).mock.calls[0][0]
    expect(new Decimal(recipeUpdateCall.data.totalCost).toFixed(4)).toBe('62.5000')

    const lineUpdateCall = (prisma.recipeLine.update as jest.Mock).mock.calls[0][0]
    expect(Number(lineUpdateCall.data.costPerServing)).toBeCloseTo(62.5, 2) // $500 / 8 portions
  })

  it('passes line.quantity unchanged when units already match', async () => {
    mockRecalculationRecipe({
      id: 'recipe-match',
      portionYield: 1,
      lines: [
        {
          id: 'line-1',
          quantity: new Decimal('0.5'),
          unit: Unit.LITER,
          rawMaterial: { venueId: 'venue-1', unit: Unit.LITER, costPerUnit: new Decimal('20') },
        },
      ],
    })

    await recalculateRecipeCost('recipe-match')

    const recipeUpdateCall = (prisma.recipe.update as jest.Mock).mock.calls[0][0]
    expect(Number(recipeUpdateCall.data.totalCost)).toBeCloseTo(10, 2) // 0.5 L × $20/L
  })

  it('recalculates aggregate and line costs when metadata-only update changes portionYield', async () => {
    mockProductRecipeGraph({
      id: 'recipe-yield-change',
      productId: 'product-1',
      portionYield: 2,
      totalCost: new Decimal('250.0000'),
      prepTime: 10,
      cookTime: null,
      notes: null,
      product: { venueId: 'venue-1' },
      lines: [
        {
          id: 'line-1',
          quantity: new Decimal('1'),
          unit: Unit.KILOGRAM,
          rawMaterial: { venueId: 'venue-1', unit: Unit.GRAM, costPerUnit: new Decimal('0.5') },
        },
      ],
    })

    await updateRecipe('venue-1', 'product-1', { portionYield: 8 } as any)

    // WHY: Changing only yield cannot persist a new denominator beside the old
    // per-portion Recipe/RecipeLine costs; both must use the neutral calculator.
    const recipeUpdateCall = (prisma.recipe.update as jest.Mock).mock.calls[0][0]
    expect(new Decimal(recipeUpdateCall.data.totalCost).toFixed(4)).toBe('62.5000')
    const lineUpdateCall = (prisma.recipeLine.update as jest.Mock).mock.calls[0][0]
    expect(new Decimal(lineUpdateCall.data.costPerServing).toFixed(4)).toBe('62.5000')
  })

  it.each([
    ['metadata-only yield update', () => updateRecipe('venue-1', 'product-empty', { portionYield: 8 } as any)],
    ['explicit recalculation', () => recalculateRecipeCost('recipe-empty')],
  ])('keeps a legacy empty recipe compatible during %s', async (_label, mutate) => {
    const emptyRecipe = {
      id: 'recipe-empty',
      productId: 'product-empty',
      portionYield: 2,
      totalCost: new Decimal('9.0000'),
      prepTime: 10,
      cookTime: null,
      notes: null,
      product: { venueId: 'venue-1' },
      lines: [],
    }
    mockRecalculationRecipe(emptyRecipe)
    mockProductRecipeGraph(emptyRecipe)

    await expect(mutate()).resolves.toBeDefined()

    // WHY: Empty legacy graphs remain invalid for readiness, but their mutation
    // path must persist an internally consistent zero cost instead of a 500.
    expect(prisma.recipeLine.update).not.toHaveBeenCalled()
    const recipeUpdateCall = (prisma.recipe.update as jest.Mock).mock.calls[0][0]
    expect(new Decimal(recipeUpdateCall.data.totalCost).toFixed(4)).toBe('0.0000')
  })

  it('maps corrupt historical calculator input to a stable 4xx mutation error', async () => {
    mockRecalculationRecipe({
      id: 'recipe-invalid',
      portionYield: 1,
      lines: [
        {
          id: 'line-invalid',
          quantity: new Decimal('0'),
          unit: Unit.GRAM,
          rawMaterial: { venueId: 'venue-1', unit: Unit.GRAM, costPerUnit: new Decimal('1') },
        },
      ],
    })

    // WHY: Historical bad rows are business data conflicts, not unexpected
    // server failures; API consumers need one stable operational error code.
    await expect(recalculateRecipeCost('recipe-invalid')).rejects.toMatchObject({
      statusCode: 422,
      code: 'RECIPE_COST_INPUT_INVALID',
    })
    expect(prisma.recipe.update).not.toHaveBeenCalled()
  })

  it('aborts when Recipe venue changes while recalculation waits for the preflight Venue lock', async () => {
    ;(prisma.recipe.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 'recipe-moved', product: { venueId: 'venue-before' } })
      .mockResolvedValueOnce({
        id: 'recipe-moved',
        portionYield: 1,
        product: { venueId: 'venue-after' },
        lines: [],
      })

    await expect(recalculateRecipeCost('recipe-moved')).rejects.toMatchObject({
      statusCode: 409,
      code: 'RECIPE_COST_VENUE_CHANGED',
    })
    // WHY: A moved Product cannot be mutated under the old Venue's coarse lock;
    // callers retry so the next preflight acquires the new tenant key.
    expect(acquireRecipeCostGraphVenueLockV1).toHaveBeenCalledWith(prisma, 'venue-before')
    expect(prisma.recipe.update).not.toHaveBeenCalled()
  })
})
