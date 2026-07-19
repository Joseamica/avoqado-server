/**
 * Venta por peso — D9: weighted lines NEVER merge.
 * Spec: Avoqado-HQ/specs/2026-07-18-venta-por-peso-bascula.md
 *
 * normalizeAddItems is the batch-level merge (product+modifiers+notes+course).
 * Two weighings of the same product (0.435 kg and 0.512 kg) must stay as TWO
 * separate lines; merging them would corrupt quantity (1+1=2) with one weight.
 */
import { normalizeAddItems } from '@/services/tpv/order.tpv.service'

describe('normalizeAddItems — D9 weighted lines never merge', () => {
  it('keeps two weighings of the same product as separate lines', () => {
    const result = normalizeAddItems([
      { productId: 'prod-jamon', quantity: 1, weightQuantity: 0.435 },
      { productId: 'prod-jamon', quantity: 1, weightQuantity: 0.512 },
    ])

    expect(result).toHaveLength(2)
    expect(result.map(r => r.weightQuantity)).toEqual([0.435, 0.512])
    expect(result.every(r => r.quantity === 1)).toBe(true)
  })

  it('keeps even IDENTICAL weighings as separate lines (same product, same weight)', () => {
    const result = normalizeAddItems([
      { productId: 'prod-jamon', quantity: 1, weightQuantity: 0.25 },
      { productId: 'prod-jamon', quantity: 1, weightQuantity: 0.25 },
    ])

    expect(result).toHaveLength(2)
  })

  it('REGRESSION: identical normal lines still merge by summing quantity', () => {
    const result = normalizeAddItems([
      { productId: 'prod-taco', quantity: 1 },
      { productId: 'prod-taco', quantity: 2 },
    ])

    expect(result).toHaveLength(1)
    expect(result[0].quantity).toBe(3)
    expect(result[0]._count).toBe(2)
    expect(result[0].weightQuantity).toBeNull()
  })

  it('REGRESSION: normal lines with different modifiers/notes still do not merge', () => {
    const result = normalizeAddItems([
      { productId: 'prod-taco', quantity: 1, modifierIds: ['mod-1'] },
      { productId: 'prod-taco', quantity: 1, notes: 'sin cebolla' },
    ])

    expect(result).toHaveLength(2)
  })

  it('a weighted line does not merge into a normal line of the same product', () => {
    const result = normalizeAddItems([
      { productId: 'prod-jamon', quantity: 1 },
      { productId: 'prod-jamon', quantity: 1, weightQuantity: 0.3 },
    ])

    expect(result).toHaveLength(2)
  })
})
