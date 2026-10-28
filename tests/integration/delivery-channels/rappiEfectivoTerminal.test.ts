/**
 * Integration (Postgres REAL) — Rappi 2b (Codex código r1 #3): el registrador de la TPV (y el webhook de AngelPay, que lo usa)
 * registra el dinero ya autorizado sobre un pedido de Rappi en efectivo, pero NO reabre uno que Rappi canceló, y deja su aviso.
 *
 * Sólo crea filas propias (sufijo único) y las borra en `afterAll`, falle o no.
 */
import { randomUUID } from 'crypto'
import { DeliveryProvider, type DeliveryChannelLink } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { cancelDeliveryOrder } from '@/services/delivery-channels/core/cancelDeliveryOrder.service'
import { normalizeRappiOrder } from '@/services/delivery-channels/providers/rappi/rappi.mapper'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import pedido881655210 from '../../unit/services/delivery-channels/fixtures/rappi/sandbox/new-order-marketplace-efectivo.json'

jest.setTimeout(60_000)
jest.mock('@/services/shared/cashDrawerPosting', () => ({ postCashSaleToDrawer: jest.fn().mockResolvedValue('NO_OPEN_DRAWER') }))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const manager = { broadcastToVenue: jest.fn(), getServer: jest.fn() }
  return { __esModule: true, default: manager, socketManager: manager }
})
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))

/** 🔴 La base es compartida por ~20 sesiones: fuera de una base de PRUEBAS no se toca nada. */
const esBaseDePrueba = (nombre: string) =>
  nombre === 'av-db-25-test' || /^(codex_testarudo_test_|avoqado_(?:[a-z0-9]+|cambio_r5)_test_)/.test(nombre)
{
  const url = new URL(process.env.DATABASE_URL ?? '')
  const nombre = decodeURIComponent(url.pathname.slice(1))
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !esBaseDePrueba(nombre)) {
    throw new Error(`Base inesperada para esta prueba: ${url.hostname}/${nombre}`)
  }
}

describe('Rappi 2b: la terminal registra dinero ya autorizado sobre un pedido de Rappi en efectivo', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let link: DeliveryChannelLink
  let n = 0

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: `Org tpv-it ${sufijo}`, email: `tpv-it-${sufijo}@t.mx`, phone: '5555555555' } })
    ).id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V tpv-it ${sufijo}`, slug: `v-tpv-it-${sufijo}` } })).id
    staffId = (await prisma.staff.create({ data: { email: `tpv-${sufijo}@t.mx`, firstName: 'Caja', lastName: 'TPV' } })).id
    await prisma.staffVenue.create({ data: { venueId, staffId, role: 'OWNER' } })
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.RAPPI, externalLocationId: `rappi-tpv-it-${sufijo}`, webhookSecret: 'x' },
    })
  })

  afterAll(async () => {
    if (!venueId || !orgId) return
    try {
      const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true } })).map(o => o.id)
      const pagos = (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id)
      await prisma.notification.deleteMany({ where: { venueId } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.venueTransaction.deleteMany({ where: { venueId } })
      await prisma.paymentEffect.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.digitalReceipt.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.review.deleteMany({ where: { venueId } })
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
      if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch (e) {
      console.error(`tpv-it ${sufijo}: la limpieza falló (quedaron filas propias)`, e)
    }
  })

  async function pedido(): Promise<{ orderId: string; folio: string }> {
    const raw = JSON.parse(JSON.stringify(pedido881655210))
    raw.order_detail.order_id = `${raw.order_detail.order_id}-${sufijo}-${++n}`
    const { order } = await ingestDeliveryOrder(normalizeRappiOrder(raw), link)
    return { orderId: order.id, folio: raw.order_detail.order_id }
  }

  const registrar = (orderId: string, amount: number) =>
    recordOrderPayment(
      venueId!,
      orderId,
      {
        venueId: venueId!,
        amount,
        tip: 0,
        status: 'COMPLETED',
        method: 'CASH',
        source: 'TPV',
        splitType: 'FULLPAYMENT',
        tpvId: sufijo,
        staffId: staffId!,
        paidProductsId: [],
        idempotencyKey: randomUUID(),
        currency: 'MXN',
        isInternational: false,
      } as any,
      staffId!,
    )

  const bitacora = (orderId: string, action: string) => prisma.activityLog.count({ where: { entityId: orderId, action } })
  const esperar = () => new Promise(r => setTimeout(r, 300))

  it('Rappi canceló: la terminal registra el dinero, el pedido SIGUE cancelado y queda el aviso', async () => {
    const { orderId, folio } = await pedido()
    await cancelDeliveryOrder(folio, DeliveryProvider.RAPPI, 'qa')
    await registrar(orderId, 20500).catch(() => undefined)
    await esperar()
    expect(await prisma.payment.count({ where: { orderId, status: 'COMPLETED' } })).toBe(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    expect(await bitacora(orderId, 'RAPPI_CASH_ON_CANCELLED_ORDER')).toBe(1)
  })

  it('pedido vivo: la terminal registra como siempre y avisa conciliar la tarifa de Rappi', async () => {
    const { orderId } = await pedido()
    await registrar(orderId, 20500).catch(() => undefined)
    await esperar()
    expect(await prisma.payment.count({ where: { orderId, status: 'COMPLETED' } })).toBe(1)
    expect(await bitacora(orderId, 'RAPPI_CASH_ORDER_OTHER_MEDIUM')).toBe(1)
  })
})
