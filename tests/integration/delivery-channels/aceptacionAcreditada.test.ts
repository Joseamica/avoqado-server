/**
 * Tarea 7 del KDS de Uber: aceptación y «listo» sólo con EVIDENCIA del proveedor, y las
 * tres salidas a Uber (accept · ready · deny) respetando la reserva simétrica (spec §3.2).
 *
 * 🔴 Por qué importa: hoy `Order.status = CONFIRMED` no prueba que Uber aceptó (H17) y un
 * 409 del accept se trataba como éxito sin evidencia. El retiro de un renglón (Tarea 14) sólo
 * se permite sobre un pedido ACEPTADO de verdad y todavía no reportado LISTO: si estas marcas
 * mienten, se le promete al cliente un retiro que Uber va a rechazar.
 *
 * Contra PostgreSQL real; la red a Uber va espiada sobre el adaptador.
 */
import { DeliveryOrderEventStatus, DeliveryProvider, OrderAcceptanceMode, OrderStatus, StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'

import app from '@/app'
import prisma from '@/utils/prismaClient'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'
import { processUberEvent } from '@/services/delivery-channels/providers/uber-eats/uber.eventProcessor'
import * as responder from '@/services/delivery-channels/core/respondToDeliveryOrder.service'
import { tomarReserva } from '@/services/delivery-channels/core/deliveryOrderLock'
import { bumpKdsOrder } from '@/services/mobile/kds.mobile.service'
import fixtureAceptado from '../../fixtures/delivery/uber/pedido-con-modificadores-uapi.json'
import fixtureFallido from '../../fixtures/delivery/uber/pedido-real-uapi.json'

const { acceptDeliveryOrder, denyDeliveryOrder, markDeliveryOrderReady, recuperarAceptacionDesdeProveedor } = responder

// El setup de integración mockea `logAction`; aquí se quiere la fila REAL de ActivityLog.
jest.mock('@/services/dashboard/activity-log.service', () => jest.requireActual('@/services/dashboard/activity-log.service'))

const r200 = { ok: true, status: 200, raw: '' }
// Así lo devuelve el adaptador real: un 409 cuenta como `ok` para no repetir la acción.
const r409 = { ok: true, status: 409, raw: '{"code":"resource_status_conflict"}' }

describe('aceptación acreditada, «listo» irrevocable y reserva simétrica (Tarea 7)', () => {
  let venueId: string, orgId: string, linkId: string, staffId: string, token: string
  const STORE = `store-acred-${Date.now()}`

  const nuevaOrden = async (status: OrderStatus = OrderStatus.CONFIRMED) =>
    prisma.order.create({
      data: {
        venueId,
        orderNumber: `AC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        externalId: `UBER_EATS:acred-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status,
        total: '100',
        subtotal: '100',
        taxAmount: '0',
        tipAmount: '0',
        deliveryChannelLinkId: linkId,
      },
    })

  const leer = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } })

  async function nuevoEvento(pedidoId: string) {
    const eventId = `ev-acred-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const row = await prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.UBER_EATS,
        externalEventId: eventId,
        eventType: 'orders.notification',
        payload: {
          event_id: eventId,
          event_type: 'orders.notification',
          resource_href: `https://test-api.uber.com/v2/eats/order/${pedidoId}`,
          meta: { user_id: STORE, resource_id: pedidoId, status: 'pos' },
        },
        channelLinkId: linkId,
        venueId,
        dedupKey: `UBER_EATS:${eventId}`,
      },
    })
    return row.id
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org acred ${Date.now()}`, email: `acred${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({ data: { organizationId: orgId, name: `V acred ${Date.now()}`, slug: `v-acred-${Date.now()}` } })
    venueId = v.id
    const link = await prisma.deliveryChannelLink.create({
      data: {
        venueId,
        provider: DeliveryProvider.UBER_EATS,
        externalLocationId: STORE,
        webhookSecret: 'x',
        orderAcceptanceMode: OrderAcceptanceMode.AUTO,
      },
    })
    linkId = link.id
    const staff = await prisma.staff.create({ data: { email: `acred-staff-${Date.now()}@t.mx`, firstName: 'A', lastName: 'C' } })
    staffId = staff.id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.OWNER, active: true } })
    token = jwt.sign({ sub: staffId, orgId, venueId, role: StaffRole.OWNER }, process.env.ACCESS_TOKEN_SECRET as string, {
      expiresIn: '15m',
    })
  })

  afterAll(async () => {
    try {
      const orders = await prisma.order.findMany({ where: { venueId }, select: { id: true } })
      const ids = orders.map(o => o.id)
      await prisma.paymentAllocation.deleteMany({
        where: { paymentId: { in: (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id) } },
      })
      await prisma.payment.deleteMany({ where: { venueId } })
      await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } })
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.deliveryLineAction.deleteMany({ where: { venueId } })
      await prisma.deliveryOrderEvent.deleteMany({ where: { venueId } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.kdsOrder.deleteMany({ where: { venueId } })
      await prisma.order.deleteMany({ where: { venueId } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId } })
      await prisma.venueTenderType.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.staffVenue.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
      await prisma.staff.deleteMany({ where: { id: staffId } })
    } catch {
      /* fixtures */
    }
  })

  afterEach(() => jest.restoreAllMocks())

  // ── A. Evidencia ──────────────────────────────────────────────────────────────

  it('MANUAL: un 2xx del accept estampa la aceptación con HTTP_2XX y suelta la reserva', async () => {
    jest.spyOn(uberAdapter, 'acceptOrder').mockResolvedValue(r200)
    const o = await nuevaOrden(OrderStatus.PENDING)

    expect((await acceptDeliveryOrder(venueId, o.id)).outcome).toBe('ACCEPTED')

    const f = await leer(o.id)
    expect(f.providerAcceptedAt).not.toBeNull()
    expect(f.providerAcceptedEvidence).toBe('HTTP_2XX')
    expect(f.deliveryOpInFlight).toBeNull()
    expect(f.deliveryOpToken).toBeNull()
  })

  it('🔴 MANUAL: un 409 del accept sigue siendo "ok" para el flujo pero NO estampa nada', async () => {
    jest.spyOn(uberAdapter, 'acceptOrder').mockResolvedValue(r409)
    const o = await nuevaOrden(OrderStatus.PENDING)

    expect((await acceptDeliveryOrder(venueId, o.id)).outcome).toBe('ACCEPTED')

    const f = await leer(o.id)
    expect(f.providerAcceptedAt).toBeNull()
    expect(f.providerAcceptedEvidence).toBeNull()
  })

  it('AUTO: el 2xx del auto-accept estampa HTTP_2XX sobre la orden que crea la ingesta', async () => {
    const pedido = { ...(fixtureFallido as any).order, id: `acred-auto-${Date.now()}` }
    const r = await processUberEvent(await nuevoEvento(pedido.id), {
      fetchOrder: async () => pedido,
      acceptOrder: async () => r200,
    })
    expect(r.outcome).toBe('PROCESSED')

    const f = await leer(r.orderId!)
    expect(f.providerAcceptedEvidence).toBe('HTTP_2XX')
  })

  it('🔴 AUTO: un 409 del auto-accept sobre un pedido cuyo estado NO es ACCEPTED no estampa nada', async () => {
    // El fixture real trae `state: FAILED`: ni el 409 ni la lectura prueban aceptación.
    const pedido = { ...(fixtureFallido as any).order, id: `acred-409-${Date.now()}` }
    const r = await processUberEvent(await nuevoEvento(pedido.id), {
      fetchOrder: async () => pedido,
      acceptOrder: async () => r409,
    })
    expect(r.outcome).toBe('PROCESSED')

    const f = await leer(r.orderId!)
    expect(f.providerAcceptedAt).toBeNull()
    expect(f.providerAcceptedEvidence).toBeNull()
  })

  it('🔴 AUTO, 2xx perdido: la ingesta de un pedido con state=ACCEPTED estampa PROVIDER_STATE', async () => {
    // El reproceso del webhook: el accept ya pasó (Uber dice 409), pero el GET dice ACCEPTED.
    expect((fixtureAceptado as any).order.state).toBe('ACCEPTED')
    const pedido = { ...(fixtureAceptado as any).order, id: `acred-estado-${Date.now()}` }
    const r = await processUberEvent(await nuevoEvento(pedido.id), {
      fetchOrder: async () => pedido,
      acceptOrder: async () => r409,
    })
    expect(r.outcome).toBe('PROCESSED')

    const f = await leer(r.orderId!)
    expect(f.providerAcceptedEvidence).toBe('PROVIDER_STATE')
    expect(f.providerAcceptedAt).not.toBeNull()
    const ev = await prisma.deliveryOrderEvent.findFirstOrThrow({ where: { orderId: r.orderId! } })
    expect(ev.status).toBe(DeliveryOrderEventStatus.PROCESSED)
  })

  it('🔴 recuperar: un GET con state=ACCEPTED recupera la aceptación cuyo 2xx se perdió', async () => {
    const o = await nuevaOrden()
    const spy = jest.spyOn(uberAdapter, 'fetchOrder').mockResolvedValue(fixtureAceptado)

    expect(await recuperarAceptacionDesdeProveedor(venueId, o.id)).toBe(true)

    expect(spy).toHaveBeenCalledWith(o.externalId!.split(':')[1])
    const f = await leer(o.id)
    expect(f.providerAcceptedEvidence).toBe('PROVIDER_STATE')
    expect(f.providerAcceptedAt).not.toBeNull()
  })

  it('recuperar: un GET cuyo estado NO es ACCEPTED no inventa la aceptación', async () => {
    const o = await nuevaOrden()
    jest.spyOn(uberAdapter, 'fetchOrder').mockResolvedValue(fixtureFallido)

    expect(await recuperarAceptacionDesdeProveedor(venueId, o.id)).toBe(false)
    expect((await leer(o.id)).providerAcceptedAt).toBeNull()
  })

  it('un 2xx del ready estampa readyReportedAt', async () => {
    jest.spyOn(uberAdapter, 'markOrderReady').mockResolvedValue(r200)
    const o = await nuevaOrden()

    expect((await markDeliveryOrderReady(venueId, o.id)).outcome).toBe('READY')
    const f = await leer(o.id)
    expect(f.readyReportedAt).not.toBeNull()
    expect(f.deliveryOpInFlight).toBeNull()
  })

  it('🔴 un 409 del ready NO estampa readyReportedAt (Uber es la autoridad)', async () => {
    jest.spyOn(uberAdapter, 'markOrderReady').mockResolvedValue(r409)
    const o = await nuevaOrden()

    expect((await markDeliveryOrderReady(venueId, o.id)).outcome).toBe('READY')
    expect((await leer(o.id)).readyReportedAt).toBeNull()
  })

  // ── C. Reserva simétrica ──────────────────────────────────────────────────────

  it('🔴 aceptar mientras hay un «listo» en vuelo ⇒ OP_IN_PROGRESS y NO se le habla a Uber', async () => {
    const spy = jest.spyOn(uberAdapter, 'acceptOrder').mockResolvedValue(r200)
    const o = await nuevaOrden(OrderStatus.PENDING)
    const reserva = await tomarReserva(o.id, 'READY')
    expect(reserva.ok).toBe(true)

    const r = await acceptDeliveryOrder(venueId, o.id)

    expect(r.outcome).toBe('OP_IN_PROGRESS')
    expect(r.ocupadaPor).toBe('READY')
    expect(spy).not.toHaveBeenCalled()
    const f = await leer(o.id)
    expect(f.deliveryOpInFlight).toBe('READY') // la reserva ajena queda intacta
    expect(f.providerAcceptedAt).toBeNull()
  })

  it.each(['PENDING', 'UNCERTAIN'])('🔴 rechazar con un retiro %s en la orden ⇒ LINE_ACTION_IN_PROGRESS, sin HTTP', async status => {
    const spyDeny = jest.spyOn(uberAdapter, 'denyOrder').mockResolvedValue(r200)
    const spyCancel = jest.spyOn(uberAdapter, 'cancelOrder').mockResolvedValue(r200)
    const o = await nuevaOrden(OrderStatus.CONFIRMED)
    await prisma.deliveryLineAction.create({
      data: {
        venueId,
        orderId: o.id,
        orderItemId: 'item-x',
        provider: DeliveryProvider.UBER_EATS,
        externalOrderId: o.externalId!.split(':')[1],
        storeId: STORE,
        lineId: `line-${status}`,
        action: 'REMOVE_ITEM',
        status,
        origin: 'STAFF',
      },
    })

    const r = await denyDeliveryOrder(venueId, o.id)

    expect(r.outcome).toBe('LINE_ACTION_IN_PROGRESS')
    expect(spyDeny).not.toHaveBeenCalled()
    expect(spyCancel).not.toHaveBeenCalled()
    const f = await leer(o.id)
    expect(f.status).toBe(OrderStatus.CONFIRMED)
    expect(f.deliveryOpInFlight).toBeNull() // la reserva que tomó se soltó
  })

  it('🔴 resultado TARDÍO: si otra operación tomó la reserva a media llamada, no se aplica y queda en ActivityLog', async () => {
    const o = await nuevaOrden(OrderStatus.PENDING)
    jest.spyOn(uberAdapter, 'acceptOrder').mockImplementation(async () => {
      // Mientras Uber contesta, la reserva de ESTA operación vence y otra la toma.
      await prisma.order.update({
        where: { id: o.id },
        data: { deliveryOpInFlight: 'REMOVE_ITEM', deliveryOpInFlightAt: new Date(), deliveryOpToken: 'token-de-otra-operacion' },
      })
      return r200
    })

    const r = await acceptDeliveryOrder(venueId, o.id)

    expect(r.outcome).toBe('FAILED')
    expect(r.error).toBe('RESULTADO_TARDIO')
    const f = await leer(o.id)
    expect(f.providerAcceptedAt).toBeNull() // no se aplicó
    expect(f.deliveryOpToken).toBe('token-de-otra-operacion') // y no se tocó la reserva ajena
    expect(f.deliveryOpInFlight).toBe('REMOVE_ITEM')
    const log = await prisma.activityLog.findFirst({ where: { venueId, action: 'DELIVERY_OP_LATE_RESULT', entityId: o.id } })
    expect(log).not.toBeNull()
    expect(log!.data).toMatchObject({ operacion: 'ACCEPT', httpStatus: 200 })
  })

  it('🔴 si la llamada a Uber LANZA, la reserva se suelta igual (finally)', async () => {
    jest.spyOn(uberAdapter, 'acceptOrder').mockRejectedValue(new Error('socket hang up'))
    const o = await nuevaOrden(OrderStatus.PENDING)

    await expect(acceptDeliveryOrder(venueId, o.id)).rejects.toThrow('socket hang up')

    const f = await leer(o.id)
    expect(f.deliveryOpInFlight).toBeNull()
    expect(f.deliveryOpToken).toBeNull()
  })

  it('🔴 el bump con la reserva tomada termina igual: el «listo» se omite y queda pendiente', async () => {
    const spyReady = jest.spyOn(uberAdapter, 'markOrderReady').mockResolvedValue(r200)
    const spyServicio = jest.spyOn(responder, 'markDeliveryOrderReady')
    const o = await nuevaOrden()
    const kds = await prisma.kdsOrder.create({ data: { venueId, orderId: o.id, orderNumber: o.orderNumber, orderType: 'DELIVERY' } })
    expect((await tomarReserva(o.id, 'REMOVE_ITEM')).ok).toBe(true)

    const bumped = await bumpKdsOrder(venueId, kds.id)

    expect(bumped.status).toBe('COMPLETED')
    // Se espera al aviso fire-and-forget por su promesa, no por un reloj.
    expect(spyServicio).toHaveBeenCalledTimes(1)
    const aviso = await spyServicio.mock.results[0].value
    expect(aviso.outcome).toBe('OP_IN_PROGRESS')
    expect(spyReady).not.toHaveBeenCalled()
    const f = await leer(o.id)
    expect(f.readyReportedAt).toBeNull()
    expect(f.deliveryOpInFlight).toBe('REMOVE_ITEM')
  })

  // ── Ruta ──────────────────────────────────────────────────────────────────────

  it('POST /delivery/accept con la reserva tomada ⇒ 409 DELIVERY_OP_IN_PROGRESS', async () => {
    const spy = jest.spyOn(uberAdapter, 'acceptOrder').mockResolvedValue(r200)
    const o = await nuevaOrden(OrderStatus.PENDING)
    expect((await tomarReserva(o.id, 'READY')).ok).toBe(true)

    const res = await request(app)
      .post(`/api/v1/mobile/venues/${venueId}/orders/${o.id}/delivery/accept`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('DELIVERY_OP_IN_PROGRESS')
    expect(res.body.ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})
