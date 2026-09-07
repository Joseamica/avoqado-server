/**
 * A recipe that already contains an invalid line must still be repairable, and
 * the 422 it raises must say which ingredient blocks the save.
 *
 * Production incident (Testarudo Cafe, 2026-09-04, product BAGEL DE SALMON):
 * POST /recipe returned 201 and every later POST /recipe/lines returned 422
 * with the untranslated "Recipe cost inputs are invalid". The dashboard shows
 * the server message verbatim, so the operator was left with a dead end.
 */

import prisma from '@/utils/prismaClient'
import { addRecipeLine, updateRecipeLine, removeRecipeLine } from '@/services/dashboard/recipe.service'
import AppError from '@/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

jest.mock('@/services/dashboard/recipe-cost-graph-lock', () => ({
  acquireRecipeCostGraphVenueLockV1: jest.fn(),
  lockRecipeCostGraphRowsV1: jest.fn().mockResolvedValue(true),
  lockRecipeCostProductForUpdateV1: jest.fn().mockResolvedValue(true),
  lockRecipeCostRawMaterialsForShareV1: jest.fn().mockImplementation(async (_tx, _venue, ids) => ids),
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    recipe: { findFirst: jest.fn(), update: jest.fn() },
    rawMaterial: { findFirst: jest.fn() },
    recipeLine: { create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const VENUE_ID = 'venue-testarudo'
const PRODUCT_ID = 'product-bagel'

const SALT = {
  id: 'raw-salt',
  venueId: VENUE_ID,
  name: 'Sal',
  costPerUnit: new Decimal('0.02'),
  unit: 'GRAM',
  active: true,
  deletedAt: null,
}

const LEMON = {
  id: 'raw-lemon',
  venueId: VENUE_ID,
  name: 'Limón Amarillo',
  costPerUnit: new Decimal('0.06'),
  unit: 'GRAM',
  active: true,
  deletedAt: null,
}

/** The line Postgres stored as 0 after Decimal(12,3) rounding. */
const brokenSaltLine = {
  id: 'line-salt',
  recipeId: 'recipe-bagel',
  rawMaterialId: SALT.id,
  quantity: new Decimal(0),
  unit: 'GRAM',
  costPerServing: new Decimal(0),
  displayOrder: 0,
  rawMaterial: SALT,
}

const healthySalmonLine = {
  id: 'line-salmon',
  recipeId: 'recipe-bagel',
  rawMaterialId: 'raw-salmon',
  quantity: new Decimal(80),
  unit: 'GRAM',
  costPerServing: new Decimal(20),
  displayOrder: 1,
  rawMaterial: { ...SALT, id: 'raw-salmon', name: 'Salmón', costPerUnit: new Decimal('0.25') },
}

function mockLockedRecipe(lines: unknown[]) {
  const row = {
    id: 'recipe-bagel',
    productId: PRODUCT_ID,
    portionYield: 1,
    totalCost: new Decimal('36.94'),
    product: { venueId: VENUE_ID },
    lines,
  }
  ;(prisma.recipe.findFirst as jest.Mock).mockImplementation(async ({ select }: any) => (select ? { id: row.id } : row))
}

describe('Recipe with an already-broken line', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async callback => callback(prisma))
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(LEMON)
    ;(prisma.recipe.update as jest.Mock).mockResolvedValue({})
    ;(prisma.recipeLine.update as jest.Mock).mockResolvedValue({})
    ;(prisma.recipeLine.delete as jest.Mock).mockResolvedValue({})
    ;(prisma.recipeLine.create as jest.Mock).mockResolvedValue({ id: 'line-new' })
  })

  // 1. NEW BEHAVIOUR: the 422 names the culprit
  it('names the offending ingredient when adding another one', async () => {
    mockLockedRecipe([brokenSaltLine, healthySalmonLine])

    await expect(addRecipeLine(VENUE_ID, PRODUCT_ID, { rawMaterialId: LEMON.id, quantity: 2, unit: 'GRAM' })).rejects.toThrow(/Sal/)
  })

  it('keeps the 422 status and the RECIPE_COST_INPUT_INVALID code', async () => {
    mockLockedRecipe([brokenSaltLine, healthySalmonLine])

    const error = await addRecipeLine(VENUE_ID, PRODUCT_ID, { rawMaterialId: LEMON.id, quantity: 2, unit: 'GRAM' }).catch(
      (caught: AppError) => caught,
    )

    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).statusCode).toBe(422)
    expect((error as AppError).code).toBe('RECIPE_COST_INPUT_INVALID')
    expect((error as AppError).details).toMatchObject({ reason: 'INVALID_LINE_QUANTITY', lineId: 'line-salt' })
  })

  it('does not blame the ingredient the user was actually adding', async () => {
    mockLockedRecipe([brokenSaltLine, healthySalmonLine])

    const error = await addRecipeLine(VENUE_ID, PRODUCT_ID, { rawMaterialId: LEMON.id, quantity: 2, unit: 'GRAM' }).catch(
      (caught: Error) => caught,
    )

    expect((error as Error).message).not.toContain('Limón Amarillo')
  })

  // 2. THE WAY OUT: the user must be able to repair the recipe
  it('lets the user repair the broken line by fixing its quantity', async () => {
    mockLockedRecipe([brokenSaltLine, healthySalmonLine])

    await expect(updateRecipeLine(VENUE_ID, PRODUCT_ID, 'line-salt', { quantity: 5 })).resolves.toBeDefined()
  })

  it('lets the user repair the recipe by removing the broken line', async () => {
    mockLockedRecipe([brokenSaltLine, healthySalmonLine])

    await expect(removeRecipeLine(VENUE_ID, PRODUCT_ID, 'line-salt')).resolves.toBeUndefined()
  })

  // 3. REGRESSION: a healthy recipe is unaffected
  it('still adds an ingredient to a healthy recipe', async () => {
    mockLockedRecipe([healthySalmonLine])

    await expect(addRecipeLine(VENUE_ID, PRODUCT_ID, { rawMaterialId: LEMON.id, quantity: 2, unit: 'GRAM' })).resolves.toEqual({
      id: 'line-new',
    })
  })

  it('still writes the recomputed total cost of a healthy recipe', async () => {
    mockLockedRecipe([healthySalmonLine])

    await addRecipeLine(VENUE_ID, PRODUCT_ID, { rawMaterialId: LEMON.id, quantity: 2, unit: 'GRAM' })

    expect(prisma.recipe.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ totalCost: expect.anything() }) }),
    )
  })
})

describe('Recipe line quantity guard in the service layer', () => {
  // WHY: the chatbot action engine writes recipe lines without ever passing
  // through the HTTP Zod schema, so the invariant has to hold here too.
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async callback => callback(prisma))
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(LEMON)
    ;(prisma.recipe.update as jest.Mock).mockResolvedValue({})
    ;(prisma.recipeLine.update as jest.Mock).mockResolvedValue({})
    ;(prisma.recipeLine.create as jest.Mock).mockResolvedValue({ id: 'line-new' })
    mockLockedRecipe([healthySalmonLine])
  })

  it('refuses a quantity the database would store as zero', async () => {
    const error = await addRecipeLine(VENUE_ID, PRODUCT_ID, { rawMaterialId: LEMON.id, quantity: 0.0004, unit: 'GRAM' }).catch(
      (caught: AppError) => caught,
    )

    expect((error as AppError).code).toBe('RECIPE_QUANTITY_TOO_SMALL')
    expect((error as AppError).statusCode).toBe(400)
    expect((error as AppError).message).toContain('Limón Amarillo')
  })

  it('never writes the unstorable line', async () => {
    await addRecipeLine(VENUE_ID, PRODUCT_ID, { rawMaterialId: LEMON.id, quantity: 0.0004, unit: 'GRAM' }).catch(() => undefined)

    expect(prisma.recipeLine.create).not.toHaveBeenCalled()
  })

  it('refuses to edit an existing line down to an unstorable quantity', async () => {
    mockLockedRecipe([healthySalmonLine])

    await expect(updateRecipeLine(VENUE_ID, PRODUCT_ID, 'line-salmon', { quantity: 0.0004 })).rejects.toThrow(/0.001/)
  })

  it('still accepts the smallest storable quantity', async () => {
    await expect(addRecipeLine(VENUE_ID, PRODUCT_ID, { rawMaterialId: LEMON.id, quantity: 0.001, unit: 'GRAM' })).resolves.toBeDefined()
  })
})
