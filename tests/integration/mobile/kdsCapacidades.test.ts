/**
 * Integration (REAL DB + REAL app por supertest) — Tarea 16 del KDS de Uber: el DTO del tablero
 * trae las CAPACIDADES ya decididas por el servidor (spec «Apps» y §5). Las apps sólo leen
 * booleanos: si una condición del predicado se cayera del DTO, la cocina vería un botón que la
 * ruta niega (o, peor, dejaría de ver uno que sí sirve).
 */
import { DeliveryChannelLink, DeliveryProvider, OrderSource, StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import type { NormalizedDeliveryOrder, NormalizedDeliveryPayment } from '@/services/delivery-channels/core/types'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'
import { listKdsOrders } from '@/services/mobile/kds.mobile.service'

jest.setTimeout(30_000)

const QUINCE_MIN = 15 * 60_000
const CAMPOS_RENGLON = ['removedAt', 'canReportOutOfStock', 'lineActionState', 'lineActionAttempts', 'canRetryAt'] as const
const CAMPOS_COMANDA = ['canCancelDelivery', 'deliveryOpInFlight', 'hasLineActionInProgress'] as const

describe('El DTO del KDS decide por las apps (Tarea 16)', () => {
  let venueId: string, orgId: string, staffId: string
  let link: DeliveryChannelLink
  let token: string
  let n = 0
  let resolver: jest.SpyInstance
  let leerPedido: jest.SpyInstance

  const pago = (venta: string): NormalizedDeliveryPayment => ({
    currency: 'MXN',
    saleAmount: venta,
    merchantFees: '0.00',
    tipAmount: '0.00',
    externallyPaidSale: venta,
    externallyPaidTip: '0.00',
    cashDueSale: '0.00',
    cashDueTip: '0.00',
  })

  /** Pedido de reparto de dos renglones (a, b), como lo deja la ingesta real. */
  async function sembrar({ aceptado = true }: { aceptado?: boolean } = {}) {
    const sufijo = ++n
    const renglon = (linea: string, nombre: string, precio: string) => ({
      externalId: `${linea}-${sufijo}`,
      lineId: linea,
      name: `${nombre} ${sufijo}`,
      quantity: 1,
      unitPrice: precio,
      total: precio,
    })
    const normalized: NormalizedDeliveryOrder = {
      externalId: `cap-${Date.now()}-${sufijo}`,
      displayId: `CP${sufijo}`,
      source: OrderSource.UBER_EATS,
      items: [renglon('a', 'Cochinita', '150.00'), renglon('b', 'Horchata', '50.00')],
      payment: pago('200.00'),
      customer: { name: 'Cliente T16' },
      raw: { fuente: 'test' },
      placedAt: new Date(),
      providerAccepted: aceptado,
    }
    const { order } = await ingestDeliveryOrder(normalized, link)
    const kds = await prisma.kdsOrder.findFirstOrThrow({ where: { orderId: order.id } })
    const itemB = await prisma.kdsOrderItem.findFirstOrThrow({ where: { kdsOrderId: kds.id, externalLineId: 'b' } })
    const orderItem = (linea: string) => prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id, externalLineId: linea } })
    return {
      order,
      kds,
      itemB,
      orderItem,
      foto: (siguen: string[], venta: string) => ({
        ...normalized,
        items: normalized.items.filter(i => siguen.includes(i.lineId!)),
        payment: pago(venta),
        providerAccepted: true,
      }),
    }
  }
  type Semilla = Awaited<ReturnType<typeof sembrar>>

  const sembrarAccion = async (s: Semilla, linea: string, datos: { status: string; attempts?: number; lastAttemptAt?: Date }) =>
    prisma.deliveryLineAction.create({
      data: {
        venueId,
        orderId: s.order.id,
        orderItemId: (await s.orderItem(linea)).id,
        provider: DeliveryProvider.UBER_EATS,
        externalOrderId: s.order.externalId!.split(':')[1],
        storeId: link.externalLocationId,
        lineId: linea,
        action: 'REMOVE_ITEM',
        status: datos.status,
        origin: 'STAFF',
        requestedByStaffId: staffId,
        attempts: datos.attempts ?? 1,
        lastAttemptAt: datos.lastAttemptAt ?? new Date(),
      },
    })

  const tablero = () => request(app).get(`/api/v1/mobile/venues/${venueId}/kds/orders`).set('Authorization', `Bearer ${token}`)
  const comandaDe = async (s: Semilla) => {
    const res = await tablero()
    expect({ status: res.status, body: res.status === 200 ? null : res.body }).toEqual({ status: 200, body: null })
    return res.body.data.find((k: { id: string }) => k.id === s.kds.id)
  }
  const renglonB = (comanda: { items: Array<{ id: string }> }, s: Semilla) => comanda.items.find(i => i.id === s.itemB.id) as any

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org cap ${Date.now()}`, email: `cap${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V cap ${Date.now()}`, slug: `v-cap-${Date.now()}` } })).id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: `store-cap-${Date.now()}`, webhookSecret: 'x' },
    })
    staffId = (await prisma.staff.create({ data: { email: `cap-staff-${Date.now()}@t.mx`, firstName: 'KDS', lastName: 'Capacidades' } })).id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.OWNER, active: true } })
    token = jwt.sign({ sub: staffId, orgId, venueId, role: StaffRole.OWNER }, process.env.ACCESS_TOKEN_SECRET as string, {
      expiresIn: '15m',
    })
  })

  beforeEach(() => {
    resolver = jest.spyOn(uberAdapter, 'resolveFulfillmentIssues').mockRejectedValue(new Error('respuesta de Uber no configurada'))
    leerPedido = jest.spyOn(uberAdapter, 'fetchOrder').mockRejectedValue(new Error('sin red en la prueba'))
    jest.spyOn(uberAdapter, 'normalizeOrder').mockImplementation(raw => raw as NormalizedDeliveryOrder)
    jest.spyOn(uberAdapter, 'acceptOrder').mockRejectedValue(new Error('sin red en la prueba'))
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    try {
      const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true } })).map(o => o.id)
      const pagos = (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id)
      await prisma.deliveryLineAction.deleteMany({ where: { venueId } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.venueTransaction.deleteMany({ where: { venueId } })
      await prisma.paymentEffect.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.payment.deleteMany({ where: { venueId } })
      await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } })
      await prisma.kdsOrder.deleteMany({ where: { venueId } })
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.order.deleteMany({ where: { venueId } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId } })
      await prisma.venueTenderType.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.staffVenue.deleteMany({ where: { staffId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
      await prisma.staff.deleteMany({ where: { id: staffId } })
    } catch {
      /* fixtures */
    }
  })

  // Cada fila rompe UNA condición del predicado completo; la de arriba no rompe ninguna. 3 elementos
  // siempre (con menos, jest-each toma el último parámetro del callback por `done` y cuelga).
  it.each<[string, boolean, (s: Semilla) => Promise<unknown>]>([
    ['todo en orden', true, async () => undefined],
    ['sin providerAcceptedAt', false, s => prisma.order.update({ where: { id: s.order.id }, data: { providerAcceptedAt: null } })],
    ['con readyReportedAt', false, s => prisma.order.update({ where: { id: s.order.id }, data: { readyReportedAt: new Date() } })],
    ['comanda READY', false, s => prisma.kdsOrder.update({ where: { id: s.kds.id }, data: { status: 'READY' } })],
    [
      'renglon ya retirado',
      false,
      async s => prisma.orderItem.update({ where: { id: (await s.orderItem('b')).id }, data: { removedAt: new Date() } }),
    ],
    ['accion PENDING en la orden', false, s => sembrarAccion(s, 'a', { status: 'PENDING' })],
    [
      'reserva tomada',
      false,
      s =>
        prisma.order.update({
          where: { id: s.order.id },
          data: { deliveryOpInFlight: 'READY', deliveryOpInFlightAt: new Date(), deliveryOpToken: 'de-otro' },
        }),
    ],
    [
      'proveedor sin capacidad',
      false,
      async () => {
        delete (uberAdapter as Partial<typeof uberAdapter>).resolveFulfillmentIssues
      },
    ],
    [
      'sin externalLineId',
      false,
      async s => prisma.orderItem.update({ where: { id: (await s.orderItem('b')).id }, data: { externalLineId: null } }),
    ],
    ['sin orderItemId', false, s => prisma.kdsOrderItem.update({ where: { id: s.itemB.id }, data: { orderItemId: null } })],
    [
      'link no resoluble',
      false,
      s => prisma.order.update({ where: { id: s.order.id }, data: { deliveryChannelLinkId: 'link-que-no-existe' } }),
    ],
    ['accion REJECTED del renglon', false, s => sembrarAccion(s, 'b', { status: 'REJECTED' })],
  ])('canReportOutOfStock con %s ⇒ %s', async (_caso, esperado, preparar) => {
    const s = await sembrar()
    await preparar(s)

    const renglon = renglonB(await comandaDe(s), s)

    expect(renglon.canReportOutOfStock).toBe(esperado)
  })

  it('una reserva vencida (> 2 min) no cuenta: el botón vuelve', async () => {
    const s = await sembrar()
    await prisma.order.update({
      where: { id: s.order.id },
      data: { deliveryOpInFlight: 'READY', deliveryOpInFlightAt: new Date(Date.now() - 3 * 60_000), deliveryOpToken: 'huerfana' },
    })

    const comanda = await comandaDe(s)

    expect(renglonB(comanda, s).canReportOutOfStock).toBe(true)
    expect(comanda.deliveryOpInFlight).toBeNull()
  })

  it('canCancelDelivery es false con readyReportedAt y true en AUTO aceptado', async () => {
    const aceptado = await sembrar()
    const listo = await sembrar()
    await prisma.order.update({ where: { id: listo.order.id }, data: { readyReportedAt: new Date() } })

    expect((await comandaDe(aceptado)).canCancelDelivery).toBe(true)
    expect((await comandaDe(listo)).canCancelDelivery).toBe(false)
  })

  it.each<[string, (s: Semilla) => Promise<unknown>]>([
    ['venta COMPLETED', s => prisma.order.update({ where: { id: s.order.id }, data: { status: 'COMPLETED' } })],
    ['venta CANCELLED', s => prisma.order.update({ where: { id: s.order.id }, data: { status: 'CANCELLED' } })],
    [
      'reserva tomada',
      s =>
        prisma.order.update({
          where: { id: s.order.id },
          data: { deliveryOpInFlight: 'REMOVE_ITEM', deliveryOpInFlightAt: new Date(), deliveryOpToken: 't' },
        }),
    ],
    ['retiro UNCERTAIN en la orden', s => sembrarAccion(s, 'a', { status: 'UNCERTAIN' })],
  ])('canCancelDelivery es false con %s', async (_caso, preparar) => {
    const s = await sembrar()
    await preparar(s)
    expect((await comandaDe(s)).canCancelDelivery).toBe(false)
  })

  it('el estado del retiro viaja por renglón, con canRetryAt = la regla de 15 min del reintento', async () => {
    const s = await sembrar()
    const hace20 = new Date(Date.now() - 20 * 60_000)
    await sembrarAccion(s, 'b', { status: 'UNCERTAIN', attempts: 2, lastAttemptAt: hace20 })

    const comanda = await comandaDe(s)
    const b = renglonB(comanda, s)

    expect(b).toMatchObject({ lineActionState: 'UNCERTAIN', lineActionAttempts: 2, canReportOutOfStock: false })
    expect(new Date(b.canRetryAt).getTime()).toBe(hace20.getTime() + QUINCE_MIN)
    expect(comanda.hasLineActionInProgress).toBe(true)
    expect(comanda.canCancelDelivery).toBe(false)
    const a = comanda.items.find((i: { id: string }) => i.id !== s.itemB.id)
    expect(a).toMatchObject({ lineActionState: null, lineActionAttempts: null, canRetryAt: null, canReportOutOfStock: false })
  })

  it('la comanda que devuelve la ruta «no lo tengo» trae las MISMAS capacidades que el tablero', async () => {
    const s = await sembrar()
    resolver.mockResolvedValue({ ok: true, status: 200, raw: '{}' })
    leerPedido.mockResolvedValue(s.foto(['a'], '150.00'))

    const ruta = await request(app)
      .post(`/api/v1/mobile/venues/${venueId}/kds/orders/${s.kds.id}/items/${s.itemB.id}/out-of-stock`)
      .set('Authorization', `Bearer ${token}`)
    expect(ruta.status).toBe(200)
    const deLaRuta = ruta.body.data
    const delTablero = await comandaDe(s)

    const capacidades = (k: any) => ({
      ...Object.fromEntries(CAMPOS_COMANDA.map(c => [c, k[c]])),
      // Por id: `include: { items: true }` no fija el orden de los renglones.
      items: Object.fromEntries(k.items.map((i: any) => [i.id, Object.fromEntries(CAMPOS_RENGLON.map(c => [c, i[c]]))])),
    })
    expect(capacidades(deLaRuta)).toEqual(capacidades(delTablero))
    expect(renglonB(deLaRuta, s)).toMatchObject({ lineActionState: 'CONFIRMED', canReportOutOfStock: false })
    expect(renglonB(deLaRuta, s).removedAt).toEqual(expect.any(String))
  })

  it('los campos nuevos son opcionales: un APK viejo decodifica la respuesta igual', async () => {
    const s = await sembrar()
    resolver.mockResolvedValue({ ok: true, status: 200, raw: '{}' })
    leerPedido.mockResolvedValue(s.foto(['a'], '150.00'))
    await request(app)
      .post(`/api/v1/mobile/venues/${venueId}/kds/orders/${s.kds.id}/items/${s.itemB.id}/out-of-stock`)
      .set('Authorization', `Bearer ${token}`)
    // Una comanda de mostrador (no de reparto) en el mismo tablero.
    const mostrador = await prisma.kdsOrder.create({
      data: {
        venueId,
        orderNumber: `M${n}`,
        orderType: 'DINE_IN',
        status: 'NEW',
        items: { create: [{ productName: 'Café', quantity: 1 }] },
      },
    })

    const res = await tablero()
    const reparto = res.body.data.find((k: { id: string }) => k.id === s.kds.id)
    const deMostrador = res.body.data.find((k: { id: string }) => k.id === mostrador.id)

    // El contrato viejo sigue entero y con sus tipos: nada se quitó ni se renombró.
    for (const k of [reparto, deMostrador]) {
      expect(k).toMatchObject({
        id: expect.any(String),
        orderNumber: expect.any(String),
        orderType: expect.any(String),
        status: expect.any(String),
      })
      expect(typeof k.createdAt).toBe('string')
      for (const i of k.items) {
        expect(i).toMatchObject({
          id: expect.any(String),
          productName: expect.any(String),
          quantity: expect.any(Number),
          modifiers: expect.any(Array),
        })
      }
    }
    // El renglón retirado llega con prefijo: el APK viejo lo ve tachado sin saber de `removedAt`.
    expect(renglonB(reparto, s).productName.startsWith('RETIRADO · ')).toBe(true)
    // Lo que no es de reparto no trae ni un campo nuevo.
    for (const c of CAMPOS_COMANDA) expect(deMostrador).not.toHaveProperty(c)
    for (const c of CAMPOS_RENGLON) expect(deMostrador.items[0]).not.toHaveProperty(c)
  })

  it('el tablero NO consulta por comanda: el número de consultas no crece con las comandas', async () => {
    const modelos = ['kdsOrder', 'kdsOrderItem', 'order', 'orderItem', 'deliveryLineAction', 'deliveryChannelLink', 'deliveryOrderEvent']
    const ops = ['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow', 'count']
    const contar = async () => {
      // La ingesta AUTO dispara un accept en segundo plano: se deja asentar antes de medir.
      await new Promise(r => setTimeout(r, 500))
      const espias = modelos.flatMap(m => ops.map(op => jest.spyOn((prisma as any)[m], op)))
      const comandas = await listKdsOrders(venueId)
      const consultas = espias.reduce((t, e) => t + e.mock.calls.length, 0)
      espias.forEach(e => e.mockRestore())
      return { consultas, comandas: comandas.length }
    }

    const s = await sembrar()
    await sembrarAccion(s, 'a', { status: 'UNCERTAIN' })
    const antes = await contar()
    for (let i = 0; i < 3; i++) await sembrarAccion(await sembrar(), 'b', { status: 'PENDING' })
    const despues = await contar()

    expect(despues.comandas).toBeGreaterThan(antes.comandas)
    expect(despues.consultas).toBe(antes.consultas)
    console.log(
      `[T16] consultas por llamada a listKdsOrders: ${antes.consultas} (${antes.comandas} comandas) → ${despues.consultas} (${despues.comandas} comandas)`,
    )
  })
})
