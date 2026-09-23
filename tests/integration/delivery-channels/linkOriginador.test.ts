/**
 * El link (tienda) que responde por un pedido sale de la ORDEN que lo originó, no del
 * primer link del venue.
 *
 * 🔴 Con dos tiendas Uber en el mismo venue, `findFirst({ venueId, provider })` elegía
 * SIEMPRE la primera — un pedido de la tienda B se aceptaba/rechazaba contra la A.
 */
import { DeliveryProvider, OrderStatus } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'
import { acceptDeliveryOrder } from '@/services/delivery-channels/core/respondToDeliveryOrder.service'

const ok = { ok: true, status: 200, raw: '' }

describe('el link originador sale de la orden, no del primer link del venue', () => {
  let venueId: string, orgId: string, linkAId: string, linkBId: string

  const nuevaOrden = async (externalId: string, deliveryChannelLinkId?: string) =>
    prisma.order.create({
      data: {
        venueId,
        orderNumber: `LO-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        externalId,
        status: OrderStatus.PENDING,
        total: '100',
        subtotal: '100',
        taxAmount: '0',
        tipAmount: '0',
        deliveryChannelLinkId,
      },
    })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org lo ${Date.now()}`, email: `lo${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({ data: { organizationId: orgId, name: `V lo ${Date.now()}`, slug: `vlo-${Date.now()}` } })
    venueId = v.id
    // linkA nace PRIMERO — es la que `findFirst` sin filtrar por orden elegía siempre.
    const linkA = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: 'store-A', webhookSecret: 'x' },
    })
    linkAId = linkA.id
    const linkB = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: 'store-B', webhookSecret: 'x' },
    })
    linkBId = linkB.id
  })

  afterAll(async () => {
    try {
      await prisma.kdsOrder.deleteMany({ where: { venueId } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.deliveryOrderEvent.deleteMany({ where: { venueId } })
      await prisma.order.deleteMany({ where: { venueId } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch {
      /* fixtures */
    }
  })

  afterEach(() => jest.restoreAllMocks())

  it('con DOS tiendas del mismo venue usa la que originó la orden, no la primera', async () => {
    const spy = jest.spyOn(uberAdapter, 'acceptOrder').mockResolvedValue(ok)
    const o = await nuevaOrden(`UBER_EATS:dos-tiendas-${Date.now()}`, linkBId)

    const r = await acceptDeliveryOrder(venueId, o.id)

    expect(r.outcome).toBe('ACCEPTED')
    expect(spy).toHaveBeenCalledWith(o.externalId!.split(':')[1], 'store-B')
    expect(spy).not.toHaveBeenCalledWith(o.externalId!.split(':')[1], 'store-A')
  })

  it('orden previa al cambio (sin deliveryChannelLinkId) se resuelve por su DeliveryOrderEvent', async () => {
    const spy = jest.spyOn(uberAdapter, 'acceptOrder').mockResolvedValue(ok)
    const o = await nuevaOrden(`UBER_EATS:legacy-${Date.now()}`) // sin deliveryChannelLinkId
    await prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.UBER_EATS,
        externalEventId: `ev-${Date.now()}`,
        eventType: 'order',
        payload: {},
        channelLinkId: linkBId, // el evento que la originó fue el de la tienda B
        venueId,
        orderId: o.id,
      },
    })

    const r = await acceptDeliveryOrder(venueId, o.id)

    expect(r.outcome).toBe('ACCEPTED')
    expect(spy).toHaveBeenCalledWith(o.externalId!.split(':')[1], 'store-B')
  })

  it('sin link resoluble (ni deliveryChannelLinkId ni evento) devuelve NOT_A_DELIVERY_ORDER', async () => {
    const o = await nuevaOrden(`UBER_EATS:sin-link-${Date.now()}`)
    const r = await acceptDeliveryOrder(venueId, o.id)
    expect(r.outcome).toBe('NOT_A_DELIVERY_ORDER')
  })
})
