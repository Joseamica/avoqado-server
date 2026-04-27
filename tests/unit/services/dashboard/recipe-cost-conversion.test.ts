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
import { recalculateRecipeCost } from '@/services/dashboard/recipe.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    recipe: { findUnique: jest.fn(), update: jest.fn() },
    recipeLine: { update: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

describe('recalculateRecipeCost — unit-conversion + per-line refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(prisma))
    ;(prisma.recipe.update as jest.Mock).mockResolvedValue({ id: 'recipe-1' })
  })

  it('REGRESSION: converts KG line quantity to GRAM RM unit when computing total', async () => {
    // Hazelnut treat: 0.062 KG of protein stored in GRAM at $0.83/g.
    // Expected total: 62g × $0.83 = $51.46. Pre-fix returned $0.05.
    ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue({
      id: 'recipe-1',
      portionYield: 1,
      lines: [
        {
          id: 'line-1',
          quantity: new Decimal('0.062'),
          unit: Unit.KILOGRAM,
          rawMaterial: { unit: Unit.GRAM, costPerUnit: new Decimal('0.83') },
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
    ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue({
      id: 'recipe-batch',
      portionYield: 8,
      lines: [
        {
          id: 'line-1',
          quantity: new Decimal('1'),
          unit: Unit.KILOGRAM,
          rawMaterial: { unit: Unit.GRAM, costPerUnit: new Decimal('0.5') },
        },
      ],
    })

    await recalculateRecipeCost('recipe-batch')

    const lineUpdateCall = (prisma.recipeLine.update as jest.Mock).mock.calls[0][0]
    expect(Number(lineUpdateCall.data.costPerServing)).toBeCloseTo(62.5, 2) // $500 / 8 portions
  })

  it('passes line.quantity unchanged when units already match', async () => {
    ;(prisma.recipe.findUnique as jest.Mock).mockResolvedValue({
      id: 'recipe-match',
      portionYield: 1,
      lines: [
        {
          id: 'line-1',
          quantity: new Decimal('0.5'),
          unit: Unit.LITER,
          rawMaterial: { unit: Unit.LITER, costPerUnit: new Decimal('20') },
        },
      ],
    })

    await recalculateRecipeCost('recipe-match')

    const recipeUpdateCall = (prisma.recipe.update as jest.Mock).mock.calls[0][0]
    expect(Number(recipeUpdateCall.data.totalCost)).toBeCloseTo(10, 2) // 0.5 L × $20/L
  })
})
