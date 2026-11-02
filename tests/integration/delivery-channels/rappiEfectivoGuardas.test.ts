/**
 * Integration (Postgres REAL) — Rappi 2b (diseño 2026-10-23, T7): sobre un pedido de Rappi en efectivo se bloquea la ACCIÓN nueva
 * de cobro por otra puerta (pago manual del panel, liquidar, liquidar saldo del cliente, cripto, saldo de regalo), antes de escribir
 * nada. El dinero ya autorizado (terminal que ya aprobó, efectivo ya capturado) no pasa por aquí: se registra y se avisa.
 *
 * Sólo crea filas propias (sufijo único) y las borra en `afterAll`, falle o no.
 */
import { DeliveryProvider, Prisma, type DeliveryChannelLink } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { normalizeRappiOrder } from '@/services/delivery-channels/providers/rappi/rappi.mapper'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'
import { settleOrder } from '@/services/dashboard/order.dashboard.service'
import { settleCustomerBalance } from '@/services/dashboard/customer.dashboard.service'
import { initiateCryptoPayment } from '@/services/b4bit/b4bit.service'
import { payGiftCardBalanceOnOrder } from '@/services/mobile/order.mobile.service'
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

describe('Rappi 2b: otras puertas de cobro no cobran un pedido de Rappi en efectivo', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let customerId: string | undefined
  let link: DeliveryChannelLink
  let n = 0

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({
        data: { name: `Org guardas-it ${sufijo}`, email: `guardas-it-${sufijo}@t.mx`, phone: '5555555555' },
      })
    ).id
    venueId = (
      await prisma.venue.create({ data: { organizationId: orgId, name: `V guardas-it ${sufijo}`, slug: `v-guardas-it-${sufijo}` } })
    ).id
    staffId = (await prisma.staff.create({ data: { email: `gerente-${sufijo}@t.mx`, firstName: 'Gerente', lastName: 'Rappi' } })).id
    await prisma.staffVenue.create({ data: { venueId, staffId, role: 'OWNER' } })
    customerId = (await prisma.customer.create({ data: { venueId, firstName: 'Cliente', lastName: 'Rappi' } })).id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.RAPPI, externalLocationId: `rappi-guardas-it-${sufijo}`, webhookSecret: 'x' },
    })
  })

  afterAll(async () => {
    if (!venueId || !orgId) return
    try {
      const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true } })).map(o => o.id)
      await prisma.orderCustomer.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.payment.deleteMany({ where: { venueId } })
      await prisma.kdsOrder.deleteMany({ where: { venueId } })
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.order.deleteMany({ where: { venueId } })
      await prisma.customer.deleteMany({ where: { venueId } })
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
      console.error(`guardas-it ${sufijo}: la limpieza falló (quedaron filas propias)`, e)
    }
  })

  async function pedido(): Promise<string> {
    const raw = JSON.parse(JSON.stringify(pedido881655210))
    raw.order_detail.order_id = `${raw.order_detail.order_id}-${sufijo}-${++n}`
    return (await ingestDeliveryOrder(normalizeRappiOrder(raw), link)).order.id
  }

  const rechazo = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: any) => e,
    )
  const sinCobros = async (orderId: string) => {
    expect(await prisma.payment.count({ where: { orderId } })).toBe(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PENDING')
  }

  it('pago manual del panel ⇒ 409 RAPPI_CASH_ORDER_CASH_ONLY, nada escrito', async () => {
    const orderId = await pedido()
    const e = await rechazo(createManualPayment(venueId!, staffId!, { orderId, amount: '205.00', method: 'CASH' } as any))
    expect(e).toMatchObject({ code: 'RAPPI_CASH_ORDER_CASH_ONLY' })
    await sinCobros(orderId)
  })

  it('liquidar la orden desde el panel ⇒ 409, nada escrito', async () => {
    const orderId = await pedido()
    expect(await rechazo(settleOrder(venueId!, orderId, 'qa', staffId!))).toMatchObject({ code: 'RAPPI_CASH_ORDER_CASH_ONLY' })
    await sinCobros(orderId)
  })

  it('liquidar el saldo de un cliente se salta el pedido de Rappi', async () => {
    const orderId = await pedido()
    await prisma.orderCustomer.create({ data: { orderId, customerId: customerId!, isPrimary: true } })
    await settleCustomerBalance(venueId!, customerId!, 'qa', staffId!).catch(() => undefined)
    await sinCobros(orderId)
  })

  it('cobrar con cripto ⇒ 409 antes de crear el cobro', async () => {
    const orderId = await pedido()
    const e = await rechazo(initiateCryptoPayment({ venueId: venueId!, amount: 20500, tip: 0, staffId: staffId!, orderId } as any))
    expect(e).toMatchObject({ code: 'RAPPI_CASH_ORDER_CASH_ONLY' })
    await sinCobros(orderId)
  })

  it('cobrar con saldo de tarjeta de regalo ⇒ 409 antes de tocar ninguna tarjeta', async () => {
    const orderId = await pedido()
    const e = await rechazo(
      payGiftCardBalanceOnOrder(venueId!, orderId, {
        idempotencyKey: `regalo-${orderId}`.slice(0, 60),
        amount: new Prisma.Decimal('175.00'),
        tip: new Prisma.Decimal('0'),
        proof: { kind: 'CODE', code: 'NO-EXISTE-1234' },
        staffId: staffId!,
        deviceId: null,
      }),
    )
    expect(e).toMatchObject({ code: 'RAPPI_CASH_ORDER_CASH_ONLY' })
    await sinCobros(orderId)
  })
})
