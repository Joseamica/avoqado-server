/**
 * Integration (Postgres REAL) — Rappi 2b (diseño 2026-10-23, T10): el total de un pedido de plataforma no se rearma en Avoqado,
 * tampoco por lo automático. Caso de Codex r2 #2: un cargo por número de comensales.
 *
 * Sólo crea filas propias (sufijo único) y las borra en `afterAll`, falle o no.
 */
import { DeliveryProvider, Prisma, type DeliveryChannelLink } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { normalizeRappiOrder } from '@/services/delivery-channels/providers/rappi/rappi.mapper'
import { updateOrderDetails } from '@/services/mobile/order.mobile.service'
import pedido881655210 from '../../unit/services/delivery-channels/fixtures/rappi/sandbox/new-order-marketplace-efectivo.json'

jest.setTimeout(60_000)
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

describe('Rappi 2b: lo automático no rearma el total de un pedido de Rappi', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let orgId: string | undefined
  let venueId: string | undefined
  let link: DeliveryChannelLink

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({
        data: { name: `Org edicion-it ${sufijo}`, email: `edicion-it-${sufijo}@t.mx`, phone: '5555555555' },
      })
    ).id
    venueId = (
      await prisma.venue.create({ data: { organizationId: orgId, name: `V edicion-it ${sufijo}`, slug: `v-edicion-it-${sufijo}` } })
    ).id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.RAPPI, externalLocationId: `rappi-edicion-it-${sufijo}`, webhookSecret: 'x' },
    })
    await prisma.serviceCharge.create({
      data: { venueId, name: 'Servicio grupos', type: 'PERCENTAGE', value: new Prisma.Decimal(10), autoApplyMinCovers: 2 },
    })
  })

  afterAll(async () => {
    if (!venueId || !orgId) return
    try {
      const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true } })).map(o => o.id)
      await prisma.orderServiceCharge.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.serviceCharge.deleteMany({ where: { venueId } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
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
      console.error(`edicion-it ${sufijo}: la limpieza falló (quedaron filas propias)`, e)
    }
  })

  it('cambiar comensales con una regla de cargo automático: sin cargo y el total intacto', async () => {
    const raw = JSON.parse(JSON.stringify(pedido881655210))
    raw.order_detail.order_id = `${raw.order_detail.order_id}-${sufijo}`
    const { order } = await ingestDeliveryOrder(normalizeRappiOrder(raw), link)

    await updateOrderDetails(venueId!, order.id, { covers: 6 })

    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(await prisma.orderServiceCharge.count({ where: { orderId: order.id } })).toBe(0)
    expect(o.total.toFixed(2)).toBe('175.00')
    expect(o.remainingBalance.toFixed(2)).toBe('205.00')
  })
})
