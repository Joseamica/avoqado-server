/**
 * Integration (REAL DB) — Tarea 12 del KDS de Uber: `applyLineRemoval`, la ÚNICA aplicación
 * del retiro de un renglón (spec §3.0 [N-7][N-21]). Idempotente, reparadora, bajo el candado
 * del pedido; y los dos productores de comandas (ingesta y liberación de un programado)
 * crean la comanda bajo ese mismo candado, así que una comanda nacida DESPUÉS de un retiro
 * nace marcada.
 */
import { DeliveryChannelLink, DeliveryProvider, OrderSource } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { releaseScheduledOrder } from '@/services/delivery-channels/core/releaseScheduledOrder.service'
import { withDeliveryOrderLock } from '@/services/delivery-channels/core/deliveryOrderLock'
import { applyLineRemoval } from '@/services/delivery-channels/core/lineRemoval.service'
import type { NormalizedDeliveryOrder } from '@/services/delivery-channels/core/types'

const PREFIJO = 'RETIRADO · '

describe('applyLineRemoval (Tarea 12)', () => {
  let venueId: string, orgId: string
  let link: DeliveryChannelLink
  let n = 0

  const pedido = (overrides: Partial<NormalizedDeliveryOrder> = {}): NormalizedDeliveryOrder => ({
    externalId: `retiro-${Date.now()}-${++n}`,
    displayId: 'RT12',
    source: OrderSource.UBER_EATS,
    items: [
      { externalId: 'item-a', lineId: 'linea-a', name: 'Cochinita', quantity: 1, unitPrice: '100.00', total: '100.00' },
      { externalId: 'item-b', lineId: 'linea-b', name: 'Horchata', quantity: 1, unitPrice: '50.00', total: '50.00' },
    ],
    payment: {
      currency: 'MXN',
      saleAmount: '150.00',
      merchantFees: '0.00',
      tipAmount: '0.00',
      externallyPaidSale: '150.00',
      externallyPaidTip: '0.00',
      cashDueSale: '0.00',
      cashDueTip: '0.00',
    },
    customer: { name: 'Cliente T12' },
    raw: { fuente: 'test' },
    placedAt: new Date(),
    ...overrides,
  })

  /** Una venta con su comanda, como la deja la ingesta real. */
  async function sembrar(overrides: Partial<NormalizedDeliveryOrder> = {}) {
    const normalized = pedido(overrides)
    const { order } = await ingestDeliveryOrder(normalized, link)
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, orderBy: { externalLineId: 'asc' } })
    const [itemA, itemB] = items // linea-a, linea-b
    return { order, itemA, itemB, normalized }
  }

  /** Una comanda nacida SIN la marca (p. ej. antes de este cambio, o por una carrera). */
  async function crearComandaSinMarca(orderId: string, orderItemId: string | null, externalLineId: string | null, nombre = 'Cochinita') {
    return prisma.kdsOrder.create({
      data: {
        venueId,
        orderNumber: 'RT12-B',
        orderType: 'DELIVERY',
        orderId,
        items: { create: [{ productName: nombre, quantity: 1, orderItemId, externalLineId }] },
      },
    })
  }

  const renglonesDe = (orderId: string) => prisma.kdsOrderItem.findMany({ where: { kdsOrder: { orderId } }, orderBy: { id: 'asc' } })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org retiro ${Date.now()}`, email: `retiro${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({
      data: { organizationId: orgId, name: `V retiro ${Date.now()}`, slug: `v-retiro-${Date.now()}` },
    })
    venueId = v.id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: `store-retiro-${Date.now()}`, webhookSecret: 'x' },
    })
  })

  afterAll(async () => {
    try {
      const orders = await prisma.order.findMany({ where: { venueId }, select: { id: true } })
      const ids = orders.map(o => o.id)
      await prisma.deliveryLineAction.deleteMany({ where: { venueId } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.paymentAllocation.deleteMany({
        where: { paymentId: { in: (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id) } },
      })
      await prisma.payment.deleteMany({ where: { venueId } })
      await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } })
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.order.deleteMany({ where: { venueId } })
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

  it('marca el OrderItem y TODAS las comandas del pedido con prefijo RETIRADO, y confirma la acción', async () => {
    const { order, itemA, itemB } = await sembrar()
    await crearComandaSinMarca(order.id, itemA.id, 'linea-a')

    await withDeliveryOrderLock(order.id, tx => applyLineRemoval(tx, { orderId: order.id, orderItemId: itemA.id, origin: 'PROVIDER' }))

    const oi = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemA.id } })
    expect(oi.removedAt).not.toBeNull()
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: itemB.id } })).removedAt).toBeNull()

    const renglones = await renglonesDe(order.id)
    const deA = renglones.filter(r => r.orderItemId === itemA.id)
    expect(deA).toHaveLength(2) // la de la ingesta + la segunda comanda
    for (const r of deA) {
      expect(r.removedAt).not.toBeNull()
      expect(r.productName).toBe(`${PREFIJO}Cochinita`)
    }
    const deB = renglones.filter(r => r.orderItemId === itemB.id)
    expect(deB.every(r => r.removedAt === null && !r.productName.startsWith(PREFIJO))).toBe(true)

    const accion = await prisma.deliveryLineAction.findUniqueOrThrow({
      where: { orderId_lineId_action: { orderId: order.id, lineId: 'linea-a', action: 'REMOVE_ITEM' } },
    })
    expect(accion.status).toBe('CONFIRMED')
    expect(accion.origin).toBe('PROVIDER')
    expect(accion.settlement).toBe('PENDING')
    expect(accion.orderItemId).toBe(itemA.id)
    expect(accion.storeId).toBe(link.externalLocationId)

    expect(await prisma.activityLog.count({ where: { venueId, action: 'DELIVERY_ITEM_REMOVED', entityId: order.id } })).toBe(1)
  })

  it('es REPARADORA: con OrderItem.removedAt ya puesto, marca una comanda que nacio sin la marca', async () => {
    const { order, itemA } = await sembrar()
    await prisma.orderItem.update({ where: { id: itemA.id }, data: { removedAt: new Date() } })
    const nueva = await crearComandaSinMarca(order.id, itemA.id, 'linea-a')

    await withDeliveryOrderLock(order.id, tx => applyLineRemoval(tx, { orderId: order.id, orderItemId: itemA.id, origin: 'PROVIDER' }))

    const linea = await prisma.kdsOrderItem.findFirstOrThrow({ where: { kdsOrderId: nueva.id } })
    expect(linea.removedAt).not.toBeNull()
    expect(linea.productName.startsWith(PREFIJO)).toBe(true)
  })

  it('repara una comanda vieja SIN orderItemId por el id de línea del proveedor', async () => {
    const { order, itemA } = await sembrar()
    const vieja = await crearComandaSinMarca(order.id, null, 'linea-a')

    await withDeliveryOrderLock(order.id, tx => applyLineRemoval(tx, { orderId: order.id, orderItemId: itemA.id, origin: 'PROVIDER' }))

    const linea = await prisma.kdsOrderItem.findFirstOrThrow({ where: { kdsOrderId: vieja.id } })
    expect(linea.removedAt).not.toBeNull()
    expect(linea.productName).toBe(`${PREFIJO}Cochinita`)
  })

  it('no duplica el prefijo RETIRADO al reparar dos veces (idempotente)', async () => {
    const { order, itemA } = await sembrar()
    const aplicar = () =>
      withDeliveryOrderLock(order.id, tx => applyLineRemoval(tx, { orderId: order.id, orderItemId: itemA.id, origin: 'PROVIDER' }))

    await aplicar()
    const antes = await renglonesDe(order.id)
    const itemAntes = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemA.id } })
    await aplicar()
    const despues = await renglonesDe(order.id)

    expect(despues).toEqual(antes)
    expect(despues.filter(r => r.orderItemId === itemA.id).map(r => r.productName)).toEqual([`${PREFIJO}Cochinita`])
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: itemA.id } })).removedAt).toEqual(itemAntes.removedAt)
    expect(await prisma.activityLog.count({ where: { venueId, action: 'DELIVERY_ITEM_REMOVED', entityId: order.id } })).toBe(1)
  })

  it('NO toca settlement ni refundPaymentId de una accion ya REFUNDED', async () => {
    const { order, itemA } = await sembrar()
    const accion = await prisma.deliveryLineAction.create({
      data: {
        venueId,
        orderId: order.id,
        orderItemId: itemA.id,
        provider: DeliveryProvider.UBER_EATS,
        externalOrderId: 'x',
        storeId: link.externalLocationId,
        lineId: 'linea-a',
        action: 'REMOVE_ITEM',
        status: 'CONFIRMED',
        settlement: 'REFUNDED',
        refundPaymentId: 'pay_1',
        origin: 'STAFF',
      },
    })

    await withDeliveryOrderLock(order.id, tx => applyLineRemoval(tx, { orderId: order.id, orderItemId: itemA.id, origin: 'PROVIDER' }))

    const despues = await prisma.deliveryLineAction.findUniqueOrThrow({ where: { id: accion.id } })
    expect(despues.settlement).toBe('REFUNDED')
    expect(despues.refundPaymentId).toBe('pay_1')
    expect(despues.origin).toBe('STAFF')
  })

  it('una accion del cajero en duda (UNCERTAIN) pasa a CONFIRMED sin tocar settlement', async () => {
    const { order, itemA } = await sembrar()
    const accion = await prisma.deliveryLineAction.create({
      data: {
        venueId,
        orderId: order.id,
        orderItemId: itemA.id,
        provider: DeliveryProvider.UBER_EATS,
        externalOrderId: 'x',
        storeId: link.externalLocationId,
        lineId: 'linea-a',
        action: 'REMOVE_ITEM',
        status: 'UNCERTAIN',
        origin: 'STAFF',
      },
    })

    await withDeliveryOrderLock(order.id, tx => applyLineRemoval(tx, { orderId: order.id, orderItemId: itemA.id, origin: 'PROVIDER' }))

    const despues = await prisma.deliveryLineAction.findUniqueOrThrow({ where: { id: accion.id } })
    expect(despues.status).toBe('CONFIRMED')
    expect(despues.settlement).toBe('PENDING')
    expect(despues.origin).toBe('STAFF')
  })

  it('un renglón de OTRO pedido no se retira (el pedido se resuelve primero)', async () => {
    const a = await sembrar()
    const b = await sembrar()

    await expect(
      withDeliveryOrderLock(a.order.id, tx => applyLineRemoval(tx, { orderId: a.order.id, orderItemId: b.itemA.id, origin: 'PROVIDER' })),
    ).rejects.toThrow()
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: b.itemA.id } })).removedAt).toBeNull()
  })

  it('la comanda de la INGESTA nace con la marca si la linea ya fue retirada', async () => {
    // Carrera N-21: la venta se guardó, el proceso murió antes de crear la comanda, y el
    // proveedor retiró el renglón en ese hueco. El reproceso del webhook crea la comanda.
    const { order, itemA, normalized } = await sembrar()
    await prisma.kdsOrder.deleteMany({ where: { orderId: order.id } })
    await prisma.orderItem.update({ where: { id: itemA.id }, data: { removedAt: new Date() } })

    const r = await ingestDeliveryOrder(normalized, link)
    expect(r.kitchenTicketCreated).toBe(true)

    const renglones = await renglonesDe(order.id)
    const a = renglones.find(x => x.orderItemId === itemA.id)!
    expect(a.removedAt).not.toBeNull()
    expect(a.productName).toBe(`${PREFIJO}Cochinita`)
    const b = renglones.find(x => x.externalLineId === 'linea-b')!
    expect(b.removedAt).toBeNull()
    expect(b.productName).toBe('Horchata')
  })

  it('un pedido PROGRAMADO liberado despues de un retiro nace con el renglon RETIRADO', async () => {
    const { order, itemA, itemB } = await sembrar({ scheduledFor: new Date(Date.now() + 60 * 60 * 1000) })
    expect(await prisma.kdsOrder.count({ where: { orderId: order.id } })).toBe(0)
    await prisma.orderItem.update({ where: { id: itemA.id }, data: { removedAt: new Date() } })

    expect((await releaseScheduledOrder(order.externalId!)).outcome).toBe('RELEASED')

    const renglones = await renglonesDe(order.id)
    const a = renglones.find(x => x.orderItemId === itemA.id)!
    expect(a.removedAt).not.toBeNull()
    expect(a.productName).toBe(`${PREFIJO}Cochinita`)
    const b = renglones.find(x => x.orderItemId === itemB.id)!
    expect(b.removedAt).toBeNull()
    expect(b.externalLineId).toBe('linea-b')
  })
})
