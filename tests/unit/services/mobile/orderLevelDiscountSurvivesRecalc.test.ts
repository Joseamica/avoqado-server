/**
 * 🔴 DINERO. El descuento de CUENTA que el cajero puso al crear la venta tiene que
 * sobrevivir a cualquier recálculo posterior de la orden.
 *
 * El POS manda ese descuento como un número suelto (`discount`, centavos) al crear la
 * orden. Antes `createOrderWithItems` lo guardaba SÓLO en la cabecera (`Order.discountAmount`),
 * y `recalculateOrderTotals` reconstruye la cabecera desde las filas `OrderDiscount`
 * (el número suelto sólo cuenta cuando NO hay ninguna fila). En cuanto alguien agregaba
 * una fila —el premio de la cartilla al crear la venta, otro descuento después— el
 * descuento de cuenta desaparecía: la orden decía que el cliente debía MÁS de lo que el
 * negocio quiso cobrarle.
 *
 * Estas pruebas NO miden `Order.total`, porque su relación con la propina es otra pregunta:
 * el founder decidió no tocarla todavía (2026-09-27), así que se conserva la de hoy por
 * camino — la venta nueva guarda el total CON propina y los recálculos posteriores SIN
 * ella. Miden lo que no depende de eso: el descuento guardado y si la cuenta cierra cuando
 * el cliente paga lo que el negocio le quiso cobrar (`computeOrderBalance`, el mismo
 * cálculo que usa el cobro).
 *
 * La base es un doble EN MEMORIA con estado (no respuestas enlatadas): la creación, el
 * canje y el recálculo reales escriben y leen las mismas filas, que es donde vive el
 * defecto.
 *
 * Arreglado en el bloque B2 (1-oct): el descuento de cuenta es su propia fila `OrderDiscount`.
 * El defecto se reprodujo en rojo el 2026-09-27 (descuento guardado 30 en vez de 50, y 10 en
 * vez de 30); las dos pruebas 🔴 iban con `it.failing` y B2 las volteó a `it`. Si el doble se
 * rompiera, las pruebas de regresión —mismo doble, en verde— lo delatan.
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

import { applyOrderDiscount, createOrderWithItems } from '@/services/mobile/order.mobile.service'
import { computeOrderBalance } from '@/services/shared/orderBalance'
import { prismaMock } from '../../../__helpers__/setup'

type Fila = Record<string, any>

const VENUE = 'venue-1'
const CLIENTE = 'cliente-1'
const PREMIO = 'premio-1'
const DESCUENTO_10 = 'descuento-10'

/** Prisma.Decimal → número; lo demás tal cual. */
const aNumero = (v: any) => (v && typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : v)

/** Igualdad simple sobre las llaves del `where`. Un operador (`in`, `gt`…) truena: el doble no finge soportarlo. */
function coincide(fila: Fila, where: Fila = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      throw new Error(`doble en memoria: operador no soportado en where.${k}`)
    }
    return fila[k] === v
  })
}

function baseEnMemoria() {
  const ordenes = new Map<string, Fila>()
  const renglones: Fila[] = []
  const descuentos: Fila[] = []
  const premios: Fila[] = []
  let seq = 0
  const nuevoId = (p: string) => `${p}-${++seq}`
  const plano = (o: Fila) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, aNumero(v)]))
  const conRenglones = (o: Fila) => ({
    ...o,
    items: renglones.filter(r => r.orderId === o.id).map(r => ({ ...r, product: null, modifiers: [] })),
    promotions: [],
  })

  const buscarOrden = async ({ where }: any) => {
    if (where.venueId_externalId) return null
    const o = ordenes.get(where.id)
    return o && (!where.venueId || o.venueId === where.venueId) ? conRenglones(o) : null
  }
  prismaMock.order.findUnique.mockImplementation(buscarOrden)
  prismaMock.order.findFirst.mockImplementation(buscarOrden)
  prismaMock.order.create.mockImplementation(async ({ data }: any) => {
    const { items, ...cabecera } = data
    delete cabecera.orderCustomers
    const o = { id: nuevoId('orden'), paidAmount: 0, serviceChargeAmount: 0, ...plano(cabecera) }
    ordenes.set(o.id, o)
    for (const r of items?.create ?? []) renglones.push({ id: nuevoId('renglon'), orderId: o.id, orderPromotionId: null, ...plano(r) })
    return conRenglones(o)
  })
  prismaMock.order.update.mockImplementation(async ({ where, data }: any) => {
    const o = ordenes.get(where.id)
    if (!o) throw new Error(`doble en memoria: no existe la orden ${where.id}`)
    for (const [k, v] of Object.entries(data as Fila)) {
      o[k] = k === 'version' && typeof v === 'object' ? (o.version ?? 0) + v.increment : aNumero(v)
    }
    return conRenglones(o)
  })
  // El candado de la orden (`lockExistingOrderForPayment`) es un SELECT … FOR UPDATE crudo.
  prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...valores: any[]) => {
    if (!strings.join('?').includes('FOR UPDATE')) throw new Error('doble en memoria: $queryRaw no soportado')
    const [orderId, venueId] = valores
    const o = ordenes.get(orderId)
    return o && o.venueId === venueId ? [{ id: orderId }] : []
  })

  prismaMock.orderItem.findMany.mockImplementation(async ({ where }: any) => renglones.filter(r => coincide(r, where)))
  prismaMock.orderServiceCharge.findMany.mockResolvedValue([])

  prismaMock.orderDiscount.findMany.mockImplementation(async ({ where }: any) => descuentos.filter(d => coincide(d, where)))
  prismaMock.orderDiscount.findFirst.mockImplementation(async ({ where }: any) => descuentos.find(d => coincide(d, where)) ?? null)
  prismaMock.orderDiscount.create.mockImplementation(async ({ data }: any) => {
    const fila = { id: nuevoId('od'), appliedToItemIds: [], discountId: null, ...plano(data) }
    descuentos.push(fila)
    return fila
  })
  prismaMock.orderDiscount.update.mockImplementation(async ({ where, data }: any) => {
    const fila = descuentos.find(d => d.id === where.id)
    Object.assign(fila!, plano(data))
    return fila
  })

  prismaMock.stampReward.findFirst.mockImplementation(async ({ where }: any) => premios.find(p => coincide(p, where)) ?? null)
  prismaMock.stampReward.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hits = premios.filter(p => coincide(p, where))
    hits.forEach(p => Object.assign(p, data))
    return { count: hits.length }
  })
  prismaMock.stampReward.update.mockImplementation(async ({ where, data }: any) => {
    const p = premios.find(x => x.id === where.id)
    Object.assign(p!, data)
    return p
  })

  prismaMock.venue.findUnique.mockResolvedValue({ id: VENUE, name: 'Café de prueba', salesEnabled: true })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE, active: true, staff: {} })
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.customer.findUnique.mockResolvedValue({ id: CLIENTE, venueId: VENUE, firstName: 'Ana', lastName: 'López', phone: null })
  prismaMock.discount.findFirst.mockImplementation(async ({ where }: any) =>
    where.id === DESCUENTO_10 && where.venueId === VENUE
      ? { id: DESCUENTO_10, venueId: VENUE, name: '10% cliente frecuente', type: 'PERCENTAGE', value: 10, scope: 'ORDER', active: true }
      : null,
  )

  premios.push({
    id: PREMIO,
    stampCardId: 'cartilla-1',
    venueId: VENUE,
    customerId: CLIENTE,
    status: 'PENDING',
    rewardType: 'FIXED_AMOUNT',
    rewardValue: 30,
    rewardProductId: null,
    rewardLabel: '$30 de premio',
    expiresAt: null,
    orderDiscountId: null,
  })

  return { orden: (id: string) => ordenes.get(id)!, descuentosDe: (orderId: string) => descuentos.filter(d => d.orderId === orderId) }
}

/** Una venta de $100 en una sola línea «Otro importe», con propina de $5. */
const venta = (extra: Fila = {}) =>
  ({
    staffId: 'staff-1',
    items: [{ name: 'Otro importe', quantity: 1, unitPrice: 10000 }],
    tip: 500,
    ...extra,
  }) as any

/** ¿La cuenta queda PAGADA si el cliente paga `mercancia` + `propina` (pesos)? El mismo cálculo que usa el cobro. */
function cierraCon(orden: Fila, mercancia: number, propina: number) {
  return computeOrderBalance(orden as any, [{ amount: mercancia, tipAmount: propina, type: 'REGULAR' }])
}

// Cada escenario va en DOS pruebas: una normal que exige que el escenario de verdad ocurrió
// (si el doble o la venta se rompen, truena en rojo) y la 🔴 que sólo lee su resultado. Así
// la 🔴 no se confunde con algo AJENO que tronó antes de llegar al descuento — medido, cuando
// iba con `it.failing`: una columna nueva de otra sesión la hizo pasar en falso.
describe('el descuento de CUENTA sobrevive a los recálculos de la orden', () => {
  describe('premio de la cartilla canjeado al crear la venta', () => {
    let db: ReturnType<typeof baseEnMemoria>
    let ordenId: string

    beforeAll(() => {
      db = baseEnMemoria()
    })

    it('la venta nace con el descuento de cuenta y el premio aplicado', async () => {
      const creada = await createOrderWithItems(VENUE, venta({ discount: 2000, customerId: CLIENTE, stampRewardId: PREMIO }))

      expect((creada as any).stampReward).toEqual(expect.objectContaining({ applied: true, discountAmount: 30 }))
      ordenId = creada.id
    })

    it('🔴 el premio NO borra el descuento de cuenta', () => {
      // $100 − $20 de descuento de cuenta − $30 de premio = $50 de mercancía (+ $5 de propina aparte).
      const orden = db.orden(ordenId)
      expect(orden.discountAmount).toBe(50)
      // Lo que el cajero cobra según su carrito cierra la cuenta, sin saldo fantasma.
      const saldo = cierraCon(orden, 50, 5)
      expect(saldo.remainingBalance.toNumber()).toBe(0)
      expect(saldo.isFullyPaid).toBe(true)
      // B2: el premio FIJO es una fila de CUENTA con promociones, repartida por el recálculo de su canje.
      const premio = db.descuentosDe(ordenId).find(d => d.name === '$30 de premio')
      expect(premio?.reparto).toMatchObject({ alcance: 'CUENTA', conPromociones: true, renglones: { 'renglon-2': 3000 } })
    })
  })

  describe('otro descuento aplicado después', () => {
    let db: ReturnType<typeof baseEnMemoria>
    let ordenId: string

    beforeAll(() => {
      db = baseEnMemoria()
    })

    it('el segundo descuento se aplica sobre la venta con descuento de cuenta', async () => {
      const creada = await createOrderWithItems(VENUE, venta({ discount: 2000 }))
      const aplicado = await applyOrderDiscount(VENUE, creada.id, DESCUENTO_10, 'staff-1')

      expect(aplicado.amount).toBe(10)
      ordenId = creada.id
    })

    it('🔴 el segundo descuento NO borra el descuento de cuenta', () => {
      // $100 − $20 de cuenta − 10% ($10, sobre la mercancía) = $70 de mercancía.
      const orden = db.orden(ordenId)
      expect(orden.discountAmount).toBe(30)
      const saldo = cierraCon(orden, 70, 5)
      expect(saldo.remainingBalance.toNumber()).toBe(0)
      expect(saldo.isFullyPaid).toBe(true)
    })
  })

  // ── Regresión: lo que hoy funciona tiene que seguir igual ────────────────────
  it('sin descuento de cuenta, el premio baja la cuenta como hoy', async () => {
    const db = baseEnMemoria()
    const creada = await createOrderWithItems(VENUE, venta({ customerId: CLIENTE, stampRewardId: PREMIO }))

    const orden = db.orden(creada.id)
    expect(orden.discountAmount).toBe(30)
    expect(cierraCon(orden, 70, 5).isFullyPaid).toBe(true)
  })

  it('sin nada más que el descuento de cuenta, la venta nace como hoy', async () => {
    const db = baseEnMemoria()
    const creada = await createOrderWithItems(VENUE, venta({ discount: 2000 }))

    const orden = db.orden(creada.id)
    expect(orden.discountAmount).toBe(20)
    expect(cierraCon(orden, 80, 5).isFullyPaid).toBe(true)
  })
})

describe('el descuento de cuenta es su propia fila, con su reparto', () => {
  it('nace como fila FIJA de CUENTA y queda repartida sobre la venta', async () => {
    const db = baseEnMemoria()
    const creada = await createOrderWithItems(VENUE, venta({ discount: 2000 }))
    const [fila] = db.descuentosDe(creada.id)
    expect(fila).toMatchObject({ type: 'FIXED_AMOUNT', name: 'Descuento de la cuenta', amount: 20, isManual: true, appliedById: 'sv-1' })
    expect(fila.reparto).toEqual({ v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { 'renglon-2': 2000 } })
    expect(db.orden(creada.id).discountAmount).toBe(20) // cabecera de hoy
  })
  it('un % aplicado después toma la regla del recálculo; la fila de cuenta conserva la suya, sin pasar la capacidad', async () => {
    const db = baseEnMemoria()
    const creada = await createOrderWithItems(VENUE, venta({ discount: 2000 }))
    await applyOrderDiscount(VENUE, creada.id, DESCUENTO_10, 'staff-1')
    const [cuenta, diez] = db.descuentosDe(creada.id)
    expect(cuenta.reparto).toMatchObject({ alcance: 'CUENTA', conPromociones: true, renglones: { 'renglon-2': 2000 } })
    expect(diez).toMatchObject({ amount: 10, reparto: { alcance: 'CUENTA', conPromociones: false, renglones: { 'renglon-2': 1000 } } })
  })
  it('sin descuento de cuenta no se crea ninguna fila (regresión)', async () => {
    const db = baseEnMemoria()
    const creada = await createOrderWithItems(VENUE, venta())
    expect(db.descuentosDe(creada.id)).toEqual([])
  })
})
