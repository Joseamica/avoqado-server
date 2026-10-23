/**
 * Integration (Postgres REAL) — Rappi 2b: un pedido con repartidor propio pagado en EFECTIVO entra con el envío como RENGLÓN y
 * con lo que el negocio cobra por cuenta de Rappi aparte (diseño 2026-10-23, T1/T3/T9).
 *
 * Pedido real DEV 881655210 (marketplace/cash): Burger 140 + envío 35 + tarifa de servicio 10 + propina 20 = 205 en efectivo.
 *
 * Sólo crea filas propias (sufijo único) y las borra en `afterAll`, falle o no.
 */
import { DeliveryProvider, OrderSource, type DeliveryChannelLink } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { normalizeRappiOrder } from '@/services/delivery-channels/providers/rappi/rappi.mapper'
import pedido881655210 from '../../unit/services/delivery-channels/fixtures/rappi/sandbox/new-order-marketplace-efectivo.json'
import pedidoM10EnLinea from '../../unit/services/delivery-channels/fixtures/rappi/sandbox/new-order-marketplace-propina.json'

jest.setTimeout(60_000)

/** 🔴 La base es compartida por ~20 sesiones: fuera de una base de PRUEBAS no se toca nada. */
const esBaseDePrueba = (nombre: string) => nombre === 'av-db-25-test' || /^(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(nombre)
{
  const url = new URL(process.env.DATABASE_URL ?? '')
  const nombre = decodeURIComponent(url.pathname.slice(1))
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !esBaseDePrueba(nombre)) {
    throw new Error(`Base inesperada para esta prueba: ${url.hostname}/${nombre}`)
  }
}

describe('Rappi 2b: ingesta de un pedido con repartidor propio en efectivo', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let orgId: string | undefined
  let venueId: string | undefined
  let link: DeliveryChannelLink
  const venuesExtra: string[] = []

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({
        data: { name: `Org efectivo-it ${sufijo}`, email: `efectivo-it-${sufijo}@t.mx`, phone: '5555555555' },
      })
    ).id
    venueId = (
      await prisma.venue.create({ data: { organizationId: orgId, name: `V efectivo-it ${sufijo}`, slug: `v-efectivo-it-${sufijo}` } })
    ).id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.RAPPI, externalLocationId: `rappi-efectivo-it-${sufijo}`, webhookSecret: 'x' },
    })
  })

  afterAll(async () => {
    if (!venueId || !orgId) return
    try {
      for (const v of venuesExtra) {
        const extra = (await prisma.order.findMany({ where: { venueId: v }, select: { id: true } })).map(o => o.id)
        await prisma.kdsOrder.deleteMany({ where: { venueId: v } })
        await prisma.orderItem.deleteMany({ where: { orderId: { in: extra } } })
        await prisma.order.deleteMany({ where: { venueId: v } })
        await prisma.deliveryChannelLink.deleteMany({ where: { venueId: v } })
        await prisma.activityLog.deleteMany({ where: { venueId: v } })
        await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId: v } })
        await prisma.venueTenderType.deleteMany({ where: { venueId: v } })
        await prisma.product.deleteMany({ where: { venueId: v } })
        await prisma.menuCategory.deleteMany({ where: { venueId: v } })
        await prisma.venue.deleteMany({ where: { id: v } })
      }
      const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true } })).map(o => o.id)
      const pagos = (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id)
      await prisma.deliveryOrderEvent.deleteMany({ where: { venueId } })
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
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch (e) {
      console.error(`efectivo-it ${sufijo}: la limpieza falló (quedaron filas propias)`, e)
    }
  })

  /** El pedido real, con un folio propio de esta corrida (el `order_id` es la llave de idempotencia). */
  function conFolio<T extends { order_detail: { order_id: string } }>(raw: T, n: string): T {
    const copia = JSON.parse(JSON.stringify(raw))
    copia.order_detail.order_id = `${copia.order_detail.order_id}-${sufijo}-${n}`
    return copia
  }

  it('881655210: dos renglones (Burger 140 + Envío 35), 205 por cobrar, tarifa de Rappi aparte y sólo la Burger en cocina', async () => {
    const normalizado = normalizeRappiOrder(conFolio(pedido881655210, 'a'))
    const { order } = await ingestDeliveryOrder(normalizado, link)

    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, payments: true } })
    expect(o.source).toBe(OrderSource.RAPPI)
    expect(o.subtotal.toFixed(2)).toBe('175.00')
    expect(o.total.toFixed(2)).toBe('175.00')
    expect(o.tipAmount.toFixed(2)).toBe('20.00')
    expect(o.cashTipDue?.toFixed(2)).toBe('20.00')
    expect(o.thirdPartyCashDue?.toFixed(2)).toBe('10.00')
    expect(o.paidAmount.toFixed(2)).toBe('0.00')
    expect(o.remainingBalance.toFixed(2)).toBe('205.00')
    expect(o.paymentStatus).toBe('PENDING')
    expect(o.payments).toHaveLength(0)

    const renglones = o.items.map(i => [i.productName, i.total.toFixed(2)]).sort()
    expect(renglones).toEqual([
      ['Envío', '35.00'],
      ['Grilled Chicken Burger', '140.00'],
    ])
    const envio = o.items.find(i => i.productName === 'Envío')!
    expect(envio.externalId).toMatch(/-envio$/)
    const producto = await prisma.product.findUniqueOrThrow({ where: { id: envio.productId! } })
    expect(producto.satProductKey).toBe('78102203')
    expect(producto.active).toBe(false)

    const cocina = await prisma.kdsOrder.findMany({ where: { orderId: order.id }, include: { items: true } })
    expect(cocina.flatMap(k => k.items.map(i => i.productName))).toEqual(['Grilled Chicken Burger'])
  })

  it('la reingesta del mismo pedido no crea renglones, pagos ni comandas nuevas', async () => {
    const raw = conFolio(pedido881655210, 'b')
    const { order } = await ingestDeliveryOrder(normalizeRappiOrder(raw), link)
    await ingestDeliveryOrder(normalizeRappiOrder(raw), link)

    expect(await prisma.orderItem.count({ where: { orderId: order.id } })).toBe(2)
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0)
    expect(await prisma.kdsOrder.count({ where: { orderId: order.id } })).toBe(1)
  })

  it('M10 en línea: el envío también es renglón y lo liquidado por Rappi no cambia (55 + propina 20)', async () => {
    const { order } = await ingestDeliveryOrder(normalizeRappiOrder(conFolio(pedidoM10EnLinea, 'c')), link)

    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, payments: true } })
    expect(o.subtotal.toFixed(2)).toBe('55.00')
    expect(o.total.toFixed(2)).toBe('55.00')
    expect(o.thirdPartyCashDue).toBeNull()
    expect(o.cashTipDue).toBeNull()
    expect(o.remainingBalance.toFixed(2)).toBe('0.00')
    expect(o.paymentStatus).toBe('PAID')
    expect(o.items.map(i => i.productName).sort()).toEqual(['Agua Mineral 1L', 'Envío'].sort())
    expect(o.payments.map(p => [p.amount.toFixed(2), p.tipAmount.toFixed(2)])).toEqual([['55.00', '20.00']])
  })

  it('#7 un producto ajeno con SKU «delivery-envio» y existencias NO se usa como envío ni se toca', async () => {
    // Un negocio propio de esta prueba: en el de arriba el «Envío» ya existe con ese SKU.
    const otroVenue = (
      await prisma.venue.create({ data: { organizationId: orgId!, name: `V2 efectivo-it ${sufijo}`, slug: `v2-efectivo-it-${sufijo}` } })
    ).id
    const otroLink = await prisma.deliveryChannelLink.create({
      data: {
        venueId: otroVenue,
        provider: DeliveryProvider.RAPPI,
        externalLocationId: `rappi-efectivo-it2-${sufijo}`,
        webhookSecret: 'x',
      },
    })
    venuesExtra.push(otroVenue)
    const categoria = await prisma.menuCategory.create({ data: { venueId: otroVenue, name: 'Ajena', slug: `ajena-${sufijo}` } })
    const ajeno = await prisma.product.create({
      data: {
        venueId: otroVenue,
        sku: 'delivery-envio',
        name: 'Caja de envío (producto del negocio)',
        price: 15,
        categoryId: categoria.id,
        trackInventory: true,
        inventoryMethod: 'QUANTITY',
      },
    })
    const { order } = await ingestDeliveryOrder(normalizeRappiOrder(conFolio(pedido881655210, 'd')), otroLink)
    const envio = (await prisma.orderItem.findMany({ where: { orderId: order.id } })).find(i => i.productName === 'Envío')!
    expect(envio.productId).not.toBe(ajeno.id)
    const producto = await prisma.product.findUniqueOrThrow({ where: { id: envio.productId! } })
    expect(producto.trackInventory).toBe(false)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: ajeno.id } })).name).toBe('Caja de envío (producto del negocio)')
  })
})
