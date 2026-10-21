/**
 * C2 A-1 (decisión A del founder, 9-oct): lo que cobró cada renglón, para el DINERO de una devolución por artículos.
 * Misma composición que `mezclaDeLaOrden` (A-R1) salvo D8: con varios IVA se reparte en proporción sobre todos los renglones vivos.
 * A-R3: lo que no se puede atribuir no se adivina. Y el cargador único de una orden, con sus topes.
 */
import { Decimal } from '@prisma/client/runtime/library'
import { cobradoPorRenglon, mezclaDeLaOrden, type RenglonDeMezcla } from '../../../../src/services/fiscal/mezclaDeOrden'
import { NO_SE_PUEDE_POR_ARTICULOS, chargedTotalDe, leerCobradoDeLaOrden } from '../../../../src/services/fiscal/cobradoDeLaOrden'
import { TOPES_POR_ORDEN } from '../../../../src/services/fiscal/librosDeOrdenes'

/** Un renglón al 16 % de $100; `o` cambia lo que haga falta. */
const R = (id: string, o: Record<string, unknown> = {}): RenglonDeMezcla => ({
  id,
  quantity: 1,
  unitPrice: 100,
  total: 100,
  discountAmount: 0,
  orderPromotionId: null,
  isCortesia: false,
  ivaTratamiento: null,
  product: { taxRate: 0.16, ivaTratamiento: 'IVA_16' as const },
  ...o,
})
/** Grano al 0 %. */
const G = (id: string, o: Record<string, unknown> = {}) => R(id, { product: { taxRate: 0, ivaTratamiento: 'IVA_0' }, ...o })
const cuenta = (renglones: Record<string, number>) => ({ v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones })
const dirigido = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones })
const espejo = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones })
const cents = (c: { renglones: Array<{ llave: string; cents: number }> }) => Object.fromEntries(c.renglones.map(r => [r.llave, r.cents]))

describe('C2 A-R1 · lo que cobró cada renglón (el dinero de una devolución por artículos)', () => {
  it('control — sin descuentos, cada renglón cobró su total (con extras y peso)', () => {
    const c = cobradoPorRenglon([R('a'), R('b', { unitPrice: 50, total: 50 })], { discountAmount: 0, orderDiscounts: [] })
    expect(c).toMatchObject({ atribuible: true })
    expect(cents(c)).toEqual({ a: 10000, b: 5000 })
  })

  it('🔴 E2 · descuento propio del renglón: A $100 −$10 + B $50 ⇒ A cobró $90', () => {
    const c = cobradoPorRenglon([R('a', { discountAmount: 10 }), R('b', { unitPrice: 50, total: 50 })], {
      discountAmount: 10,
      orderDiscounts: [{ amount: 10, reparto: espejo({ a: 1000 }) }],
    })
    expect(c.atribuible).toBe(true)
    expect(cents(c)).toEqual({ a: 9000, b: 5000 })
  })

  it('🔴 E3 · descuento de cuenta con reparto D7 10/10: A $100 + B $100 −$20 ⇒ A cobró $90', () => {
    const c = cobradoPorRenglon([R('a'), R('b')], {
      discountAmount: 20,
      orderDiscounts: [{ amount: 20, reparto: cuenta({ a: 1000, b: 1000 }) }],
    })
    expect(cents(c)).toEqual({ a: 9000, b: 9000 })
  })

  it('🔴 E3 · descuento dirigido 100 % a A ⇒ A cobró $80 y B $100', () => {
    const c = cobradoPorRenglon([R('a'), R('b')], { discountAmount: 20, orderDiscounts: [{ amount: 20, reparto: dirigido({ a: 2000 }) }] })
    expect(cents(c)).toEqual({ a: 8000, b: 10000 })
  })

  it('🔴 D8 sin reparto con UN IVA: en proporción, igual que mezclaDeLaOrden', () => {
    const items = [R('a'), R('b', { unitPrice: 300, total: 300 })]
    const laCuenta = { discountAmount: 40, orderDiscounts: [{ amount: 40, reparto: null }] }
    const c = cobradoPorRenglon(items, laCuenta)
    expect(cents(c)).toEqual({ a: 9000, b: 27000 })
    expect(cents(c)).toEqual(cents(mezclaDeLaOrden(items, laCuenta)))
  })

  it('🔴 D8 sin reparto con VARIOS IVA: para el dinero se reparte en proporción; la composición fiscal sigue «aproximada»', () => {
    const items = [R('cafe', { unitPrice: 116, total: 116 }), G('grano')]
    const laCuenta = { discountAmount: 21.6, orderDiscounts: [{ amount: 21.6, reparto: null }] }
    const c = cobradoPorRenglon(items, laCuenta)
    expect(c.atribuible).toBe(true)
    expect(cents(c)).toEqual({ cafe: 10440, grano: 9000 })
    // La de la factura y los reportes no cambia: con varios IVA, D8 no se resta de nadie y queda aproximada.
    const m = mezclaDeLaOrden(items, laCuenta)
    expect(cents(m)).toEqual({ cafe: 11600, grano: 10000 })
    expect(m.aproximada).toBe(true)
  })

  it('🔴 E4 · cortesía bruta de la TPV (total $100, descuento $100) cobró $0; lo demás, completo', () => {
    const c = cobradoPorRenglon([R('regalo', { isCortesia: true, discountAmount: 100 }), R('b', { unitPrice: 150, total: 150 })], {
      discountAmount: 100,
      orderDiscounts: [],
    })
    expect(c.atribuible).toBe(true)
    expect(cents(c)).toEqual({ regalo: 0, b: 15000 })
  })

  it('control — cortesía del POS móvil (total 0) cobró $0', () => {
    const c = cobradoPorRenglon([R('regalo', { isCortesia: true, total: 0, discountAmount: 100 }), R('b')], { discountAmount: 0 })
    expect(cents(c)).toEqual({ regalo: 0, b: 10000 })
  })

  it('control — promoción: su total ya es neto (el descuento vive sólo en el renglón)', () => {
    const c = cobradoPorRenglon([R('p1', { orderPromotionId: 'op', total: 80, discountAmount: 20 }), R('b')], { discountAmount: 0 })
    expect(cents(c)).toEqual({ p1: 8000, b: 10000 })
  })

  it('control — venta por peso (cantidad 1) y extras: el total del renglón ya los trae', () => {
    const c = cobradoPorRenglon(
      [R('peso', { unitPrice: 400, weightQuantity: 0.5, total: 200 }), R('extras', { unitPrice: 100, total: 130 })],
      { discountAmount: 0 },
    )
    expect(cents(c)).toEqual({ peso: 20000, extras: 13000 })
  })
})

describe('C2 A-R3 · lo que no se puede atribuir no se adivina', () => {
  it('🔴 un reparto sobre un renglón que ya no cobra (cortesía) ⇒ no atribuible', () => {
    const c = cobradoPorRenglon([R('regalo', { isCortesia: true, total: 0 }), R('b')], {
      discountAmount: 10,
      orderDiscounts: [{ amount: 10, reparto: dirigido({ regalo: 1000 }) }],
    })
    expect(c.atribuible).toBe(false)
  })

  it('🔴 D8 que no cabe (el descuento sin reparto pasa de lo vendido) ⇒ no atribuible', () => {
    const c = cobradoPorRenglon([R('a'), R('b')], { discountAmount: 300, orderDiscounts: [{ amount: 300, reparto: null }] })
    expect(c.atribuible).toBe(false)
  })

  it('🔴 un renglón roto (descuento mayor que su total) ⇒ no atribuible', () => {
    const c = cobradoPorRenglon([R('a', { total: 30, discountAmount: 50 }), R('b')], { discountAmount: 50 })
    expect(c.atribuible).toBe(false)
  })

  it('🔴 un reparto mayor que lo que cobra su renglón ⇒ no atribuible', () => {
    const c = cobradoPorRenglon([R('a'), G('b')], {
      discountAmount: 150,
      orderDiscounts: [{ amount: 150, reparto: dirigido({ b: 15000 }) }],
    })
    expect(c.atribuible).toBe(false)
  })

  it('🔴 descuentos guardados que suman más que la cabecera ⇒ no atribuible', () => {
    const c = cobradoPorRenglon([R('a'), R('b')], { discountAmount: 5, orderDiscounts: [{ amount: 20, reparto: dirigido({ a: 2000 }) }] })
    expect(c.atribuible).toBe(false)
  })
})

/** Una base de mentira con lo que el cargador lee: la cabecera, los renglones y los descuentos (proyectados). */
function db(o: { orden?: unknown; renglones?: unknown[]; descuentos?: unknown[] }) {
  return {
    order: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          o.orden === undefined ? { discountAmount: new Decimal(0), contratoDePrecio: null, originSystem: null } : o.orden,
        ),
    },
    orderItem: { findMany: jest.fn().mockResolvedValue(o.renglones ?? []) },
    $queryRaw: jest.fn().mockResolvedValue(o.descuentos ?? []),
  }
}
const sqlDe = (q: { strings: string[]; values: unknown[] }) => ({ texto: q.strings.join('?'), valores: q.values })

describe('C2 A-1 · el cargador único de lo cobrado de una orden', () => {
  it('🔴 lee la cuenta de la orden y devuelve lo cobrado por id (A $100 −$10 de cuenta dirigido + B $50)', async () => {
    const base = db({
      orden: { discountAmount: new Decimal(10), contratoDePrecio: null, originSystem: null },
      renglones: [R('a'), R('b', { unitPrice: 50, total: 50 })],
      descuentos: [{ id: 'd1', orderId: 'o1', amount: new Decimal(10), reparto: dirigido({ a: 1000 }) }],
    })
    const c = await leerCobradoDeLaOrden(base as any, 'o1')
    expect(c.atribuible).toBe(true)
    expect(c.motivo).toBeNull()
    expect(Object.fromEntries(c.cobradoCents)).toEqual({ a: 9000, b: 5000 })
    expect(chargedTotalDe(c, 'a')).toBe(90)
    expect(chargedTotalDe(c, 'b')).toBe(50)
  })

  it('control — lecturas acotadas: renglones con take = tope + 1 y descuentos de ESA orden con LIMIT = tope + 1, proyectados', async () => {
    const base = db({ renglones: [R('a')] })
    await leerCobradoDeLaOrden(base as any, 'o1')
    expect(base.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: TOPES_POR_ORDEN.renglones + 1, where: { orderId: 'o1' } }),
    )
    const { texto, valores } = sqlDe(base.$queryRaw.mock.calls[0][0])
    expect(texto).toContain('FROM "OrderDiscount"')
    expect(texto).toContain('jsonb_build_object') // REPARTO_FISCAL: el ámbito nunca sale de la base
    expect(texto).toMatch(/LIMIT \?$/)
    expect(valores).toEqual(['o1', TOPES_POR_ORDEN.descuentos + 1])
  })

  it('🔴 orden no encontrada ⇒ no atribuible (no se devuelve por artículos, el campo se omite)', async () => {
    const c = await leerCobradoDeLaOrden(db({ orden: null, renglones: [R('a')] }) as any, 'o1')
    expect(c.atribuible).toBe(false)
    expect(c.motivo).toBe(NO_SE_PUEDE_POR_ARTICULOS.SIN_ORDEN) // M1: la causa real
    expect(chargedTotalDe(c, 'a')).toBeUndefined()
  })

  it('🔴 más renglones que el tope ⇒ no atribuible (no se aproxima)', async () => {
    const muchos = Array.from({ length: TOPES_POR_ORDEN.renglones + 1 }, (_, i) => R(`r${i}`))
    const c = await leerCobradoDeLaOrden(db({ renglones: muchos }) as any, 'o1')
    expect(c.atribuible).toBe(false)
    expect(c.motivo).toBe(NO_SE_PUEDE_POR_ARTICULOS.TOPE)
    expect(c.cobradoCents.size).toBe(0)
  })

  it('🔴 más descuentos que el tope ⇒ no atribuible', async () => {
    const filas = Array.from({ length: TOPES_POR_ORDEN.descuentos + 1 }, (_, i) => ({
      id: `d${i}`,
      orderId: 'o1',
      amount: new Decimal(0),
      reparto: null,
    }))
    const c = await leerCobradoDeLaOrden(db({ renglones: [R('a')], descuentos: filas }) as any, 'o1')
    expect(c.atribuible).toBe(false)
    expect(c.motivo).toBe(NO_SE_PUEDE_POR_ARTICULOS.TOPE)
  })

  it('🔴 una cuenta no atribuible deja el mapa vacío y el campo omitido', async () => {
    const base = db({
      orden: { discountAmount: new Decimal(300), contratoDePrecio: null, originSystem: null },
      renglones: [R('a'), R('b')],
      descuentos: [{ id: 'd1', orderId: 'o1', amount: new Decimal(300), reparto: null }],
    })
    const c = await leerCobradoDeLaOrden(base as any, 'o1')
    expect(c.atribuible).toBe(false)
    expect(c.motivo).toBe(NO_SE_PUEDE_POR_ARTICULOS.DESCUENTOS)
    expect(chargedTotalDe(c, 'a')).toBeUndefined()
  })
})
