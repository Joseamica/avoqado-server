/** Precondición cash futura2b: filas propias pendientes, sin quitar el bloqueo del mapper ni crear pedidos DEV. */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cancelOrder, mergeOrders, returnGiftBalanceAndCancelOrder } from '@/services/mobile/order.mobile.service'
import { deleteOrder, updateOrder } from '@/services/dashboard/order.dashboard.service'
import { voidItems } from '@/services/tpv/order.tpv.service'
import { cancelDeliveryOrder } from '@/services/delivery-channels/core/cancelDeliveryOrder.service'

describe('Rappi: ninguna cancelación local se hace pasar por la del proveedor', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined

  beforeAll(async () => {
    const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    orgId = (
      await prisma.organization.create({ data: { name: 'Rappi cancelación', email: `${sufijo}@example.test`, phone: '5500000000' } })
    ).id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Rappi cancelación', slug: `rappi-cancel-${sufijo}` } })).id
    staffId = (await prisma.staff.create({ data: { email: `staff-${sufijo}@example.test`, firstName: 'QA', lastName: 'Rappi' } })).id
    await prisma.staffVenue.create({ data: { venueId, staffId, role: 'OWNER' } })
  })

  afterAll(async () => {
    if (!venueId || !orgId) return
    await prisma.kdsOrder.deleteMany({ where: { venueId } })
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  async function nueva(rappi = true) {
    const o = await prisma.order.create({
      data: {
        venueId: venueId!,
        orderNumber: 'Rappi QA',
        source: rappi ? 'RAPPI' : 'TPV',
        originSystem: rappi ? 'DELIVERY_PLATFORM' : 'AVOQADO',
        status: 'CONFIRMED',
        subtotal: new Prisma.Decimal(100),
        total: new Prisma.Decimal(100),
        taxAmount: new Prisma.Decimal(0),
        remainingBalance: new Prisma.Decimal(100),
        contratoDePrecio: 'IVA_INCLUIDO',
        posRawData: { order_detail: { delivery_method: 'marketplace' } },
        items: {
          create: {
            productName: 'Artículo QA',
            quantity: 1,
            unitPrice: new Prisma.Decimal(100),
            total: new Prisma.Decimal(100),
            taxAmount: new Prisma.Decimal(0),
          },
        },
      },
      include: { items: true },
    })
    await prisma.kdsOrder.create({
      data: {
        venueId: venueId!,
        orderId: o.id,
        orderNumber: o.orderNumber,
        items: { create: { productName: 'Artículo QA', quantity: 1, orderItemId: o.items[0].id } },
      },
    })
    return o
  }

  async function foto() {
    return {
      orders: await prisma.order.findMany({ where: { venueId: venueId! }, orderBy: { id: 'asc' } }),
      items: await prisma.orderItem.findMany({ where: { order: { venueId: venueId! } }, orderBy: { id: 'asc' } }),
      kitchen: await prisma.kdsOrder.findMany({
        where: { venueId: venueId! },
        orderBy: { id: 'asc' },
        include: { items: { orderBy: { id: 'asc' } } },
      }),
      payments: await prisma.payment.findMany({ where: { venueId: venueId! }, orderBy: { id: 'asc' } }),
    }
  }

  it.each(['mobile', 'delete', 'CANCELLED', 'DELETED', 'void', 'merge-source', 'merge-target', 'gift-return'])(
    '%s rechaza sin cambiar pedido, cocina, pagos ni renglones',
    async ruta => {
      const o = await nueva()
      const otra = ruta.startsWith('merge') ? await nueva(false) : null
      const antes = await foto()
      const cancelar = () => {
        switch (ruta) {
          case 'mobile':
            return cancelOrder(venueId!, o.id, 'QA', staffId)
          case 'delete':
            return deleteOrder(venueId!, o.id)
          case 'CANCELLED':
          case 'DELETED':
            return updateOrder(venueId!, o.id, { status: ruta })
          case 'void':
            return voidItems(venueId!, o.id, {
              itemIds: o.items.map(i => i.id),
              expectedVersion: o.version,
              staffId: staffId!,
              reason: 'QA',
            })
          case 'merge-source':
            return mergeOrders(venueId!, otra!.id, o.id, staffId)
          case 'merge-target':
            return mergeOrders(venueId!, o.id, otra!.id, staffId)
          default:
            return returnGiftBalanceAndCancelOrder(venueId!, o.id, { staffId: staffId!, operationKey: 'qa-rappi-cancel-001' })
        }
      }
      await expect(cancelar()).rejects.toMatchObject({
        statusCode: 400,
        code: 'RAPPI_CANCEL_IN_PROVIDER',
        message: expect.stringContaining('app de Rappi para aliados'),
      })
      expect(await foto()).toEqual(antes)
    },
  )

  it('control: una venta normal sin dinero sigue cancelándose', async () => {
    const o = await nueva(false)
    await cancelOrder(venueId!, o.id, 'QA', staffId)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('CANCELLED')
    expect(await prisma.kdsOrder.count({ where: { venueId: venueId!, orderId: o.id } })).toBe(0)
  })

  it('control: el aviso real del proveedor sí cancela Rappi y retira su cocina', async () => {
    const o = await nueva()
    await prisma.order.update({ where: { id: o.id }, data: { externalId: `RAPPI:${o.id}` } })
    await expect(cancelDeliveryOrder(o.id, 'RAPPI', 'QA del aviso del proveedor')).resolves.toMatchObject({
      outcome: 'CANCELLED',
      orderId: o.id,
    })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('CANCELLED')
    expect(await prisma.kdsOrder.count({ where: { venueId: venueId!, orderId: o.id } })).toBe(0)
    // Los efectos de bitácora existentes son posteriores al commit; terminan antes de limpiar nuestras filas.
    await new Promise(resolve => setImmediate(resolve))
  })
})
