import { netSubtotalForTipCents } from '@/services/promotions/tipBase'

describe('netSubtotalForTipCents — sobre qué se calcula la propina', () => {
  it('🔴 la base es el NETO, no el bruto de catálogo', () => {
    // Un combo de $99 cuyo catálogo suma $200 daría "15%" de $30 en un cliente
    // y de $14.85 en otro. La base canónica es una sola.
    expect(
      netSubtotalForTipCents([
        { grossCents: 8000, discountCents: 2286 },
        { grossCents: 4000, discountCents: 1143 },
        { grossCents: 2000, discountCents: 571 },
      ]),
    ).toBe(10000)
  })

  it('sin descuentos el neto es el bruto', () => {
    expect(netSubtotalForTipCents([{ grossCents: 15000, discountCents: 0 }])).toBe(15000)
  })

  it('una cuenta vacía da cero, no NaN', () => {
    expect(netSubtotalForTipCents([])).toBe(0)
  })

  it('una línea de cortesía no aporta base', () => {
    expect(netSubtotalForTipCents([{ grossCents: 5000, discountCents: 5000 }])).toBe(0)
  })

  it('un descuento mayor que el bruto no genera base negativa', () => {
    // Defensa contra dato sucio: la propina nunca se calcula sobre un negativo.
    expect(netSubtotalForTipCents([{ grossCents: 5000, discountCents: 9000 }])).toBe(0)
  })
})
