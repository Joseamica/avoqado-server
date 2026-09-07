/**
 * Recipe line quantity must survive the round trip to Decimal(12,3).
 *
 * Production incident (Testarudo Cafe, 2026-09-04): a recipe was created with
 * 201 and every later "add ingredient" returned 422 RECIPE_COST_INPUT_INVALID.
 * The stored line quantity had been rounded to 0 by Postgres, and the cost
 * calculator rejects nonpositive quantities on every subsequent mutation — so
 * the recipe became permanently uneditable the moment it was created.
 */

import { CreateRecipeSchema, UpdateRecipeSchema, AddRecipeLineSchema, UpdateRecipeLineSchema } from '@/schemas/dashboard/inventory.schema'

const VENUE_ID = 'clzzzzzzzzzzzzzzzzzzzzzzz'
const PRODUCT_ID = 'clyyyyyyyyyyyyyyyyyyyyyyy'
const RAW_MATERIAL_ID = 'clxxxxxxxxxxxxxxxxxxxxxxx'
const RECIPE_LINE_ID = 'clwwwwwwwwwwwwwwwwwwwwwww'

const line = (quantity: number) => ({
  rawMaterialId: RAW_MATERIAL_ID,
  quantity,
  unit: 'GRAM',
})

const createPayload = (quantity: number) => ({
  params: { venueId: VENUE_ID, productId: PRODUCT_ID },
  body: { portionYield: 1, lines: [line(quantity)] },
})

const updatePayload = (quantity: number) => ({
  params: { venueId: VENUE_ID, productId: PRODUCT_ID },
  body: { lines: [line(quantity)] },
})

const addLinePayload = (quantity: number) => ({
  params: { venueId: VENUE_ID, productId: PRODUCT_ID },
  body: line(quantity),
})

const updateLinePayload = (quantity: number) => ({
  params: { venueId: VENUE_ID, productId: PRODUCT_ID, recipeLineId: RECIPE_LINE_ID },
  body: { quantity },
})

describe('Recipe line quantity storability', () => {
  // 1. NEW BEHAVIOUR: a quantity that Postgres would store as 0 is rejected
  describe.each([
    ['CreateRecipeSchema', CreateRecipeSchema, createPayload],
    ['UpdateRecipeSchema', UpdateRecipeSchema, updatePayload],
    ['AddRecipeLineSchema', AddRecipeLineSchema, addLinePayload],
    ['UpdateRecipeLineSchema', UpdateRecipeLineSchema, updateLinePayload],
  ] as const)('%s', (_name, schema, payload) => {
    it('rejects a quantity that rounds to zero at Decimal(12,3)', () => {
      const result = schema.safeParse(payload(0.0004))

      expect(result.success).toBe(false)
    })

    it('explains the minimum in Spanish so the user can fix it', () => {
      const result = schema.safeParse(payload(0.0004))

      if (result.success) throw new Error('expected the tiny quantity to be rejected')
      expect(result.error.issues[0].message).toContain('0.001')
    })

    it('accepts the smallest quantity Postgres can still store', () => {
      const result = schema.safeParse(payload(0.001))

      expect(result.success).toBe(true)
    })

    it('accepts a quantity that rounds up to a nonzero stored value', () => {
      const result = schema.safeParse(payload(0.0005))

      expect(result.success).toBe(true)
    })

    // 2. REGRESSION: ordinary quantities keep working
    it('still accepts an ordinary recipe quantity', () => {
      const result = schema.safeParse(payload(2))

      expect(result.success).toBe(true)
    })

    it('still rejects zero and negative quantities', () => {
      expect(schema.safeParse(payload(0)).success).toBe(false)
      expect(schema.safeParse(payload(-1)).success).toBe(false)
    })
  })

  // 3. REGRESSION: unrelated fields of the same schemas are untouched
  it('still accepts a recipe with several ordinary lines', () => {
    const result = CreateRecipeSchema.safeParse({
      params: { venueId: VENUE_ID, productId: PRODUCT_ID },
      body: {
        portionYield: 4,
        lines: [line(150), { ...line(0.5), unit: 'KILOGRAM' }],
      },
    })

    expect(result.success).toBe(true)
  })

  it('still requires at least one field on a line update', () => {
    const result = UpdateRecipeLineSchema.safeParse({
      params: { venueId: VENUE_ID, productId: PRODUCT_ID, recipeLineId: RECIPE_LINE_ID },
      body: {},
    })

    expect(result.success).toBe(false)
  })

  it('still accepts a line update that does not touch the quantity', () => {
    const result = UpdateRecipeLineSchema.safeParse({
      params: { venueId: VENUE_ID, productId: PRODUCT_ID, recipeLineId: RECIPE_LINE_ID },
      body: { isOptional: true },
    })

    expect(result.success).toBe(true)
  })
})
