/**
 * 🔴 DINERO. El descuento de CUENTA que el cajero puso al crear la venta tiene que
 * sobrevivir a cualquier recálculo posterior de la orden.
 *
 * El POS manda ese descuento como un número suelto (`discount`, centavos) al crear la
 * orden. `createOrderWithItems` lo guarda SÓLO en la cabecera (`Order.discountAmount`),
 * pero `recalculateOrderTotals` reconstruye la cabecera desde las filas `OrderDiscount`
 * y sólo respeta el número suelto cuando NO hay ninguna fila. En cuanto alguien agrega
 * una fila —el premio de la cartilla al crear la venta, otro descuento después— el
 * descuento de cuenta desaparece: la orden dice que el cliente debe MÁS de lo que el
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
 * 🔴 DEFECTO CONOCIDO, reproducido en rojo el 2026-09-27 (descuento guardado 30 en vez de
 * 50, y 10 en vez de 30). Arreglo aprobado por el founder: el descuento de cuenta se guarda
 * como su propio renglón `OrderDiscount`. Espera a que aterrice la rama `iva-por-producto`,
 * que reescribe estos mismos escritores. Mientras tanto las dos pruebas 🔴 van con
 * `it.failing`: PASAN mientras el defecto exista (así no ensucian la suite de las demás
 * sesiones) y TRUENAN el día que desaparezca. El cambio que lo arregle las voltea a `it`
 * en el mismo commit. Si el doble se rompiera, las pruebas de regresión —mismo doble, en
 * verde— lo delatan.
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

  return { orden: (id: string) => ordenes.get(id)! }
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
// (si el doble o la venta se rompen, truena en rojo) y la `it.failing` que sólo lee su
// resultado. Así `it.failing` no puede «pasar» porque algo AJENO tronó antes de llegar al
// descuento — medido: una columna nueva de otra sesión lo hizo pasar en falso.
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

    it.failing('🔴 el premio NO borra el descuento de cuenta', () => {
      // $100 − $20 de descuento de cuenta − $30 de premio = $50 de mercancía (+ $5 de propina aparte).
      const orden = db.orden(ordenId)
      expect(orden.discountAmount).toBe(50)
      // Lo que el cajero cobra según su carrito cierra la cuenta, sin saldo fantasma.
      const saldo = cierraCon(orden, 50, 5)
      expect(saldo.remainingBalance.toNumber()).toBe(0)
      expect(saldo.isFullyPaid).toBe(true)
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

    it.failing('🔴 el segundo descuento NO borra el descuento de cuenta', () => {
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
