/**
 * Que la cocina pueda decir "sí lo hago" o "no puedo".
 *
 * 🔴 El modo MANUAL ya se podía activar desde el dashboard pero NO había forma de aceptar un
 * pedido: entraban, nadie podía aceptarlos, y Uber los cancelaba a los ~11.5 minutos. Todos,
 * en silencio. Y era la única salida cuando el marketplace vende algo que la cocina no puede
 * preparar — pasa de verdad en un venue sin inventario, donde nada se marca como agotado.
 */
import { DeliveryProvider, OrderStatus } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'
import { acceptDeliveryOrder, denyDeliveryOrder } from '@/services/delivery-channels/core/respondToDeliveryOrder.service'

const ok = { ok: true, status: 200, raw: '' }

describe('responder a un pedido de marketplace desde el POS', () => {
  let venueId: string, orgId: string

  const nuevaOrden = async (status: OrderStatus, externalId: string) =>
    prisma.order.create({
      data: {
        venueId,
        orderNumber: `R-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        externalId,
        status,
        total: '100',
        subtotal: '100',
        taxAmount: '0',
        tipAmount: '0',
      },
    })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org resp ${Date.now()}`, email: `x${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({ data: { organizationId: orgId, name: `V resp ${Date.now()}`, slug: `vp-${Date.now()}` } })
    venueId = v.id
    await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: 'store-resp', webhookSecret: 'x' },
    })
  })

  afterAll(async () => {
    try {
      await prisma.kdsOrder.deleteMany({ where: { venueId } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.order.deleteMany({ where: { venueId } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch {
      /* fixtures */
    }
  })

  afterEach(() => jest.restoreAllMocks())

  it('🔴 ACEPTAR: es lo que faltaba para que el modo MANUAL no perdiera TODOS los pedidos', async () => {
    const spy = jest.spyOn(uberAdapter, 'acceptOrder').mockResolvedValue(ok)
    const o = await nuevaOrden(OrderStatus.PENDING, `UBER_EATS:acc-${Date.now()}`)

    const r = await acceptDeliveryOrder(venueId, o.id, 'staff-1')

    expect(r.outcome).toBe('ACCEPTED')
    // Se le manda a Uber el id SIN el prefijo del proveedor: ese prefijo es nuestro.
    expect(spy).toHaveBeenCalledWith(o.externalId!.split(':')[1], 'store-resp')
  })

  it('🔴 plazo vencido: se distingue, porque NO es un error del staff ni sirve reintentar', async () => {
    jest
      .spyOn(uberAdapter, 'acceptOrder')
      .mockResolvedValue({ ok: false, status: 400, raw: '{"message":"The order is no longer active."}' })
    const o = await nuevaOrden(OrderStatus.PENDING, `UBER_EATS:tarde-${Date.now()}`)

    const r = await acceptDeliveryOrder(venueId, o.id)

    expect(r.outcome).toBe('FAILED')
    expect(r.error).toBe('PEDIDO_YA_NO_ACTIVO')
  })

  it('🔴 "no puedo" ANTES de aceptar ⇒ RECHAZO limpio', async () => {
    // El cliente se entera al instante y recupera su dinero sin fricción.
    const spyDeny = jest.spyOn(uberAdapter, 'denyOrder').mockResolvedValue(ok)
    const spyCancel = jest.spyOn(uberAdapter, 'cancelOrder').mockResolvedValue(ok)
    const o = await nuevaOrden(OrderStatus.PENDING, `UBER_EATS:deny-${Date.now()}`)

    const r = await denyDeliveryOrder(venueId, o.id, 'OUT_OF_ITEMS', 'staff-1')

    expect(r.outcome).toBe('DENIED')
    expect(spyDeny).toHaveBeenCalled()
    expect(spyCancel).not.toHaveBeenCalled()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('CANCELLED')
  })

  it('🔴 "no puedo" DESPUÉS de aceptar ⇒ CANCELACIÓN, no rechazo', async () => {
    // Ya dijimos que sí y el cliente está esperando: el protocolo es otro. Que el mesero
    // tenga que saber la diferencia sería pedirle que entienda la API de Uber para poder
    // decir que se acabó la carne.
    const spyDeny = jest.spyOn(uberAdapter, 'denyOrder').mockResolvedValue(ok)
    const spyCancel = jest.spyOn(uberAdapter, 'cancelOrder').mockResolvedValue(ok)
    const o = await nuevaOrden(OrderStatus.CONFIRMED, `UBER_EATS:canc-${Date.now()}`)

    const r = await denyDeliveryOrder(venueId, o.id, 'OUT_OF_ITEMS')

    expect(r.outcome).toBe('CANCELLED')
    expect(spyCancel).toHaveBeenCalled()
    expect(spyDeny).not.toHaveBeenCalled()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('CANCELLED')
  })

  it('una orden que NO es de delivery no se toca', async () => {
    const o = await nuevaOrden(OrderStatus.PENDING, `mostrador-${Date.now()}`)
    expect((await acceptDeliveryOrder(venueId, o.id)).outcome).toBe('NOT_A_DELIVERY_ORDER')
  })

  it('rechazar dos veces no truena', async () => {
    jest.spyOn(uberAdapter, 'cancelOrder').mockResolvedValue(ok)
    const o = await nuevaOrden(OrderStatus.CANCELLED, `UBER_EATS:doble-${Date.now()}`)
    expect((await denyDeliveryOrder(venueId, o.id)).outcome).toBe('ALREADY_DONE')
  })
})
