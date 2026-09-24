/**
 * Integration (REAL DB + REAL app por supertest) — Tarea 4 del KDS de Uber: el contacto del
 * cliente viaja hasta la comanda, por HTTP real y también cuando un pedido PROGRAMADO se
 * libera después (`releaseScheduledOrder`).
 */
import { DeliveryChannelLink, DeliveryProvider, OrderSource, StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { releaseScheduledOrder } from '@/services/delivery-channels/core/releaseScheduledOrder.service'
import type { NormalizedDeliveryOrder } from '@/services/delivery-channels/core/types'

describe('el KDS entrega el contacto del cliente (Tarea 4)', () => {
  let venueId: string, orgId: string, staffId: string
  let link: DeliveryChannelLink
  let token: string

  // Mismo contacto que ingestaContacto.test.ts (Tarea 3), para que el valor esperado en las
  // dos pruebas de esta tarea sea el mismo texto que `contactoParaComanda` ya produce ahí.
  const CONTACTO_ESPERADO = '+52 33 1930 9789 · PIN 481 32 632'

  const pedido = (externalId: string, overrides: Partial<NormalizedDeliveryOrder> = {}): NormalizedDeliveryOrder => ({
    externalId,
    displayId: 'AB12C',
    source: OrderSource.UBER_EATS,
    items: [
      {
        externalId: 'item-1',
        name: 'Cochinita',
        quantity: 1,
        unitPrice: '100.00',
        total: '100.00',
      },
    ],
    payment: {
      currency: 'MXN',
      saleAmount: '100.00',
      merchantFees: '0.00',
      tipAmount: '0.00',
      externallyPaidSale: '100.00',
      externallyPaidTip: '0.00',
      cashDueSale: '0.00',
      cashDueTip: '0.00',
    },
    customer: { name: 'Avoqado S.', phone: '+52 33 1930 9789', phonePin: '481 32 632' },
    raw: { fuente: 'test' },
    placedAt: new Date(),
    ...overrides,
  })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org kds-contacto ${Date.now()}`, email: `kds-contacto${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({
      data: { organizationId: orgId, name: `V kds-contacto ${Date.now()}`, slug: `v-kds-contacto-${Date.now()}` },
    })
    venueId = v.id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: `store-${Date.now()}`, webhookSecret: 'x' },
    })

    const staff = await prisma.staff.create({
      data: { email: `kds-contacto-staff-${Date.now()}@t.mx`, firstName: 'KDS', lastName: 'Contacto' },
    })
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
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.order.deleteMany({ where: { venueId } })
      // KdsOrder tiene FK a Venue: si no se borra, el deleteMany de venue de abajo truena.
      await prisma.kdsOrder.deleteMany({ where: { venueId } })
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

  it('GET /kds/orders devuelve el contacto del cliente de un pedido de reparto', async () => {
    await ingestDeliveryOrder(pedido(`http-${Date.now()}`), link)

    const res = await request(app)
      .get(`/api/v1/mobile/venues/${venueId}/kds/orders`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].customerName).toBe('Avoqado S.')
    expect(res.body.data[0].customerContact).toBe(CONTACTO_ESPERADO)
  })

  it('un pedido PROGRAMADO liberado después nace con el contacto', async () => {
    const futuro = new Date(Date.now() + 60 * 60 * 1000)
    const { order } = await ingestDeliveryOrder(pedido(`programado-${Date.now()}`, { scheduledFor: futuro }), link)

    // Un pedido programado no va a la cocina al recibirse: cocinarlo al llegar tira la comida.
    await expect(prisma.kdsOrder.count({ where: { orderId: order.id } })).resolves.toBe(0)

    const resultado = await releaseScheduledOrder(order.externalId!)
    expect(resultado.outcome).toBe('RELEASED')

    const kds = await prisma.kdsOrder.findFirstOrThrow({ where: { orderId: order.id } })
    expect(kds.customerName).toBe('Avoqado S.')
    expect(kds.customerContact).toContain('PIN')
    expect(kds.customerContact).toBe(CONTACTO_ESPERADO)
  })
})
