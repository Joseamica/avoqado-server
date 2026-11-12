import { Prisma } from '@prisma/client'
import {
  evaluarPromo,
  sellosConPromo,
  puntosConPromo,
  PromoCandidata,
  VentaParaPromo,
  PromoDecidida,
} from '@/services/loyalty/promotions/evaluarPromo'

const D = (n: number | string) => new Prisma.Decimal(n)

const promo = (o: Partial<PromoCandidata> = {}): PromoCandidata => ({
  id: 'p1',
  name: 'Promo',
  createdAt: new Date('2026-11-01T00:00:00Z'),
  startsAt: new Date('2026-11-01T00:00:00Z'),
  endsAt: null,
  endedAt: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  productIds: [],
  categoryIds: [],
  categoryNames: [],
  minSpend: null,
  limit: 'NONE',
  kind: 'MULTIPLY',
  multiplier: 2,
  extraStamps: null,
  extraPoints: null,
  ...o,
})

const venta = (o: Partial<VentaParaPromo> = {}): VentaParaPromo => ({
  soldAt: new Date('2026-11-10T20:00:00Z'),
  timezone: 'America/Mexico_City',
  amount: 100,
  lineas: [{ productId: 'A', categoryIdActual: 'c1', categoryName: 'Cat 1', neto: D(100) }],
  usos: {},
  ...o,
})

describe('evaluarPromo', () => {
  it('fuera de fechas (después de endsAt) → null', () => {
    expect(evaluarPromo([promo({ endsAt: new Date('2026-11-09T00:00:00Z') })], venta())).toBeNull()
  })

  it('antes de startsAt → null', () => {
    expect(evaluarPromo([promo({ startsAt: new Date('2026-11-11T00:00:00Z') })], venta())).toBeNull()
  })

  it('después de endedAt → null, pero antes de endedAt sí', () => {
    const p = promo({ endedAt: new Date('2026-11-10T20:00:00Z') })
    expect(evaluarPromo([p], venta())).toBeNull()
    expect(evaluarPromo([p], venta({ soldAt: new Date('2026-11-10T19:59:59Z') }))?.promotionId).toBe('p1')
  })

  it('martes 16:00–18:00 en America/Mexico_City con soldAt UTC', () => {
    const p = promo({ daysOfWeek: [2], timeFrom: '16:00', timeUntil: '18:00' })
    // 23:00Z del martes 10-nov = 17:00 en CDMX
    expect(evaluarPromo([p], venta({ soldAt: new Date('2026-11-10T23:00:00Z') }))).not.toBeNull()
    // 20:00Z = 14:00 CDMX
    expect(evaluarPromo([p], venta({ soldAt: new Date('2026-11-10T20:00:00Z') }))).toBeNull()
    // miércoles 17:00 CDMX
    expect(evaluarPromo([p], venta({ soldAt: new Date('2026-11-11T23:00:00Z') }))).toBeNull()
  })

  it('producto que califica entre otros → monto = amount × neto que califica ÷ neto total', () => {
    const p = promo({ productIds: ['A'] })
    const v = venta({
      amount: 150,
      lineas: [
        { productId: 'A', categoryIdActual: null, categoryName: null, neto: D(50) },
        { productId: 'B', categoryIdActual: null, categoryName: null, neto: D(100) },
      ],
    })
    const d = evaluarPromo([p], v)!
    expect(d.montoQueCalifica.toString()).toBe('50')
  })

  it('montoQueCalifica sin filtro = amount; con filtro se redondea a centavos', () => {
    expect(evaluarPromo([promo()], venta({ amount: 99.99 }))!.montoQueCalifica.toString()).toBe('99.99')
    const v = venta({
      amount: 100,
      lineas: [
        { productId: 'A', categoryIdActual: null, categoryName: null, neto: D(1) },
        { productId: 'B', categoryIdActual: null, categoryName: null, neto: D(2) },
      ],
    })
    expect(evaluarPromo([promo({ productIds: ['A'] })], v)!.montoQueCalifica.toString()).toBe('33.33')
  })

  it('A $30 y B $80, sólo A, 1 punto por peso, ×2 → total 140, no 139', () => {
    const v = venta({
      amount: 110,
      lineas: [
        { productId: 'A', categoryIdActual: null, categoryName: null, neto: D(30) },
        { productId: 'B', categoryIdActual: null, categoryName: null, neto: D(80) },
      ],
    })
    const d = evaluarPromo([promo({ productIds: ['A'] })], v)!
    expect(d.montoQueCalifica.toString()).toBe('30')
    const r = puntosConPromo({ total: 110, bono: 0, pointsPerDollar: 1 }, d)
    expect(r.total).toBe(140)
  })

  it('producto movido de categoría: el categoryName del renglón todavía califica', () => {
    const p = promo({ categoryIds: ['cNueva'], categoryNames: ['Bebidas'] })
    const v = venta({ lineas: [{ productId: 'A', categoryIdActual: 'cOtra', categoryName: 'Bebidas', neto: D(100) }] })
    expect(evaluarPromo([p], v)).not.toBeNull()
    const v2 = venta({ lineas: [{ productId: 'A', categoryIdActual: 'cOtra', categoryName: 'Postres', neto: D(100) }] })
    expect(evaluarPromo([p], v2)).toBeNull()
  })

  it('producto que califica pero al 100 % de descuento → null', () => {
    const p = promo({ productIds: ['A'] })
    const v = venta({ lineas: [{ productId: 'A', categoryIdActual: null, categoryName: null, neto: D(0) }] })
    expect(evaluarPromo([p], v)).toBeNull()
  })

  it('gasto mínimo 500 con amount 499.99 → null', () => {
    expect(evaluarPromo([promo({ minSpend: 500 })], venta({ amount: 499.99 }))).toBeNull()
    expect(evaluarPromo([promo({ minSpend: 500 })], venta({ amount: 500 }))).not.toBeNull()
  })

  it('ONCE_PER_DAY con delDia 1 → null', () => {
    const p = promo({ limit: 'ONCE_PER_DAY' })
    expect(evaluarPromo([p], venta({ usos: { p1: { delDia: 1, total: 1 } } }))).toBeNull()
    expect(evaluarPromo([p], venta({ usos: { p1: { delDia: 0, total: 3 } } }))).not.toBeNull()
  })

  it('ONCE_PER_PROMOTION con total 1 → null', () => {
    const p = promo({ limit: 'ONCE_PER_PROMOTION' })
    expect(evaluarPromo([p], venta({ usos: { p1: { delDia: 0, total: 1 } } }))).toBeNull()
  })

  it('empate de createdAt: gana el id mayor, sin importar el orden', () => {
    const a = promo({ id: 'a' })
    const b = promo({ id: 'b' })
    expect(evaluarPromo([a, b], venta())?.promotionId).toBe('b')
    expect(evaluarPromo([b, a], venta())?.promotionId).toBe('b')
  })

  it('sin filtro el monto se redondea a centavos', () => {
    expect(evaluarPromo([promo()], venta({ amount: 10.005 }))!.montoQueCalifica.toString()).toBe('10.01')
  })

  it('filtro con neto total 0 → null', () => {
    const v = venta({ lineas: [{ productId: 'A', categoryIdActual: null, categoryName: null, neto: D(0) }] })
    expect(evaluarPromo([promo({ productIds: ['A'] })], v)).toBeNull()
  })

  it('el monto que califica nunca pasa del amount', () => {
    const v = venta({ amount: 50, lineas: [{ productId: 'A', categoryIdActual: null, categoryName: null, neto: D(100) }] })
    expect(evaluarPromo([promo({ productIds: ['A'] })], v)!.montoQueCalifica.toString()).toBe('50')
  })

  it('dos vigentes → la más nueva', () => {
    const vieja = promo({ id: 'vieja', createdAt: new Date('2026-11-01T00:00:00Z') })
    const nueva = promo({ id: 'nueva', createdAt: new Date('2026-11-05T00:00:00Z') })
    expect(evaluarPromo([vieja, nueva], venta())?.promotionId).toBe('nueva')
    expect(evaluarPromo([nueva, vieja], venta())?.promotionId).toBe('nueva')
  })
})

describe('sellosConPromo', () => {
  const dec = (o: Partial<PromoDecidida>): PromoDecidida => ({
    promotionId: 'p1',
    name: 'x',
    kind: 'MULTIPLY',
    multiplier: null,
    extraStamps: null,
    extraPoints: null,
    montoQueCalifica: D(0),
    ...o,
  })
  it('×3 = 3, ADD +1 = 2, null = 1', () => {
    expect(sellosConPromo(dec({ multiplier: 3 }))).toBe(3)
    expect(sellosConPromo(dec({ kind: 'ADD', extraStamps: 1 }))).toBe(2)
    expect(sellosConPromo(null)).toBe(1)
  })

  it('puntosConPromo monto 100, ppd 1, bono 10, ×2 → total 220, bonusPoints 110, visitBonusPoints 20', () => {
    const d = dec({ multiplier: 2, montoQueCalifica: D(100) })
    expect(puntosConPromo({ total: 110, bono: 10, pointsPerDollar: 1 }, d)).toEqual({
      total: 220,
      bonusPoints: 110,
      visitBonusPoints: 20,
    })
  })

  it('MULTIPLY: floor de lo que califica antes de multiplicar (30.6 ×3 → 60, no 61)', () => {
    const d = dec({ multiplier: 3, montoQueCalifica: D('30.6') })
    expect(puntosConPromo({ total: 30, bono: 0, pointsPerDollar: 1 }, d).bonusPoints).toBe(60)
  })

  it('sin filtro, total = multiplicador × total base', () => {
    const d = evaluarPromo([promo({ multiplier: 3 })], venta({ amount: 30.6, lineas: [] }))!
    expect(puntosConPromo({ total: 40, bono: 10, pointsPerDollar: 1 }, d).total).toBe(120)
    expect(puntosConPromo({ total: 30, bono: 0, pointsPerDollar: 1 }, d).total).toBe(90)
  })

  it('ADD sólo extraStamps → 0 puntos extra; sólo extraPoints → 1 sello', () => {
    const s = dec({ kind: 'ADD', extraStamps: 2 })
    expect(sellosConPromo(s)).toBe(3)
    expect(puntosConPromo({ total: 10, bono: 0, pointsPerDollar: 1 }, s).bonusPoints).toBe(0)
    expect(sellosConPromo(dec({ kind: 'ADD', extraPoints: 5 }))).toBe(1)
  })

  it('puntosConPromo ADD y null', () => {
    const d = dec({ kind: 'ADD', extraPoints: 5 })
    expect(puntosConPromo({ total: 110, bono: 10, pointsPerDollar: 1 }, d)).toEqual({ total: 115, bonusPoints: 5, visitBonusPoints: 15 })
    expect(puntosConPromo({ total: 110, bono: 10, pointsPerDollar: 1 }, null)).toEqual({ total: 110, bonusPoints: 0, visitBonusPoints: 10 })
  })
})
