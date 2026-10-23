/**
 * Integration (Postgres REAL) — Rappi 2b, P3 (decisión del founder «A», 23-oct): la lista «Rappi · por cobrar» que las apps
 * muestran arriba en «Pedidos en línea». Sólo pedidos de plataforma con efectivo por cobrar (`thirdPartyCashDue` no nulo), vivos,
 * sin saldar, de este negocio; con el desglose venta / propina / Rappi en centavos; acotada por el servidor.
 *
 * Sólo crea filas propias (sufijo único) y las borra en `afterAll`, falle o no.
 */
import { DeliveryProvider, type DeliveryChannelLink } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { cancelDeliveryOrder } from '@/services/delivery-channels/core/cancelDeliveryOrder.service'
import { listDeliveryCashPending } from '@/services/delivery-channels/core/deliveryCashPending.service'
import { normalizeRappiOrder } from '@/services/delivery-channels/providers/rappi/rappi.mapper'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import pedido881655210 from '../../unit/services/delivery-channels/fixtures/rappi/sandbox/new-order-marketplace-efectivo.json'
import pedidoM10EnLinea from '../../unit/services/delivery-channels/fixtures/rappi/sandbox/new-order-marketplace-propina.json'

jest.setTimeout(60_000)
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

/** 🔴 La base es compartida por ~20 sesiones: fuera de una base de PRUEBAS no se toca nada. */
const esBaseDePrueba = (nombre: string) => nombre === 'av-db-25-test' || /^(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(nombre)
{
  const url = new URL(process.env.DATABASE_URL ?? '')
  const nombre = decodeURIComponent(url.pathname.slice(1))
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !esBaseDePrueba(nombre)) {
    throw new Error(`Base inesperada para esta prueba: ${url.hostname}/${nombre}`)
  }
}

describe('Rappi 2b: la lista «Rappi · por cobrar»', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let orgId: string | undefined
  const venues: string[] = []
  let staffId: string | undefined
  const links: DeliveryChannelLink[] = []
  let n = 0

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({
        data: { name: `Org porcobrar-it ${sufijo}`, email: `porcobrar-it-${sufijo}@t.mx`, phone: '5555555555' },
      })
    ).id
    staffId = (await prisma.staff.create({ data: { email: `porcobrar-${sufijo}@t.mx`, firstName: 'Caja', lastName: 'Lista' } })).id
    for (const k of ['a', 'b']) {
      const v = (
        await prisma.venue.create({ data: { organizationId: orgId, name: `V${k} porcobrar ${sufijo}`, slug: `v${k}-porcobrar-${sufijo}` } })
      ).id
      venues.push(v)
      await prisma.staffVenue.create({ data: { venueId: v, staffId, role: 'OWNER' } })
      links.push(
        await prisma.deliveryChannelLink.create({
          data: { venueId: v, provider: DeliveryProvider.RAPPI, externalLocationId: `rappi-porcobrar-${k}-${sufijo}`, webhookSecret: 'x' },
        }),
      )
    }
  })

  afterAll(async () => {
    if (!orgId) return
    try {
      for (const venueId of venues) {
        const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true } })).map(o => o.id)
        const pagos = (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id)
        await prisma.notification.deleteMany({ where: { venueId } })
        await prisma.activityLog.deleteMany({ where: { venueId } })
        await prisma.venueTransaction.deleteMany({ where: { venueId } })
        await prisma.paymentEffect.deleteMany({ where: { paymentId: { in: pagos } } })
        await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: pagos } } })
        await prisma.digitalReceipt.deleteMany({ where: { paymentId: { in: pagos } } })
        await prisma.payment.deleteMany({ where: { venueId } })
        await prisma.inventoryPosting.deleteMany({ where: { venueId } })
        await prisma.kdsOrder.deleteMany({ where: { venueId } })
        await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
        await prisma.order.deleteMany({ where: { venueId } })
        await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
        await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId } })
        await prisma.venueTenderType.deleteMany({ where: { venueId } })
        await prisma.product.deleteMany({ where: { venueId } })
        await prisma.menuCategory.deleteMany({ where: { venueId } })
        await prisma.staffVenue.deleteMany({ where: { venueId } })
        await prisma.venue.deleteMany({ where: { id: venueId } })
      }
      if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch (e) {
      console.error(`porcobrar-it ${sufijo}: la limpieza falló (quedaron filas propias)`, e)
    }
  })

  async function pedido(raw: any, venue = 0): Promise<{ orderId: string; folio: string }> {
    const copia = JSON.parse(JSON.stringify(raw))
    copia.order_detail.order_id = `${copia.order_detail.order_id}-${sufijo}-${++n}`
    const { order } = await ingestDeliveryOrder(normalizeRappiOrder(copia), links[venue])
    return { orderId: order.id, folio: copia.order_detail.order_id }
  }

  it('lista los Rappi en efectivo por cobrar de ESTE negocio, con su desglose, y nada más', async () => {
    const porCobrar = await pedido(pedido881655210)
    const abonado = await pedido(pedido881655210)
    await payCashOrder(venues[0], abonado.orderId, {
      amount: 10000,
      tip: 0,
      staffId: staffId!,
      idempotencyKey: `abono-${abonado.orderId}`,
      isOfflineReplay: true,
    } as any)
    const cobrado = await pedido(pedido881655210)
    await payCashOrder(venues[0], cobrado.orderId, {
      amount: 20500,
      tip: 0,
      staffId: staffId!,
      idempotencyKey: `cobro-${cobrado.orderId}`,
    } as any)
    const cancelado = await pedido(pedido881655210)
    await cancelDeliveryOrder(cancelado.folio, DeliveryProvider.RAPPI, 'qa')
    await pedido(pedidoM10EnLinea) // pagado en línea: nada que cobrar
    await pedido(pedido881655210, 1) // de OTRO negocio

    const r = await listDeliveryCashPending({ venueId: venues[0] })

    expect(r.total).toBe(2)
    expect(r.truncated).toBe(false)
    const porId = new Map(r.orders.map(o => [o.orderId, o]))
    expect([...porId.keys()].sort()).toEqual([porCobrar.orderId, abonado.orderId].sort())
    expect(porId.get(porCobrar.orderId)).toMatchObject({
      provider: 'RAPPI',
      remainingBalanceCents: 20500,
      saleCents: 17500,
      tipCents: 2000,
      thirdPartyCents: 1000,
      thirdPartyLabel: 'Rappi',
    })
    expect(porId.get(abonado.orderId)).toMatchObject({ remainingBalanceCents: 10500, saleCents: 10500, tipCents: 0, thirdPartyCents: 0 })
  })

  it('Codex código r3 #1: con más de 20 abonos el saldo es el mismo que el de la precuenta', async () => {
    const { orderId } = await pedido(pedido881655210)
    for (let i = 0; i < 21; i++) {
      await payCashOrder(venues[0], orderId, {
        amount: 500,
        tip: 0,
        staffId: staffId!,
        idempotencyKey: `abono5-${i}-${orderId}`.slice(0, 64),
        isOfflineReplay: true,
      } as any)
    }
    const fila = (await listDeliveryCashPending({ venueId: venues[0] })).orders.find(o => o.orderId === orderId)!
    // 21 × 5 = 105 recibidos ⇒ faltan 100 (la tarifa y la propina se cubrieron primero).
    expect(fila.remainingBalanceCents).toBe(10000)
  })

  it('Codex código r3 #2: con más pedidos que el tope, el cursor da acceso a los restantes, sin repetir', async () => {
    const venueId = venues[1]
    for (let i = 0; i < 4; i++) await pedido(pedido881655210, 1)
    const primera = await listDeliveryCashPending({ venueId, limit: 3 })
    expect(primera.orders).toHaveLength(3)
    expect(primera.truncated).toBe(true)
    expect(primera.nextCursor).toBeTruthy()
    const segunda = await listDeliveryCashPending({ venueId, limit: 3, cursor: primera.nextCursor! })
    const ids = [...primera.orders, ...segunda.orders].map(o => o.orderId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(primera.total)
    expect(segunda.nextCursor).toBeNull()
  })
})
