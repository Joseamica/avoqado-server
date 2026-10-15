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

/**
 * D5 v5 (mesas40, 15-oct): el server NO recorta `OrderItem.notes`. La nota es la llave de la fusión en `normalizeAddItems`
 * y del match contra filas existentes; cuatro rondas de recorte (pelón, con huella, sólo en rondas) chocaron con esa
 * identidad. La nota queda como en `a2e999c0f`: sólo trim. El tope vive en la captura del aparato.
 */
describe('normalizeAddItems — D5 v5: la nota de un artículo no lleva tope en el server', () => {
  const notaLarga = 'a'.repeat(490) + '🌮' + 'b'.repeat(9_546)

  it('🔴 una nota de 10,038 caracteres queda COMPLETA', () => {
    expect(notaLarga).toHaveLength(10_038)

    const [line] = normalizeAddItems([{ productId: 'prod-taco', quantity: 1, notes: notaLarga }])

    expect(line.notes).toBe(notaLarga)
  })

  // D5 v3 (Codex P1): un recorte fusionaba dos líneas DISTINTAS en una con `_count = 2`, y el carrito reenviado sumaba
  // esa cantidad a la fila existente. Sin recorte no pasa; la prueba se queda de guarda.
  it('🔴 dos líneas del mismo producto cuyas notas comparten los primeros 500 caracteres NO se fusionan', () => {
    const base = 'a'.repeat(500)

    const lineas = normalizeAddItems([
      { productId: 'prod-taco', quantity: 1, notes: base + 'A' },
      { productId: 'prod-taco', quantity: 1, notes: base + 'B' },
    ])

    expect(lineas).toHaveLength(2)
    expect(lineas.map(linea => [linea.quantity, linea._count])).toEqual([
      [1, 1],
      [1, 1],
    ])
    expect(lineas[0].notes).not.toBe(lineas[1].notes)
  })

  it('una nota normal sólo pierde los espacios de las orillas', () => {
    const [line] = normalizeAddItems([{ productId: 'prod-taco', quantity: 1, notes: '  sin cebolla 🌶️ ' }])

    expect(line.notes).toBe('sin cebolla 🌶️')
  })
})
