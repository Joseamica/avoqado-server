import fs from 'fs'
import path from 'path'
import { DeliveryChannelLink, DeliveryProvider } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'

// El pedido real de Uber (`pedido-real-uapi.json`) trae contacto con PIN
// (`d4a07394-...` como cart_item_id de su único renglón). Este caso cierra el círculo
// de la Tarea 3: que la ingesta persista lo que el mapper (Tarea 2) ya extrae —
// contacto, PIN, identidad de línea del proveedor y el link que originó el pedido —
// tanto en la venta (`Order`/`OrderItem`) como en la comanda (`KdsOrder`/`KdsOrderItem`).
describe('la ingesta persiste contacto, identidad de línea y link originador', () => {
  let venueId: string, orgId: string
  let link: DeliveryChannelLink

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org contacto ${Date.now()}`, email: `contacto${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({
      data: { organizationId: orgId, name: `V contacto ${Date.now()}`, slug: `v-contacto-${Date.now()}` },
    })
    venueId = v.id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: `store-${Date.now()}`, webhookSecret: 'x' },
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
      await prisma.order.deleteMany({ where: { venueId } })
      // KdsOrder tiene FK a Venue: si no se borra, el deleteMany de venue de abajo truena.
      await prisma.kdsOrder.deleteMany({ where: { venueId } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId } })
      await prisma.venueTenderType.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.shift.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch {
      /* fixtures */
    }
  })

  it('guarda contacto, PIN, link originador e identidad de línea', async () => {
    // Clon propio del fixture (igual que uberOrderIngestion.test.ts): mutar el JSON
    // importado por otras suites las contaminaría, y `order.id` debe ser único por corrida.
    const crudo = JSON.parse(fs.readFileSync(path.join(__dirname, '../../fixtures/delivery/uber/pedido-real-uapi.json'), 'utf8'))
    crudo.order.id = `uapi-contacto-${Date.now()}`
    const normalized = uberAdapter.normalizeOrder(crudo)

    const { order } = await ingestDeliveryOrder(normalized, link)

    const persisted = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } })
    expect(persisted.customerName).toBe('Avoqado S.')
    expect(persisted.customerPhone).toBe('+52 33 1930 9789')
    expect(persisted.customerPhonePin).toBe('481 32 632')
    expect(persisted.deliveryChannelLinkId).toBe(link.id)
    expect(persisted.items.length).toBeGreaterThan(0)
    expect(persisted.items.every(i => i.externalLineId)).toBe(true)

    const kds = await prisma.kdsOrder.findFirstOrThrow({ where: { orderId: order.id }, include: { items: true } })
    expect(kds.customerName).toBe('Avoqado S.')
    expect(kds.customerContact).toBe('+52 33 1930 9789 · PIN 481 32 632')
    expect(kds.items.length).toBeGreaterThan(0)
    expect(kds.items.every(i => i.orderItemId && i.externalLineId)).toBe(true)
  })
})
