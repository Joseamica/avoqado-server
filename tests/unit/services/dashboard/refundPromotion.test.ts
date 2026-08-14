import { assertPromotionLineFullQuantity, assertRefundableLines } from '@/services/dashboard/refund.dashboard.service'

describe('assertRefundableLines — una promoción no se reembolsa a pedazos', () => {
  const combo = [
    { id: 'i1', orderPromotionId: 'op-1', total: 57.14 },
    { id: 'i2', orderPromotionId: 'op-1', total: 28.57 },
    { id: 'i3', orderPromotionId: 'op-1', total: 14.29 },
  ]

  it('reembolsar el combo COMPLETO se permite', () => {
    expect(() => assertRefundableLines(combo, ['i1', 'i2', 'i3'])).not.toThrow()
  })

  it('🔴 reembolsar UN componente se rechaza', () => {
    // Devolver sólo el refresco dejaría hamburguesa + papas cobradas a precio
    // de combo, y no hay regla escrita de cómo se reprecia el resto.
    expect(() => assertRefundableLines(combo, ['i3'])).toThrow(/completa/i)
  })

  it('reembolsar dos de tres también se rechaza', () => {
    expect(() => assertRefundableLines(combo, ['i1', 'i2'])).toThrow(/completa/i)
  })

  it('las líneas normales se reembolsan sueltas como siempre', () => {
    const normales = [
      { id: 'n1', orderPromotionId: null, total: 100 },
      { id: 'n2', orderPromotionId: null, total: 50 },
    ]
    expect(() => assertRefundableLines(normales, ['n1'])).not.toThrow()
  })

  it('mezclar una línea normal con un combo completo se permite', () => {
    const mixto = [...combo, { id: 'n1', orderPromotionId: null, total: 100 }]
    expect(() => assertRefundableLines(mixto, ['i1', 'i2', 'i3', 'n1'])).not.toThrow()
  })
})

describe('assertPromotionLineFullQuantity — tampoco a pedazos POR CANTIDAD', () => {
  // Audit max 2026-08-13: el todo-o-nada era por LÍNEAS, pero un 2x1 guardado
  // como UNA línea con quantity 2 (una pagada, una regalada) pasaba el guard
  // seleccionando la línea con quantity 1 — y el prorrateo neto/2 no sabe si
  // la unidad devuelta era la de $0 o la de precio completo.
  it('🔴 devolver 1 de las 2 unidades de una línea de promo se rechaza', () => {
    expect(() => assertPromotionLineFullQuantity({ orderPromotionId: 'op-1', quantity: 2 }, 1)).toThrow(/completas/i)
  })

  it('devolver la cantidad COMPLETA de la línea de promo se permite', () => {
    expect(() => assertPromotionLineFullQuantity({ orderPromotionId: 'op-1', quantity: 2 }, 2)).not.toThrow()
  })

  it('una línea normal se devuelve parcial como siempre (regresión)', () => {
    expect(() => assertPromotionLineFullQuantity({ orderPromotionId: null, quantity: 3 }, 1)).not.toThrow()
  })
})
