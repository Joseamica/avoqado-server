/**
 * A recipe that already holds invalid data must tell the user WHICH ingredient
 * is wrong and what to do about it.
 *
 * Production incident (Testarudo Cafe, 2026-09-04): six consecutive attempts to
 * add an ingredient returned the untranslated, contextless message "Recipe cost
 * inputs are invalid". The dashboard prints the server message verbatim, so the
 * operator had no way to know which of the existing lines was blocking the save.
 */

import { RecipeCostCalculationError, describeRecipeCostErrorV1 } from '@/services/dashboard/recipe-cost-calculator'

const LINES = [
  { id: 'line-salt', ingredientName: 'Sal' },
  { id: 'line-salmon', ingredientName: 'Salmón' },
]

describe('describeRecipeCostErrorV1', () => {
  it('names the ingredient whose quantity was stored as zero', () => {
    const message = describeRecipeCostErrorV1(new RecipeCostCalculationError('INVALID_LINE_QUANTITY', 'line-salt'), LINES)

    expect(message).toContain('Sal')
    expect(message).toContain('0.001')
  })

  it('names the ingredient whose cost is invalid', () => {
    const message = describeRecipeCostErrorV1(new RecipeCostCalculationError('INVALID_LINE_COST', 'line-salmon'), LINES)

    expect(message).toContain('Salmón')
    expect(message).toContain('costo')
  })

  it('names the ingredient whose unit is incompatible', () => {
    const message = describeRecipeCostErrorV1(new RecipeCostCalculationError('INCOMPATIBLE_LINE_UNIT', 'line-salmon'), LINES)

    expect(message).toContain('Salmón')
    expect(message).toContain('unidad')
  })

  it('explains an invalid portion yield without inventing an ingredient', () => {
    const message = describeRecipeCostErrorV1(new RecipeCostCalculationError('INVALID_PORTION_YIELD'), LINES)

    expect(message).toContain('rendimiento')
    expect(message).not.toContain('Sal')
  })

  it('degrades to a generic phrase when the line is unknown instead of printing an id', () => {
    const message = describeRecipeCostErrorV1(new RecipeCostCalculationError('INVALID_LINE_QUANTITY', 'line-that-vanished'), LINES)

    expect(message).not.toContain('line-that-vanished')
    expect(message.length).toBeGreaterThan(0)
  })

  it('is written in Spanish, because the dashboard prints it verbatim', () => {
    const messages = LINES.map(line => describeRecipeCostErrorV1(new RecipeCostCalculationError('INVALID_LINE_QUANTITY', line.id), LINES))

    for (const message of messages) {
      expect(message).not.toContain('Recipe cost inputs are invalid')
      expect(message).not.toMatch(/\b(invalid|quantity|ingredient)\b/i)
    }
  })
})
