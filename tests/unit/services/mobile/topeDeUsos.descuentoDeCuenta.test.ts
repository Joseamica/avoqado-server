/**
 * 🔴 DINERO (hz:e82938e1:D19, encargo 01765a): el tope de usos de un descuento (`Discount.maxTotalUses` / `currentUses`).
 *
 * (1) El descuento de cuenta del POS (Mesas de ANDROID/WINDOWS, `applyOrderDiscountInTransaction`) revisaba el tope pero NUNCA
 *     sumaba el uso: un «primeros 100» aplicado en Mesas no se acababa nunca. Ahora suma el uso EN LA MISMA transacción, con la
 *     condición del tope dentro del UPDATE (dos cajas con el último uso: pasa una sola). La fila queda marcada (`usoContado`) y
 *     quitarla devuelve ese uso; una fila vieja (sin marca) no resta lo que nunca sumó.
 * (4) La cola sin red nunca rechaza por tope lo que ya pasó frente al cliente: la venta de Mostrador ya cobrada y el descuento
 *     que la mesa ya dio. El uso cuenta igual (puede pasar del tope) y queda en el log.
 *
 * Doble EN MEMORIA con estado (como `descuentoConAprobacion.service.test.ts`): la creación y el descuento reales escriben y leen
 * las mismas filas, y el contador del catálogo sube y baja de verdad.
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/mobile/avisoDeVentaSinRed', () => ({
  ...jest.requireActual('@/services/mobile/avisoDeVentaSinRed'),
  avisarVentaSinRed: jest.fn().mockResolvedValue(undefined),
}))

import { Prisma } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'
import { validateDiscountActive } from '@/services/shared/discount.service'
import { devolverUsosDeCuentaQueSeBorraEnTx } from '@/services/shared/usoDelDescuento'
import { applyOrderDiscount, createOrderWithItems, removeOrderDiscount } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

type Fila = Record<string, any>

const VENUE = 'venue-1'
const PROMO = 'desc-promo' // 10 %, «primeros N»
const SIN_TOPE = 'desc-sin-tope' // 10 %, sin tope

const aNumero = (v: any) => (v && typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : v)

function coincide(fila: Fila, where: Fila = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      if (Array.isArray(v.in)) return v.in.includes(fila[k])
      if (typeof v.lt === 'number') return fila[k] < v.lt
      if (typeof v.gt === 'number') return fila[k] > v.gt
      throw new Error(`doble en memoria: operador no soportado en where.${k}`)
    }
    return fila[k] === v
  })
}

function baseEnMemoria(catalogo: Record<string, Fila>) {
  const ordenes = new Map<string, Fila>()
  const renglones: Fila[] = []
  const descuentos: Fila[] = []
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
    const o = ordenes.get(where.id)!
    for (const [k, v] of Object.entries(data as Fila))
      o[k] = typeof v === 'object' && v && 'increment' in (v as Fila) ? (aNumero(o[k]) ?? 0) + aNumero((v as Fila).increment) : aNumero(v)
    return conRenglones(o)
  })
  prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...valores: any[]) => {
    // El candado del descuento y la pasada de filas `Discount` (VIGENTES: el catálogo en memoria, no la foto que leyó la caja).
    const sql = Array.isArray(strings) ? strings.join('?') : (strings as any).sql
    if (sql.includes('pg_advisory_xact_lock')) return [{}]
    if (sql.includes('FROM "Discount"')) {
      const [venueId, ids] = valores
      return (ids as string[])
        .map(id => catalogo[id])
        .filter(d => d && d.venueId === venueId)
        .map(d => ({ id: d.id, name: d.name, currentUses: d.currentUses, maxTotalUses: d.maxTotalUses }))
    }
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
    const fila = { id: nuevoId('od'), appliedToItemIds: [], discountId: null, usoContado: false, ...plano(data) }
    descuentos.push(fila)
    return fila
  })
  prismaMock.orderDiscount.update.mockImplementation(async ({ where, data }: any) => {
    const fila = descuentos.find(d => d.id === where.id)
    Object.assign(fila!, plano(data))
    return fila
  })
  prismaMock.orderDiscount.delete.mockImplementation(async ({ where }: any) => {
    const i = descuentos.findIndex(d => d.id === where.id)
    return descuentos.splice(i, 1)[0]
  })
  prismaMock.venue.findUnique.mockResolvedValue({ id: VENUE, name: 'Tienda de prueba', salesEnabled: true })
  prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) =>
    where.venueId === VENUE ? { id: `sv-${where.staffId}`, staffId: where.staffId, venueId: VENUE, active: true, staff: {} } : null,
  )
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.discount.findFirst.mockImplementation(async ({ where }: any) => {
    const d = catalogo[where.id]
    return d && d.venueId === where.venueId ? { ...d, value: new Prisma.Decimal(d.value) } : null
  })
  // El contador: `updateMany` con su `where` (incluido `currentUses: { lt }`), como Postgres tras esperar el candado de la fila.
  prismaMock.discount.updateMany.mockImplementation(async ({ where, data }: any) => {
    const filas = Object.values(catalogo).filter(d => coincide(d, where))
    for (const d of filas) {
      if (data.currentUses?.increment) d.currentUses += data.currentUses.increment
      if (data.currentUses?.decrement) d.currentUses -= data.currentUses.decrement
    }
    return { count: filas.length }
  })
  // La lectura del Mostrador después de sumar (para el rastro «sobre el tope»).
  prismaMock.discount.findMany.mockImplementation(async ({ where }: any) =>
    Object.values(catalogo)
      .filter(d => coincide(d, where))
      .map(d => ({ ...d })),
  )
  // El contador: `update` con increment (sumar) o con el valor ya calculado (devolver por lotes).
  prismaMock.discount.update.mockImplementation(async ({ where, data }: any) => {
    const d = catalogo[where.id]
    if (typeof data.currentUses === 'number') d.currentUses = data.currentUses
    else if (data.currentUses?.increment) d.currentUses += data.currentUses.increment
    return { ...d }
  })
  const estado = { apartados: 0 }
  // Los usos que un cupón del mismo descuento apartó en una venta sin pagar.
  prismaMock.orderDiscount.count.mockImplementation(async () => estado.apartados)
  return { descuentos, catalogo, estado }
}

const descuento = (id: string, extra: Fila = {}): Fila => ({
  id,
  venueId: VENUE,
  name: id === PROMO ? 'Primeros 100' : '10% siempre',
  type: 'PERCENTAGE',
  value: 10,
  scope: 'ORDER',
  active: true,
  requiresApproval: false,
  maxTotalUses: null,
  currentUses: 0,
  ...extra,
})

/** Una venta de $100 en un renglón «Otro importe». */
const venta = (extra: Fila = {}) =>
  ({ staffId: 'staff-1', items: [{ name: 'Otro importe', quantity: 1, unitPrice: 10000 }], ...extra }) as any

async function cuentaAbierta(db: ReturnType<typeof baseEnMemoria>) {
  const creada = await createOrderWithItems(VENUE, venta())
  return { id: creada.id, filas: () => db.descuentos.filter(d => d.orderId === creada.id) }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('(1) Mesas del POS: el descuento de cuenta SUMA su uso', () => {
  it('🔴 aplicar un «primeros 100» sube el contador y marca la fila', async () => {
    const db = baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 100, currentUses: 5 }) })
    const cuenta = await cuentaAbierta(db)

    const r = await applyOrderDiscount(VENUE, cuenta.id, PROMO, 'sesion-1')

    expect(r.amount).toBe(10)
    expect(db.catalogo[PROMO].currentUses).toBe(6)
    expect(cuenta.filas()).toEqual([expect.objectContaining({ discountId: PROMO, usoContado: true })])
  })

  it('🔴 el último uso: dos cuentas lo piden y sólo una lo gana (la condición del tope va dentro del UPDATE)', async () => {
    const db = baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 100, currentUses: 99 }) })
    const a = await cuentaAbierta(db)
    const b = await cuentaAbierta(db)
    // Las dos leen 99 (antes de que la otra escriba): la lectura de la segunda se queda con la foto vieja.
    const foto = { ...db.catalogo[PROMO] }
    prismaMock.discount.findFirst.mockImplementation(async () => ({ ...foto, value: new Prisma.Decimal(10) }))

    await applyOrderDiscount(VENUE, a.id, PROMO, 'sesion-1')
    await expect(applyOrderDiscount(VENUE, b.id, PROMO, 'sesion-2')).rejects.toThrow(/usage limit|límite de usos/i)

    expect(db.catalogo[PROMO].currentUses).toBe(100)
    expect(a.filas()).toHaveLength(1)
    // El UPDATE va ANTES de crear la fila: el rechazo no deja la fila (en Postgres, además, la transacción se revierte).
    expect(b.filas()).toEqual([])
  })

  it('regresión: con el tope ya lleno se rechaza como siempre y el contador no se mueve', async () => {
    const db = baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 100, currentUses: 100 }) })
    const cuenta = await cuentaAbierta(db)

    await expect(applyOrderDiscount(VENUE, cuenta.id, PROMO, 'sesion-1')).rejects.toBeInstanceOf(BadRequestError)
    expect(db.catalogo[PROMO].currentUses).toBe(100)
    expect(cuenta.filas()).toEqual([])
  })

  it('🔴 Codex r1 #2: el gerente bajó el tope mientras la caja aplicaba: manda el tope VIGENTE, no el que leyó', async () => {
    const db = baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 2, currentUses: 1 }) })
    const cuenta = await cuentaAbierta(db)
    const foto = { ...db.catalogo[PROMO] } // la caja leyó tope 2
    prismaMock.discount.findFirst.mockImplementation(async () => ({ ...foto, value: new Prisma.Decimal(10) }))
    db.catalogo[PROMO].maxTotalUses = 1 // el gerente lo bajó antes del UPDATE

    await expect(applyOrderDiscount(VENUE, cuenta.id, PROMO, 'sesion-1')).rejects.toThrow(/usage limit/)
    expect(db.catalogo[PROMO].currentUses).toBe(1)
  })

  it('🔴 Codex r1 #3: el último uso ya lo apartó un cupón en un pedido sin pagar: Mesas no lo toma', async () => {
    const db = baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 1, currentUses: 0 }) })
    db.estado.apartados = 1
    const cuenta = await cuentaAbierta(db)

    await expect(applyOrderDiscount(VENUE, cuenta.id, PROMO, 'sesion-1')).rejects.toThrow(/usage limit/)
    expect(db.catalogo[PROMO].currentUses).toBe(0)
  })

  it('un descuento sin tope también cuenta su uso (como el motor de la TPV y el Mostrador)', async () => {
    const db = baseEnMemoria({ [SIN_TOPE]: descuento(SIN_TOPE, { currentUses: 7 }) })
    const cuenta = await cuentaAbierta(db)

    await applyOrderDiscount(VENUE, cuenta.id, SIN_TOPE, 'sesion-1')

    expect(db.catalogo[SIN_TOPE].currentUses).toBe(8)
  })
})

describe('(1) quitarlo devuelve SÓLO el uso que sumó', () => {
  it('🔴 aplicar y quitar deja el contador como estaba (y se puede volver a aplicar)', async () => {
    const db = baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 100, currentUses: 99 }) })
    const cuenta = await cuentaAbierta(db)

    const r = await applyOrderDiscount(VENUE, cuenta.id, PROMO, 'sesion-1')
    expect(db.catalogo[PROMO].currentUses).toBe(100)
    await removeOrderDiscount(VENUE, cuenta.id, r.orderDiscountId, 'sesion-1')
    expect(db.catalogo[PROMO].currentUses).toBe(99)

    await applyOrderDiscount(VENUE, cuenta.id, PROMO, 'sesion-1')
    expect(db.catalogo[PROMO].currentUses).toBe(100)
  })

  it('🔴 una fila vieja (de antes del arreglo, sin marca) se quita sin restar lo que nunca sumó', async () => {
    const db = baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 100, currentUses: 40 }) })
    const cuenta = await cuentaAbierta(db)
    db.descuentos.push({
      id: 'od-vieja',
      orderId: cuenta.id,
      discountId: PROMO,
      type: 'PERCENTAGE',
      name: 'Primeros 100',
      value: 10,
      amount: 10,
      appliedToItemIds: [],
      reparto: null,
      usoContado: false,
      loyaltyTransactionId: null,
    })

    await removeOrderDiscount(VENUE, cuenta.id, 'od-vieja', 'sesion-1')

    expect(db.catalogo[PROMO].currentUses).toBe(40)
    expect(cuenta.filas()).toEqual([])
  })
})

describe('(4) la cola sin red nunca rechaza por tope lo que ya pasó', () => {
  it('validateDiscountActive: en la cola el tope no rechaza; vencido o apagado sí, como siempre', () => {
    const lleno = descuento(PROMO, { maxTotalUses: 100, currentUses: 100 })
    expect(() => validateDiscountActive(lleno)).toThrow(/usage limit/)
    expect(() => validateDiscountActive(lleno, { enLaCola: true })).not.toThrow()
    expect(() => validateDiscountActive({ ...lleno, active: false }, { enLaCola: true })).toThrow(/inactive/)
    expect(() => validateDiscountActive({ ...lleno, validUntil: new Date(Date.now() - 60_000) }, { enLaCola: true })).toThrow(/expired/)
  })

  it('🔴 Mostrador: la venta en efectivo de la cola con un «primeros 100» ya lleno ENTRA, con su descuento, y el uso cuenta', async () => {
    const db = baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 100, currentUses: 100 }) })

    const creada = await createOrderWithItems(
      VENUE,
      venta({ isOfflineReplay: true, createdAtLocal: Date.now(), performedBy: 'sesion-1', orderDiscountId: PROMO }),
    )

    expect(db.descuentos.filter(d => d.orderId === creada.id)).toEqual([expect.objectContaining({ discountId: PROMO, amount: 10 })])
    expect(db.catalogo[PROMO].currentUses).toBe(101)
    // Codex r1 #1 y #7, r2 #3: queda el rastro para el dueño, en la MISMA transacción que la venta (una caída no lo pierde).
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'DESCUENTO_SOBRE_TOPE',
        entityId: creada.id,
        staffId: null,
        data: expect.objectContaining({
          discountId: PROMO,
          usos: 101,
          tope: 100,
          camino: 'mostrador',
          sinRed: true,
          subidaPor: 'sesion-1',
        }),
      }),
    })
  })

  it('regresión: Mostrador de la cola DEBAJO del tope no deja rastro de «sobre el tope»', async () => {
    const db = baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 100, currentUses: 10 }) })
    await createOrderWithItems(
      VENUE,
      venta({ isOfflineReplay: true, createdAtLocal: Date.now(), performedBy: 'sesion-1', orderDiscountId: PROMO }),
    )
    expect(db.catalogo[PROMO].currentUses).toBe(11)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'DESCUENTO_SOBRE_TOPE' }) })
  })

  it('🔴 decisión «A» (19-nov): Mostrador EN LÍNEA con el último uso a la vez: la segunda venta (ya cobrada) ENTRA, queda un uso arriba y avisa', async () => {
    const db = baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 1, currentUses: 0 }) })
    // Las dos cajas validaron con la misma foto (0 de 1) antes de que la otra escribiera.
    const foto = { ...db.catalogo[PROMO] }
    prismaMock.discount.findFirst.mockImplementation(async () => ({ ...foto, value: new Prisma.Decimal(10) }))
    const primera = await createOrderWithItems(VENUE, venta({ performedBy: 'sesion-1', orderDiscountId: PROMO }))
    expect(db.catalogo[PROMO].currentUses).toBe(1)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'DESCUENTO_SOBRE_TOPE' }) })

    const segunda = await createOrderWithItems(VENUE, venta({ performedBy: 'sesion-2', orderDiscountId: PROMO }))

    expect(db.catalogo[PROMO].currentUses).toBe(2)
    expect(db.descuentos.filter(d => d.orderId === primera.id)).toHaveLength(1)
    expect(db.descuentos.filter(d => d.orderId === segunda.id)).toEqual([expect.objectContaining({ discountId: PROMO, amount: 10 })])
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'DESCUENTO_SOBRE_TOPE',
        entityId: segunda.id,
        data: expect.objectContaining({ discountId: PROMO, usos: 2, tope: 1, camino: 'mostrador', sinRed: false, subidaPor: 'sesion-2' }),
      }),
    })
  })

  it('🔴 Codex r3 #3–#5 / r4 #4–#6: el uso se suma DESPUÉS de guardar la venta, en su propia transacción y sin el candado del cupón', async () => {
    const db = baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 100, currentUses: 3 }) })
    const transacciones = prismaMock.$transaction as jest.Mock
    await createOrderWithItems(VENUE, venta({ performedBy: 'sesion-1', orderDiscountId: PROMO }))
    expect(db.catalogo[PROMO].currentUses).toBe(4)
    const ultimo = (m: jest.Mock) => Math.max(0, ...m.mock.invocationCallOrder)
    const suma = (prismaMock.discount.update as jest.Mock).mock.invocationCallOrder[0]
    expect(suma).toBeGreaterThan(ultimo(prismaMock.order.create as jest.Mock))
    expect(suma).toBeGreaterThan(ultimo(prismaMock.orderDiscount.create as jest.Mock))
    // Dos transacciones: la venta y, después, la suma.
    expect(transacciones.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(suma).toBeGreaterThan(transacciones.mock.invocationCallOrder[0])
    const consultas = (prismaMock.$queryRaw as jest.Mock).mock.calls.map(([q]) => (Array.isArray(q) ? q.join('?') : String(q?.sql ?? q)))
    expect(consultas.some(q => q.includes('pg_advisory_xact_lock'))).toBe(false)
  })

  it('regresión: Mostrador EN LÍNEA con el tope lleno se sigue rechazando', async () => {
    baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 100, currentUses: 100 }) })
    await expect(createOrderWithItems(VENUE, venta({ performedBy: 'sesion-1', orderDiscountId: PROMO }))).rejects.toThrow(/usage limit/)
  })

  it('🔴 Mesas: el descuento que la mesa ya dio sin red entra al reproducirse aunque el tope se haya llenado, y cuenta', async () => {
    const db = baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 100, currentUses: 100 }) })
    const cuenta = await cuentaAbierta(db)

    await applyOrderDiscount(VENUE, cuenta.id, PROMO, 'sesion-1', false, undefined, {}, { enLaCola: true })

    expect(cuenta.filas()).toEqual([expect.objectContaining({ discountId: PROMO, usoContado: true })])
    expect(db.catalogo[PROMO].currentUses).toBe(101)
    // Codex r1 #7: medido bajo el candado (después de sumar), no con la foto que se leyó antes.
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'DESCUENTO_SOBRE_TOPE',
        entityId: cuenta.id,
        data: expect.objectContaining({ discountId: PROMO, usos: 101, tope: 100, camino: 'mesa', sinRed: true }),
      }),
    })
  })

  it('regresión: la cola de Mesas debajo del tope suma sin rastro', async () => {
    const db = baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 100, currentUses: 3 }) })
    const cuenta = await cuentaAbierta(db)
    await applyOrderDiscount(VENUE, cuenta.id, PROMO, 'sesion-1', false, undefined, {}, { enLaCola: true })
    expect(db.catalogo[PROMO].currentUses).toBe(4)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'DESCUENTO_SOBRE_TOPE' }) })
  })
})

describe('Codex r3 #1: el descuento de cuenta que ANDROID manda como importe + `descuentoDeCatalogoId` también gasta su uso', () => {
  it('🔴 la etiqueta con importe cuenta UN uso (antes nunca contaba: un «primeros 1» se daba en todas las cajas)', async () => {
    const db = baseEnMemoria({ [PROMO]: descuento(PROMO, { maxTotalUses: 1, currentUses: 0 }) })

    await createOrderWithItems(VENUE, venta({ performedBy: 'sesion-1', discount: 1000, descuentoDeCatalogoId: PROMO }))
    expect(db.catalogo[PROMO].currentUses).toBe(1)

    // La segunda caja (ya cobró): entra igual, queda arriba y avisa (decisión «A»).
    const segunda = await createOrderWithItems(VENUE, venta({ performedBy: 'sesion-2', discount: 1000, descuentoDeCatalogoId: PROMO }))
    expect(db.catalogo[PROMO].currentUses).toBe(2)
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'DESCUENTO_SOBRE_TOPE',
        entityId: segunda.id,
        data: expect.objectContaining({ discountId: PROMO, usos: 2, tope: 1, camino: 'mostrador' }),
      }),
    })
  })

  it('regresión: sin importe, o con una etiqueta de otro negocio, no cuenta nada', async () => {
    const db = baseEnMemoria({
      [PROMO]: descuento(PROMO, { maxTotalUses: 10, currentUses: 2 }),
      ajeno: descuento('ajeno', { venueId: 'otro-negocio', currentUses: 0 }),
    })
    await createOrderWithItems(VENUE, venta({ performedBy: 'sesion-1', descuentoDeCatalogoId: PROMO }))
    await createOrderWithItems(VENUE, venta({ performedBy: 'sesion-1', discount: 1000, descuentoDeCatalogoId: 'ajeno' }))
    expect(db.catalogo[PROMO].currentUses).toBe(2)
    expect(db.catalogo.ajeno.currentUses).toBe(0)
  })

  it('regresión: con `orderDiscountId` manda el de catálogo y la etiqueta no suma un segundo uso', async () => {
    const db = baseEnMemoria({
      [PROMO]: descuento(PROMO, { maxTotalUses: 10, currentUses: 2 }),
      [SIN_TOPE]: descuento(SIN_TOPE, { currentUses: 0 }),
    })
    await createOrderWithItems(
      VENUE,
      venta({ performedBy: 'sesion-1', orderDiscountId: PROMO, discount: 1000, descuentoDeCatalogoId: SIN_TOPE }),
    )
    expect(db.catalogo[PROMO].currentUses).toBe(3)
    expect(db.catalogo[SIN_TOPE].currentUses).toBe(0)
  })
})

describe('Codex r1 #4 / r2 #6: la cuenta vacía que se borra devuelve TODOS los usos que sus filas sumaron', () => {
  it('por páginas (más de 200 filas), una sola vez por descuento y sin bajar de 0', async () => {
    const db = baseEnMemoria({
      [PROMO]: descuento(PROMO, { maxTotalUses: 500, currentUses: 250 }),
      [SIN_TOPE]: descuento(SIN_TOPE, { currentUses: 0 }),
    })
    const filas = [
      ...Array.from({ length: 201 }, (_, i) => ({ id: `od-${String(i).padStart(3, '0')}`, discountId: PROMO })),
      { id: 'od-zzz', discountId: SIN_TOPE },
    ]
    prismaMock.orderDiscount.findMany.mockImplementation(async ({ where, take }: any) => {
      expect(where).toMatchObject({ orderId: 'orden-vacia', order: { venueId: VENUE }, usoContado: true, discountId: { not: null } })
      return filas.filter(f => !where.id?.gt || f.id > where.id.gt).slice(0, take)
    })

    const n = await devolverUsosDeCuentaQueSeBorraEnTx(prismaMock as any, VENUE, 'orden-vacia')

    expect(n).toBe(202)
    expect(db.catalogo[PROMO].currentUses).toBe(49)
    expect(db.catalogo[SIN_TOPE].currentUses).toBe(0)
  })
})
