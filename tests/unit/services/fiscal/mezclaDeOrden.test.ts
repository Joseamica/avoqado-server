/**
 * IVA por producto, bloque B4b (spec planes 6-7 §4.9, D17): la composición de una orden con la MISMA reconstrucción de montos que la
 * factura (§4.2). Puro. La última prueba compara contra `reconstruirConceptos` (bloque B3a, antes del centavo que mueve su Tarea 6b).
 */
// `cfdi.service` (sólo para la prueba de propiedad) importa Prisma y el logger al cargar: se les da un doble, como en
// `cfdiConceptosPorTratamiento.test.ts`.
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn() },
    merchantFiscalConfig: { findUnique: jest.fn() },
    fiscalEmisor: { findMany: jest.fn().mockResolvedValue([]) },
  },
}))
jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import { importeConceptoCents, reconstruirConceptos, renglonConTratamiento } from '../../../../src/services/fiscal/cfdi.service'
import { desglosePorTratamiento } from '../../../../src/services/fiscal/ivaMath'
import { mezclaDeLaOrden, mezclaPorTratamiento, type RenglonDeMezcla } from '../../../../src/services/fiscal/mezclaDeOrden'
import { D, orden, producto, renglon } from './fixtures/ivaPorProductoGoldenOrders'

/** Café al 16 % de $116; `o` cambia lo que haga falta. */
const L = (o: Record<string, unknown> = {}): RenglonDeMezcla => ({
  id: 'oi-cafe',
  quantity: 1,
  unitPrice: 116,
  total: 116,
  discountAmount: 0,
  orderPromotionId: null,
  isCortesia: false,
  ivaTratamiento: null,
  product: { taxRate: 0.16, ivaTratamiento: 'IVA_16' as const },
  ...o,
})
/** Grano al 0 % de $100. */
const G = (o: Record<string, unknown> = {}) =>
  L({ id: 'oi-grano', unitPrice: 100, total: 100, product: { taxRate: 0, ivaTratamiento: 'IVA_0' }, ...o })
const cuenta = (renglones: Record<string, number>) => ({ v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones })
const dirigido = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones })
const espejo = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones })
const CAFE = { tratamiento: 'IVA_16', tasa: 0.16 } as const
const GRANO = { tratamiento: 'IVA_0', tasa: 0 } as const

describe('B4b · cada renglón pesa lo que cobró (H12: extras, peso, promociones y cortesías)', () => {
  it('🔴 el extra cuenta: el grano de $50 con $50 de extra pesa 10000, no 5000', () => {
    expect(mezclaPorTratamiento([L(), G({ unitPrice: 50, total: 100 })])).toEqual([
      { ...CAFE, grossCents: 11600 },
      { ...GRANO, grossCents: 10000 },
    ])
  })

  it('🔴 la venta por peso pesa su total (400 $/kg × 0.5 kg = 200), no el precio por kilo', () => {
    expect(mezclaPorTratamiento([L(), G({ unitPrice: 400, weightQuantity: 0.5, total: 200 })])).toEqual([
      { ...CAFE, grossCents: 11600 },
      { ...GRANO, grossCents: 20000 },
    ])
  })

  it('🔴 un descuento de artículo sobre un renglón con extras: total − descuento (6000), no precio − descuento (5500)', () => {
    expect(mezclaPorTratamiento([G({ unitPrice: 65, total: 70, discountAmount: 10 })])).toEqual([{ ...GRANO, grossCents: 6000 }])
  })

  it('🔴 una promoción regalada después en la terminal (total 80, descuento 80, cortesía) no pesa', () => {
    expect(mezclaPorTratamiento([L(), G({ total: 80, discountAmount: 80, orderPromotionId: 'op1', isCortesia: true })])).toEqual([
      { ...CAFE, grossCents: 11600 },
    ])
  })

  it('🔴 los renglones salen con lo que pesa cada uno (el libro los usa para las devoluciones por artículos)', () => {
    expect(mezclaDeLaOrden([L(), G({ unitPrice: 50, total: 100 })]).renglones).toEqual([
      { llave: 'oi-cafe', ...CAFE, cantidad: 1, cents: 11600 },
      { llave: 'oi-grano', ...GRANO, cantidad: 1, cents: 10000 },
    ])
  })

  it('control: una promoción pesa su total, que ya es neto (80)', () => {
    expect(mezclaPorTratamiento([G({ total: 80, discountAmount: 20, orderPromotionId: 'op1' })])).toEqual([{ ...GRANO, grossCents: 8000 }])
  })

  it('control: la cortesía del móvil (total 0) no pesa', () => {
    expect(mezclaPorTratamiento([L(), G({ unitPrice: 45, total: 0, discountAmount: 45, isCortesia: true })])).toEqual([
      { ...CAFE, grossCents: 11600 },
    ])
  })

  it('control: sin `total` (entrada armada a mano), el importe de siempre: precio × cantidad − descuento', () => {
    expect(mezclaPorTratamiento([L({ total: undefined, unitPrice: 50, quantity: 2, discountAmount: 10 })])).toEqual([
      { ...CAFE, grossCents: 9000 },
    ])
  })
})

describe('B4b · los descuentos de la cuenta (D7: lo guardado se respeta; D8: lo que no consta)', () => {
  it('🔴 un descuento guardado sobre el grano al 0 % sólo baja el 0 %', () => {
    const c = mezclaDeLaOrden([L(), G()], { discountAmount: 20, orderDiscounts: [{ amount: 20, reparto: dirigido({ 'oi-grano': 2000 }) }] })
    expect(c.mezcla).toEqual([
      { ...CAFE, grossCents: 11600 },
      { ...GRANO, grossCents: 8000 },
    ])
    expect(c.aproximada).toBe(false)
  })

  it('🔴 un reparto de cuenta se LEE tal cual, aunque no sea proporcional (700 / 300)', () => {
    expect(
      mezclaDeLaOrden([L(), G()], {
        discountAmount: 10,
        orderDiscounts: [{ amount: 10, reparto: cuenta({ 'oi-cafe': 700, 'oi-grano': 300 }) }],
      }).mezcla,
    ).toEqual([
      { ...CAFE, grossCents: 10900 },
      { ...GRANO, grossCents: 9700 },
    ])
  })

  it('🔴 Codex r1 P1 #3 · lo guardado ($20 al grano) se respeta aunque haya $10 sin reparto; sólo esos $10 se aproximan', () => {
    const c = mezclaDeLaOrden([L(), G()], {
      discountAmount: 30,
      orderDiscounts: [
        { amount: 20, reparto: dirigido({ 'oi-grano': 2000 }) },
        { amount: 10, reparto: null },
      ],
    })
    // Los $10 sin reparto no se restan de nadie: el cobro se reparte con estos pesos, que es repartirlos en proporción.
    expect(c.mezcla).toEqual([
      { ...CAFE, grossCents: 11600 },
      { ...GRANO, grossCents: 8000 },
    ])
    expect(c.aproximada).toBe(true)
  })

  it('control: una fila espejo no cuenta dos veces: el descuento del pan ya vive en su renglón', () => {
    const c = mezclaDeLaOrden([L({ id: 'oi-pan', unitPrice: 100, total: 100, discountAmount: 20 }), G()], {
      discountAmount: 20,
      orderDiscounts: [{ amount: 20, reparto: espejo({ 'oi-pan': 2000 }) }],
    })
    expect(c.mezcla).toEqual([
      { ...CAFE, grossCents: 8000 },
      { ...GRANO, grossCents: 10000 },
    ])
    expect(c.aproximada).toBe(false)
  })

  it('sin reparto y un solo IVA: D8 reparte en proporción, como la factura, y no es aproximada', () => {
    const c = mezclaDeLaOrden([L(), L({ id: 'oi-pan', unitPrice: 58, total: 58 })], {
      discountAmount: 17.4,
      orderDiscounts: [{ amount: 17.4, reparto: null }],
    })
    expect(c.mezcla).toEqual([{ ...CAFE, grossCents: 15660 }])
    expect(c.aproximada).toBe(false)
  })

  it('🔴 Tarea 1 · un reparto sobre un renglón que ya no cobra no borra lo demás que consta: el grano baja sus $20 y es aproximada', () => {
    const c = mezclaDeLaOrden([L(), G()], {
      discountAmount: 25,
      orderDiscounts: [
        { amount: 20, reparto: dirigido({ 'oi-grano': 2000 }) },
        { amount: 5, reparto: cuenta({ 'oi-borrado': 500 }) },
      ],
    })
    expect(c.mezcla).toEqual([
      { ...CAFE, grossCents: 11600 },
      { ...GRANO, grossCents: 8000 },
    ])
    expect(c.aproximada).toBe(true)
  })

  it('🔴 Review Focus 3 · sin reparto e IVA mezclado: se reparte en proporción y se marca aproximada', () => {
    const c = mezclaDeLaOrden([L(), G()], { discountAmount: 21.6, orderDiscounts: [{ amount: 21.6, reparto: null }] })
    expect(c.mezcla).toEqual([
      { ...CAFE, grossCents: 11600 },
      { ...GRANO, grossCents: 10000 },
    ])
    expect(c.aproximada).toBe(true)
  })

  it('un renglón roto (descuento mayor que su total) no pesa y, con varios IVA, la composición es aproximada', () => {
    const c = mezclaDeLaOrden([L(), G({ total: 30, discountAmount: 50 })])
    expect(c.mezcla).toEqual([{ ...CAFE, grossCents: 11600 }])
    expect(c.aproximada).toBe(true)
  })

  it('🔴 con un solo IVA, un renglón roto no pesa y no hace aproximada la composición (repartir dentro de una tasa no mueve impuesto)', () => {
    const c = mezclaDeLaOrden([L(), L({ id: 'oi-pan', total: 30, discountAmount: 50 })])
    expect(c.mezcla).toEqual([{ ...CAFE, grossCents: 11600 }])
    expect(c.aproximada).toBe(false)
  })

  // T2-I1 (revisión de la Tarea 2): si lo único que había se recorta a 0, la mezcla queda VACÍA y abajo el cobro cae al 16 % como si
  // fuera exacto. Desconocido ≠ exacto: una mezcla vacía por un dato roto es aproximada aunque haya una sola tasa.
  it('🔴 T2-I1 · un solo renglón al 0 % y roto (descuento mayor que su total): la mezcla queda vacía y es aproximada, no exacta', () => {
    const c = mezclaDeLaOrden([G({ total: 30, discountAmount: 50 })])
    expect(c.mezcla).toEqual([])
    expect(c.aproximada).toBe(true)
  })

  it('control · T2-I1 · una orden que de verdad no cobró nada (todo en 0) tiene la mezcla vacía y sigue siendo exacta', () => {
    const c = mezclaDeLaOrden([G({ total: 0, discountAmount: 0 })])
    expect(c.mezcla).toEqual([])
    expect(c.aproximada).toBe(false)
  })

  // Desviación declarada del implementador (Desconocido ≠ exacto): la factura se detiene con «el descuento es mayor que el importe del
  // renglón»; el reporte no resta de más (el renglón queda en 0) y, con varios IVA, lo de más no se puede atribuir.
  it('🔴 un reparto que pasa de su renglón ($150 al grano de $100) no lo deja negativo y, con varios IVA, la composición es aproximada', () => {
    const c = mezclaDeLaOrden([L(), G()], {
      discountAmount: 150,
      orderDiscounts: [{ amount: 150, reparto: dirigido({ 'oi-grano': 15000 }) }],
    })
    expect(c.mezcla).toEqual([{ ...CAFE, grossCents: 11600 }])
    expect(c.aproximada).toBe(true)
  })

  it('🔴 T2-I1 · un reparto que pasa de su ÚNICO renglón ($150 al grano de $100): la mezcla queda vacía y es aproximada, no exacta', () => {
    const c = mezclaDeLaOrden([G()], {
      discountAmount: 150,
      orderDiscounts: [{ amount: 150, reparto: dirigido({ 'oi-grano': 15000 }) }],
    })
    expect(c.mezcla).toEqual([])
    expect(c.aproximada).toBe(true)
  })
})

describe('B4b · el IVA aparte según el origen del dato (Codex r1 P1 #5; r2 N5, N10)', () => {
  // Control (Codex r2 N10): con el cuerpo neutro ya pasa —no multiplica y pesa igual—. Lo que muerde es su sabotaje (d), multiplicar
  // por 1 + tasa.
  it('control · Review Focus 5 · importada de SoftRestaurant: sus renglones ya traen el impuesto, se leen tal cual y es exacta', () => {
    const c = mezclaDeLaOrden([L(), G()], { contratoDePrecio: 'IVA_APARTE', originSystem: 'POS_SOFTRESTAURANT' })
    expect(c.mezcla).toEqual([
      { ...CAFE, grossCents: 11600 },
      { ...GRANO, grossCents: 10000 },
    ])
    expect(c.aproximada).toBe(false)
    // Cobrados $216: IVA $16 y base al 0 % de $100 (multiplicar por 1 + tasa daba $17.09 y $92.09).
    expect(desglosePorTratamiento(21600, c.mezcla).porTratamiento).toEqual({
      IVA_16: { baseCents: 10000, ivaCents: 1600 },
      IVA_0: { baseCents: 10000, ivaCents: 0 },
    })
  })

  it('🔴 «IVA aparte» de otro origen con dos IVA: no se multiplica nada y se marca aproximada', () => {
    const c = mezclaDeLaOrden([L({ unitPrice: 100, total: 100 }), G()], { contratoDePrecio: 'IVA_APARTE', originSystem: 'AVOQADO' })
    expect(c.mezcla).toEqual([
      { ...CAFE, grossCents: 10000 },
      { ...GRANO, grossCents: 10000 },
    ])
    expect(c.aproximada).toBe(true)
  })

  it('🔴 Codex r2 N5 · «IVA aparte» de otro origen es aproximada aunque haya un solo IVA: no se sabe cuánto impuesto se cobró', () => {
    // Base $100 + $16 aparte y un descuento manual de $20 que no baja el impuesto (discountEngine.service.ts:1372): se cobran $96, y
    // el reparto sacaría IVA $13.24 aunque se cobraron $16 de impuesto.
    const c = mezclaDeLaOrden([L({ unitPrice: 100, total: 100 })], {
      contratoDePrecio: 'IVA_APARTE',
      originSystem: 'AVOQADO',
      discountAmount: 20,
      orderDiscounts: [{ amount: 20, reparto: null }],
    })
    expect(c.aproximada).toBe(true)
  })

  it('control: importada de SoftRestaurant con un solo IVA es exacta', () => {
    expect(mezclaDeLaOrden([L()], { contratoDePrecio: 'IVA_APARTE', originSystem: 'POS_SOFTRESTAURANT' }).aproximada).toBe(false)
  })
})

describe('B4b · D17: un solo cálculo — la composición es lo que la factura pone en cada tasa', () => {
  it('🔴 extras, descuento de artículo con su espejo, promoción, cortesía y un descuento de cuenta guardado: mismas cifras por tratamiento', () => {
    const cafe = renglon({
      id: 'oi-cafe',
      productName: 'CAPUCCINO',
      unitPrice: D(65),
      total: D(70),
      discountAmount: D(5),
      modifiers: [{ name: 'Deslactosada', price: D(5), quantity: 1 }],
      product: producto({ name: 'CAPUCCINO' }),
    })
    const grano = renglon({
      id: 'oi-grano',
      productName: 'Grano',
      unitPrice: D(100),
      total: D(100),
      product: producto({ name: 'Grano', ivaTratamiento: 'IVA_0', taxRate: D(0) }),
    })
    const combo = renglon({
      id: 'oi-combo',
      productName: 'Combo',
      unitPrice: D(100),
      total: D(80),
      discountAmount: D(20),
      orderPromotionId: 'op1',
      product: producto({ name: 'Combo' }),
    })
    const regalo = renglon({
      id: 'oi-regalo',
      productName: 'Galleta',
      unitPrice: D(50),
      total: D(50),
      discountAmount: D(50),
      isCortesia: true,
      product: producto({ name: 'Galleta' }),
    })
    const filas = [
      { amount: D(5), reparto: espejo({ 'oi-cafe': 500 }) },
      { amount: D(50), reparto: espejo({ 'oi-regalo': 5000 }) },
      { amount: D(10), reparto: cuenta({ 'oi-cafe': 300, 'oi-grano': 500, 'oi-combo': 200 }) },
    ]
    // Los renglones del fixture traen `product: Record<string, any>`: se tipan sueltos para que sirvan a la factura y a la composición.
    const items: any[] = [cafe, grano, combo, regalo]
    const pedido = orden(235, { discountAmount: D(65), orderDiscounts: filas, items })

    const factura = reconstruirConceptos({ ...pedido, items: items.map(renglonConTratamiento) }, 'o1')
    expect(factura.motivos).toEqual([]) // si la factura no sale, la comparación no prueba nada: se corrige el fixture, no el código
    const enLaFactura: Record<string, number> = {}
    for (const c of factura.items) {
      const t = String(c.tratamiento)
      enLaFactura[t] = (enLaFactura[t] ?? 0) + importeConceptoCents(c) - Math.round(Number(c.discountAmount) * 100)
    }

    const comp = mezclaDeLaOrden(items, {
      discountAmount: pedido.discountAmount,
      contratoDePrecio: pedido.contratoDePrecio,
      orderDiscounts: filas,
    })
    expect(comp.aproximada).toBe(false)
    expect(Object.fromEntries(comp.mezcla.map(m => [m.tratamiento, m.grossCents]))).toEqual(enLaFactura)
    // A mano: café 70 − 5 − 3 = 62 · combo 80 − 2 = 78 ⇒ 16 %: 140 · grano 100 − 5 = 95 ⇒ 0 %: 95 · galleta regalada: nada.
    expect(enLaFactura).toEqual({ IVA_16: 14000, IVA_0: 9500 })
  })
})
