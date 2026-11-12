/**
 * D2 (pizarrón hz:dcc49fe5:D2, 12-nov): todo % de dinero que calcula el SERVIDOR va en centavos enteros, mitad hacia arriba, como la
 * TPV (BigDecimal) y ANDROID. En pesos flotantes 2.135 × 100 = 213.49999999999997: 10 % de $21.35 daba $2.13 y la terminal $2.14.
 * Expediente: docs/audit/2026-11-12-d2-dinero-en-centavos/ (workspace).
 */
import { calculateDiscountCents, calculateDiscountPesos } from '@/services/shared/discount.service'
import { importesDeLasFilas, nuevoRepartoDeCuenta, porcentajeEnCentavos } from '@/services/shared/repartoDescuento'
import { calculateDiscountAmount } from '@/services/dashboard/discountEngine.service'

describe('porcentajeEnCentavos — la regla única del % en dinero', () => {
  it('10 % de 2135 ¢ = 214 ¢ (medio centavo hacia arriba; en pesos flotantes daba 213)', () => {
    expect(porcentajeEnCentavos(2135, 10)).toBe(214)
  })
  it('% con decimales en decimal exacto: 9.2 % de 375 ¢ = 35 ¢, como la TPV', () => {
    expect(porcentajeEnCentavos(375, 9.2)).toBe(35)
  })
  it('acepta el valor como Decimal de Prisma o texto, y base 0 da 0', () => {
    expect(porcentajeEnCentavos(1615, '50')).toBe(808)
    expect(porcentajeEnCentavos(0, 10)).toBe(0)
  })
  it('control — en % entero es idéntica a la de ANDROID / montoDelCupon (`Math.round(¢ × % / 100)`)', () => {
    for (const pct of [5, 10, 15, 25, 33, 50]) {
      for (let c = 1; c <= 5000; c++) expect(porcentajeEnCentavos(c, pct)).toBe(Math.round((c * pct) / 100))
    }
  })
})

describe('importesDeLasFilas — el recálculo re-deriva el % en centavos (antes $2.13)', () => {
  const renglon = (id: string, total: number) => ({ id, total, discountAmount: 0, orderPromotionId: null })
  const cupon = (extra: Record<string, unknown> = {}) => ({
    id: 'cupon',
    type: 'PERCENTAGE',
    value: 10,
    amount: 2.14,
    appliedToItemIds: [] as string[],
    reparto: nuevoRepartoDeCuenta({ conPromociones: true }),
    createdAt: new Date(0),
    ...extra,
  })
  it('🔴 10 % de una cuenta de $21.35: $2.14, el mismo que puso el cupón al crear la venta', () => {
    const r = importesDeLasFilas([renglon('a', 21.35)], [cupon()])
    expect(r.montosRederivados.get('cupon')).toBe(2.14)
    expect(r.descuento).toBe(2.14)
  })
  it('🔴 la base se suma en centavos: $10.00 + $11.35 sigue dando $2.14', () => {
    const r = importesDeLasFilas([renglon('a', 10), renglon('b', 11.35)], [cupon()])
    expect(r.montosRederivados.get('cupon')).toBe(2.14)
  })
  it('cupón con tope de $2.00: $2.00', () => {
    const r = importesDeLasFilas([renglon('a', 21.35)], [cupon({ reparto: nuevoRepartoDeCuenta({ conPromociones: true, tope: 2 }) })])
    expect(r.montosRederivados.get('cupon')).toBe(2)
  })
  it('control — un premio de monto fijo junto al cupón conserva su importe ($1 + $2.14)', () => {
    const premio = { ...cupon(), id: 'premio', type: 'FIXED_AMOUNT', value: 1, amount: 1 }
    const r = importesDeLasFilas([renglon('a', 21.35)], [cupon(), premio])
    expect(r.montosRederivados.has('premio')).toBe(false)
    expect(r.descuento).toBe(3.14)
  })
})

describe('calculateDiscountPesos — el descuento de catálogo de la venta sin red de la TPV (`POST /mobile/orders` con orderDiscountId)', () => {
  const pct = { name: 'Diez', type: 'PERCENTAGE', value: 10, maxDiscountAmount: null, minPurchaseAmount: null }
  it('🔴 10 % de $21.35 = $2.14, lo que cobró la TPV (antes $2.13: «Por cobrar» $0.01)', () => {
    expect(calculateDiscountPesos(pct, 21.35)).toBe(2.14)
  })
  it('con tope de $2.00: $2.00', () => {
    expect(calculateDiscountPesos({ ...pct, maxDiscountAmount: 2 }, 21.35)).toBe(2)
  })
  it('% con decimales, exacto como la TPV: 9.2 % de $3.75 = $0.35', () => {
    expect(calculateDiscountPesos({ ...pct, value: 9.2 }, 3.75)).toBe(0.35)
  })
  it('control — sigue rechazando la compra mínima, y fijo y cortesía como hoy', () => {
    expect(() => calculateDiscountPesos({ ...pct, minPurchaseAmount: 50 }, 21.35)).toThrow('requires a minimum purchase amount')
    expect(calculateDiscountPesos({ ...pct, type: 'FIXED_AMOUNT', value: 30 }, 21.35)).toBe(21.35)
    expect(calculateDiscountPesos({ ...pct, type: 'COMP' }, 21.35)).toBe(21.35)
  })
  it('control — `calculateDiscountCents` (la regla de ANDROID) no cambia: 9.2 % de 375 ¢ sigue en 34 ¢', () => {
    expect(calculateDiscountCents({ type: 'PERCENTAGE', value: 9.2 }, 375)).toBe(34)
    expect(calculateDiscountCents({ type: 'PERCENTAGE', value: 10 }, 2135)).toBe(214)
  })
})

describe('motor de descuentos — el % y el 2×1 en centavos', () => {
  const base = {
    id: 'd',
    name: 'Diez',
    type: 'PERCENTAGE',
    value: 10,
    scope: 'ORDER',
    targetItemIds: [],
    targetCategoryIds: [],
    targetModifierIds: [],
    targetModifierGroupIds: [],
    customerGroupId: null,
    isAutomatic: true,
    priority: 0,
    minPurchaseAmount: null,
    maxDiscountAmount: null,
    minQuantity: null,
    buyQuantity: null,
    getQuantity: null,
    getDiscountPercent: null,
    buyItemIds: [],
    getItemIds: [],
    requiresApproval: false,
    applyBeforeTax: false,
    isStackable: false,
    stackPriority: 0,
  } as any
  const contexto = (items: Array<{ id: string; unitPrice: number; quantity: number }>) =>
    ({
      orderId: 'o',
      venueId: 'v',
      subtotal: items.reduce((s, i) => s + i.unitPrice * i.quantity, 0),
      items: items.map(i => ({ ...i, productId: `p-${i.id}`, categoryId: 'c', total: i.unitPrice * i.quantity, modifiers: [] })),
      appliedDiscounts: [],
    }) as any

  it('🔴 % de cuenta: 10 % de $21.35 = $2.14 (antes $2.13)', () => {
    expect(calculateDiscountAmount(base, contexto([{ id: 'a', unitPrice: 21.35, quantity: 1 }])).amount).toBe(2.14)
  })
  it('🔴 % de artículo (fila dirigida que el recálculo re-deriva en su ámbito): $2.14', () => {
    const r = calculateDiscountAmount(
      { ...base, scope: 'ITEM', targetItemIds: ['p-a'] },
      contexto([{ id: 'a', unitPrice: 21.35, quantity: 1 }]),
    )
    expect(r.amount).toBe(2.14)
  })
  it('con tope de $2.00: $2.00', () => {
    expect(calculateDiscountAmount({ ...base, maxDiscountAmount: 2 }, contexto([{ id: 'a', unitPrice: 21.35, quantity: 1 }])).amount).toBe(
      2,
    )
  })
  it('🔴 2×1 con el segundo al 50 %: dos de $16.15 regalan $8.08 (antes $8.07; la fila dirigida conserva ese importe)', () => {
    const dos = { ...base, scope: 'QUANTITY', buyQuantity: 1, getQuantity: 1, getDiscountPercent: 50 }
    expect(calculateDiscountAmount(dos, contexto([{ id: 'a', unitPrice: 16.15, quantity: 2 }])).amount).toBe(8.08)
  })
  it('control — 2×1 gratis de dos de $21.35: $21.35', () => {
    const dos = { ...base, scope: 'QUANTITY', buyQuantity: 1, getQuantity: 1, getDiscountPercent: null }
    expect(calculateDiscountAmount(dos, contexto([{ id: 'a', unitPrice: 21.35, quantity: 2 }])).amount).toBe(21.35)
  })
})
