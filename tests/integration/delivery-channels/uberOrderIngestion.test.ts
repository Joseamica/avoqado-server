import { DeliveryProvider, OrderSource, OriginSystem, PaymentMethod, PaymentFundsFlow, TransactionStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ingestUberOrder } from '@/services/delivery-channels/providers/uber-eats/uber.orderIngestion.service'
import { UBER_EXTERNAL_ID_PREFIX } from '@/services/delivery-channels/providers/uber-eats/uber.productResolver'
import type { NormalizedUberOrder } from '@/services/delivery-channels/providers/uber-eats/uber.types'

// Spec paso 7: el evento se vuelve VENTA — Order + líneas + Payment + inventario,
// todo en UNA transacción. Contra PostgreSQL real: el unique de externalId y la
// idempotencia no se prueban con Prisma mockeado.
describe('ingesta de pedido Uber → Order + Payment (durable)', () => {
  let venueId: string, orgId: string, productId: string, linkId: string

  const pedido = (externalId: string, itemExternalId = 'Cochinita_de_Doña_Si'): NormalizedUberOrder => ({
    externalId,
    displayId: 'AB12C',
    items: [
      {
        externalId: itemExternalId,
        name: 'Cochinita',
        quantity: 2,
        unitPrice: '304.00',
        total: '608.00',
        modifiers: [{ externalId: 'Leche_entera', name: 'Leche entera', quantity: 1, price: '10.00' }],
      },
    ],
    payment: {
      currency: 'MXN',
      saleAmount: '608.00',
      merchantFees: '30.00',
      tipAmount: '20.00',
      externallyPaidSale: '638.00',
      externallyPaidTip: '20.00',
      cashDueSale: '0.00',
      cashDueTip: '0.00',
    },
    raw: { fuente: 'test' },
  })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org ing ${Date.now()}`, email: `i${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({ data: { organizationId: orgId, name: `V ing ${Date.now()}`, slug: `vi-${Date.now()}` } })
    venueId = v.id
    const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cat', slug: `ci-${Date.now()}` } })
    const p = await prisma.product.create({
      data: {
        venueId,
        categoryId: cat.id,
        name: 'Cochinita',
        sku: `SKU-${Date.now()}`,
        externalId: `${UBER_EXTERNAL_ID_PREFIX}Cochinita_de_Doña_Si`,
        price: '304.00',
      },
    })
    productId = p.id
    const link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: `store-${Date.now()}`, webhookSecret: 'x' },
    })
    linkId = link.id
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

  it('crea la Order con el namespace del proveedor y sin mesero ni turno', async () => {
    const r = await ingestUberOrder(pedido('ord-1'), { linkId, venueId })
    const o = await prisma.order.findUnique({ where: { id: r.orderId } })
    expect(o!.externalId).toBe('UBER_EATS:ord-1') // namespaceado: dos proveedores pueden repetir folio
    expect(o!.source).toBe(OrderSource.UBER_EATS)
    expect(o!.originSystem).toBe(OriginSystem.DELIVERY_PLATFORM)
    expect(o!.servedById).toBeNull() // no hay mesero
    expect(o!.shiftId).toBeNull() // no pertenece a un turno
    expect(o!.total.toString()).toBe('658') // 608 + 30 + 20
    expect(o!.subtotal.toString()).toBe('608')
  })

  it('resuelve el producto y guarda snapshot + modificadores', async () => {
    const r = await ingestUberOrder(pedido('ord-2'), { linkId, venueId })
    const items = await prisma.orderItem.findMany({ where: { orderId: r.orderId }, include: { modifiers: true } })
    expect(items).toHaveLength(1)
    expect(items[0].productId).toBe(productId)
    expect(items[0].productName).toBe('Cochinita') // snapshot, sobrevive si el producto cambia
    expect(items[0].quantity).toBe(2)
    expect(items[0].originSystem).toBe(OriginSystem.DELIVERY_PLATFORM)
    expect(items[0].modifiers).toHaveLength(1)
    expect(items[0].modifiers[0].name).toBe('Leche entera')
  })

  it('crea el Payment con tender del canal y fundsFlow EXTERNAL_RECORDED', async () => {
    const r = await ingestUberOrder(pedido('ord-3'), { linkId, venueId })
    const p = await prisma.payment.findFirst({ where: { orderId: r.orderId } })
    expect(p).not.toBeNull()
    expect(p!.amount.toString()).toBe('638') // venta + fees, SIN propina
    expect(p!.tipAmount.toString()).toBe('20') // propina aparte: no se cuenta dos veces
    expect(p!.method).toBe(PaymentMethod.OTHER)
    expect(p!.fundsFlow).toBe(PaymentFundsFlow.EXTERNAL_RECORDED) // Avoqado NO deposita este dinero
    expect(p!.status).toBe(TransactionStatus.COMPLETED)
    expect(p!.tenderTypeId).not.toBeNull() // el tender se autoprovisionó
  })

  it('deja la cuenta cuadrada: paidAmount y remainingBalance coherentes', async () => {
    const r = await ingestUberOrder(pedido('ord-4'), { linkId, venueId })
    const o = await prisma.order.findUnique({ where: { id: r.orderId } })
    expect(o!.paidAmount.toString()).toBe('658') // 638 + 20
    expect(o!.remainingBalance.toString()).toBe('0')
    expect(o!.paymentStatus).toBe('PAID')
  })

  it('IDEMPOTENTE: reingerir el mismo pedido no duplica Order ni Payment', async () => {
    const a = await ingestUberOrder(pedido('ord-5'), { linkId, venueId })
    const b = await ingestUberOrder(pedido('ord-5'), { linkId, venueId })
    expect(b.orderId).toBe(a.orderId)
    expect(b.alreadyExisted).toBe(true)
    expect(await prisma.payment.count({ where: { orderId: a.orderId } })).toBe(1)
  })

  it('producto que NO resuelve ⇒ la línea entra igual, marcada, sin productId', async () => {
    const r = await ingestUberOrder(pedido('ord-6', 'producto-que-no-existe'), { linkId, venueId })
    const items = await prisma.orderItem.findMany({ where: { orderId: r.orderId } })
    expect(items[0].productId).toBeNull() // no se adivina
    expect(items[0].productName).toBe('Cochinita') // pero el pedido NO se pierde
    expect(r.unresolvedItems).toBe(1) // y queda visible para revisión
  })

  it('rechaza si el split de dinero no cuadra (jamás inventa un cobro)', async () => {
    const malo = pedido('ord-7')
    malo.payment.externallyPaidSale = '999.00' // ya no cuadra con saleAmount + merchantFees
    await expect(ingestUberOrder(malo, { linkId, venueId })).rejects.toThrow(/no cuadra|invariante/i)
    expect(await prisma.order.count({ where: { venueId, externalId: 'UBER_EATS:ord-7' } })).toBe(0)
  })
})
