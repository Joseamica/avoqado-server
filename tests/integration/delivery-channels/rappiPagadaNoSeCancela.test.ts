/**
 * Integration (Postgres REAL) — un pedido de Rappi YA PAGADO no se cancela por el camino genérico (menor 3 de la Tarea 14 del
 * plan «Rappi fase 2»).
 *
 * Un pedido de Rappi nace PAID: el marketplace cobró al cliente y la ingesta lo registra así (`externallyPaidSale`). La Tarea
 * 14 quitó la cancelación «a escondidas» del camino de Rappi (`denyDeliveryOrder`), pero la cocina y el POS también cancelan
 * una orden por el camino GENÉRICO de las apps (`cancelOrder` → `cancelOrderInTransaction` → `assertOrderCancellableUnderLock`).
 * Ese guardia es lo que impide que un pedido de Rappi se cancele sólo de nuestro lado: «Ninguna orden CON DINERO ENCIMA se
 * cancela». En las pruebas unitarias el guardia está simulado; esto prueba lo que sólo la base puede decir: 400, y la orden, su
 * comanda y su pago intactos (la transacción de la cancelación se deshace entera, también el retiro de la comanda que va antes).
 *
 * Sólo crea filas propias (sufijo único) y las borra en `afterAll`, falle o no.
 */
import { DeliveryProvider, OrderSource, OrderStatus, type DeliveryChannelLink } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { cancelOrder } from '@/services/mobile/order.mobile.service'
import { assertOrderCancellableUnderLock } from '@/services/shared/orderCancelGuard'

jest.setTimeout(60_000)

/** 🔴 La base es compartida por ~20 sesiones: fuera de una base de PRUEBAS no se toca nada (mismo criterio que `rappiTopeDeListo.test.ts`). */
const esBaseDePrueba = (nombre: string) =>
  nombre === 'av-db-25-test' || /^(codex_testarudo_test_|avoqado_(?:[a-z0-9]+|cambio_r5)_test_)/.test(nombre)
{
  // A nivel de MÓDULO, no en un hook: corre antes de cualquier `beforeAll`/`afterAll`.
  const url = new URL(process.env.DATABASE_URL ?? '')
  const nombre = decodeURIComponent(url.pathname.slice(1))
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !esBaseDePrueba(nombre)) {
    throw new Error(`Base inesperada para esta prueba: ${url.hostname}/${nombre}`)
  }
}

describe('un pedido de Rappi PAID no se cancela por el camino genérico', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let orgId: string | undefined
  let venueId: string | undefined
  let link: DeliveryChannelLink

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({
        data: { name: `Org pagada-it ${sufijo}`, email: `pagada-it-${sufijo}@t.mx`, phone: '5555555555' },
      })
    ).id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V pagada-it ${sufijo}`, slug: `v-pagada-it-${sufijo}` } }))
      .id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.RAPPI, externalLocationId: `rappi-pagada-it-${sufijo}`, webhookSecret: 'x' },
    })
  })

  afterAll(async () => {
    // 🔴 jest-circus corre `afterAll` aunque `beforeAll` haya lanzado: sin ids propios no se borra nada.
    if (!venueId || !orgId) return
    try {
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
      console.error(`pagada-it ${sufijo}: la limpieza falló (quedaron filas propias)`, e)
    }
  })

  /** Una venta de Rappi como la deja la ingesta real: ya pagada por el marketplace y con su comanda en cocina. */
  async function ventaPagadaDeRappi(n: string) {
    const { order } = await ingestDeliveryOrder(
      {
        externalId: `pagada-it-${sufijo}-${n}`,
        displayId: `R-${n}`,
        source: OrderSource.RAPPI,
        items: [{ externalId: `sku-${n}`, name: `Tacos ${n}`, quantity: 1, unitPrice: '120.00', total: '120.00' }],
        payment: {
          currency: 'MXN',
          saleAmount: '120.00',
          merchantFees: '0.00',
          discountAmount: '0.00',
          tipAmount: '0.00',
          externallyPaidSale: '120.00',
          externallyPaidTip: '0.00',
          cashDueSale: '0.00',
          cashDueTip: '0.00',
        },
        raw: { fuente: 'test' },
        placedAt: new Date(),
      },
      link,
    )
    return order.id
  }

  /** Lo que la cancelación NO puede haber tocado: la orden, su comanda y su pago. */
  async function foto(orderId: string) {
    const orden = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, paymentStatus: true, paidAmount: true, version: true, specialRequests: true },
    })
    const comandas = await prisma.kdsOrder.findMany({ where: { orderId }, select: { id: true, status: true }, orderBy: { id: 'asc' } })
    const pagos = await prisma.payment.findMany({
      where: { orderId },
      select: { id: true, status: true, amount: true },
      orderBy: { id: 'asc' },
    })
    return { orden, comandas, pagos }
  }

  it('🔴 `cancelOrder` (el camino genérico de las apps) lanza 400 y deja la orden, su comanda y su pago intactos', async () => {
    const orderId = await ventaPagadaDeRappi('cancelar')
    const antes = await foto(orderId)
    // Premisa: es una orden pagada con comanda viva y un pago registrado (si no, la prueba no probaría nada).
    expect(antes.orden.paymentStatus).toBe('PAID')
    expect(antes.orden.status).not.toBe(OrderStatus.CANCELLED)
    expect(antes.comandas.length).toBeGreaterThan(0)
    expect(antes.pagos.length).toBeGreaterThan(0)

    const error = await cancelOrder(venueId!, orderId, 'prueba: cancelar un pedido de Rappi', 'staff-it').catch(e => e)

    expect(error).toBeInstanceOf(BadRequestError)
    expect(error.statusCode).toBe(400)
    // La transacción se deshizo entera: también el retiro de la comanda, que corre ANTES del guardia.
    expect(await foto(orderId)).toEqual(antes)
  })

  it('🔴 el guardia (`assertOrderCancellableUnderLock`) rechaza la orden pagada con 400 y no escribe nada', async () => {
    const orderId = await ventaPagadaDeRappi('guardia')
    const antes = await foto(orderId)

    const error = await prisma.$transaction(tx => assertOrderCancellableUnderLock(tx, { venueId: venueId!, orderId })).catch(e => e)

    expect(error).toBeInstanceOf(BadRequestError)
    expect(error.statusCode).toBe(400)
    expect(await foto(orderId)).toEqual(antes)
  })
})
