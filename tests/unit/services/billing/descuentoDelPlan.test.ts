/**
 * D5 (5-nov-2026): «Tu plan» en Facturación mostraba el precio de lista aunque el negocio pagara con cupón. El precio de los
 * planes ya incluye el IVA (tax_behavior inclusive), y el cupón descuenta sobre ese precio.
 * Cupones que existen hoy: RETENTION_30_3M (30 %, 3 meses), WINBACK_30_1M (30 %, una vez), WINBACK_FIRST_MONTH_FREE
 * (100 %, una vez) y los de campaña (monto fijo en centavos, N meses).
 */
import { descuentoDelPlan, precioConDescuentoCents } from '@/services/billing/descuentoDelPlan'

const cupon = (over: Record<string, unknown>) => ({
  id: 'c',
  percent_off: null,
  amount_off: null,
  currency: null,
  duration: 'once',
  ...over,
})
const conDescuento = (coupon: unknown, end: number | null = null) => ({
  discounts: [{ id: 'di_1', source: { type: 'coupon', coupon }, end }],
})

describe('descuentoDelPlan', () => {
  it('retención 30 % por 3 meses → porcentaje y fecha de fin', () => {
    const fin = Date.UTC(2027, 1, 5, 12) / 1000
    expect(descuentoDelPlan(conDescuento(cupon({ percent_off: 30, duration: 'repeating' }), fin))).toEqual({
      percentOff: 30,
      amountOffCents: null,
      duration: 'repeating',
      endsAt: new Date(fin * 1000),
    })
  })

  it('30 % una vez y 100 % una vez → sin fecha (aplican al siguiente cobro)', () => {
    expect(descuentoDelPlan(conDescuento(cupon({ percent_off: 30, duration: 'once' })))).toMatchObject({
      percentOff: 30,
      duration: 'once',
      endsAt: null,
    })
    expect(descuentoDelPlan(conDescuento(cupon({ percent_off: 100, duration: 'once' })))).toMatchObject({ percentOff: 100 })
  })

  it('campaña: monto fijo en pesos mexicanos', () => {
    expect(descuentoDelPlan(conDescuento(cupon({ amount_off: 46400, currency: 'mxn', duration: 'repeating' }), 1800000000))).toMatchObject({
      percentOff: null,
      amountOffCents: 46400,
    })
  })

  it('el descuento viejo de un solo objeto (`discount.coupon`) también cuenta', () => {
    expect(descuentoDelPlan({ discount: { coupon: cupon({ percent_off: 30, duration: 'once' }), end: null } })).toMatchObject({
      percentOff: 30,
    })
  })

  it('🔴 Codex r1 #1: cupón limitado a OTRO producto (campaña de Pro sobre Premium) → no descuenta este plan', () => {
    const soloPro = conDescuento(
      cupon({ amount_off: 113684, currency: 'mxn', duration: 'forever', applies_to: { products: ['prod_pro'] } }),
    )
    expect(descuentoDelPlan(soloPro, 'prod_premium')).toBeNull()
    expect(descuentoDelPlan(soloPro, 'prod_pro')).toMatchObject({ amountOffCents: 113684 })
    expect(descuentoDelPlan(soloPro)).toBeNull()
  })

  it.each([
    ['sin descuentos', {}],
    ['el cupón sin expandir (sólo su id): no se adivina', conDescuento('RETENTION_30_3M')],
    [
      'dos descuentos a la vez: no se adivina cómo se combinan',
      { discounts: [conDescuento(cupon({ percent_off: 30 })).discounts[0], conDescuento(cupon({ percent_off: 10 })).discounts[0]] },
    ],
    ['monto fijo en otra moneda', conDescuento(cupon({ amount_off: 1000, currency: 'usd' }))],
  ])('%s → null (se muestra el precio de lista, como hoy)', (_caso, sub) => {
    expect(descuentoDelPlan(sub)).toBeNull()
  })
})

describe('precioConDescuentoCents', () => {
  it('30 % sobre $1,158.84 → $811.19 (redondeo a centavos)', () => {
    expect(precioConDescuentoCents(115884, { percentOff: 30, amountOffCents: null, duration: 'repeating', endsAt: null })).toBe(81119)
  })
  it('100 % → $0', () => {
    expect(precioConDescuentoCents(115884, { percentOff: 100, amountOffCents: null, duration: 'once', endsAt: null })).toBe(0)
  })
  it('monto fijo, nunca negativo', () => {
    expect(precioConDescuentoCents(115884, { percentOff: null, amountOffCents: 46400, duration: 'once', endsAt: null })).toBe(69484)
    expect(precioConDescuentoCents(1000, { percentOff: null, amountOffCents: 5000, duration: 'once', endsAt: null })).toBe(0)
  })
})
