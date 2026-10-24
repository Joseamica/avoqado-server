/**
 * Integration (Postgres REAL) — Rappi 2b: la tarifa de Rappi cobrada en efectivo entra al cajón como PAY_IN propio, en la MISMA
 * caja que la venta, y el vigilante la repone si el proceso murió después del cobro (diseño 2026-10-23, T4).
 * Pedido real DEV 881655210: venta 175, propina 20, tarifa de Rappi 10.
 *
 * Sólo crea filas propias (sufijo único) y las borra en `afterAll`, falle o no.
 */
import { DeliveryProvider, Prisma, type DeliveryChannelLink } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { normalizeRappiOrder } from '@/services/delivery-channels/providers/rappi/rappi.mapper'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { CashDrawerReconcilerJob } from '@/jobs/cash-drawer-reconciler.job'
import pedido881655210 from '../../unit/services/delivery-channels/fixtures/rappi/sandbox/new-order-marketplace-efectivo.json'

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

describe('Rappi 2b: la tarifa de Rappi en el cajón', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let link: DeliveryChannelLink
  let n = 0

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: `Org cajon-it ${sufijo}`, email: `cajon-it-${sufijo}@t.mx`, phone: '5555555555' } })
    ).id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V cajon-it ${sufijo}`, slug: `v-cajon-it-${sufijo}` } }))
      .id
    staffId = (await prisma.staff.create({ data: { email: `cajera-${sufijo}@t.mx`, firstName: 'Caja', lastName: 'Cajón' } })).id
    await prisma.staffVenue.create({ data: { venueId, staffId, role: 'OWNER' } })
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.RAPPI, externalLocationId: `rappi-cajon-it-${sufijo}`, webhookSecret: 'x' },
    })
  })

  afterAll(async () => {
    if (!venueId || !orgId) return
    try {
      const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true } })).map(o => o.id)
      const pagos = (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id)
      await prisma.cashDrawerEvent.deleteMany({ where: { venueId } })
      await prisma.cashDrawerSession.deleteMany({ where: { venueId } })
      await prisma.deliveryOrderEvent.deleteMany({ where: { venueId } })
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
      if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch (e) {
      console.error(`cajon-it ${sufijo}: la limpieza falló (quedaron filas propias)`, e)
    }
  })

  async function pedido(cambiar?: (raw: any) => void): Promise<string> {
    const raw = JSON.parse(JSON.stringify(pedido881655210))
    raw.order_detail.order_id = `${raw.order_detail.order_id}-${sufijo}-${++n}`
    cambiar?.(raw)
    return (await ingestDeliveryOrder(normalizeRappiOrder(raw), link)).order.id
  }

  const abrirCaja = (openedAt = new Date(Date.now() - 60_000)) =>
    prisma.cashDrawerSession.create({
      data: { venueId: venueId!, openedByStaffId: staffId!, openedByName: 'Caja', startingAmount: new Prisma.Decimal(0), openedAt },
    })
  const cerrarCaja = (id: string) =>
    prisma.cashDrawerSession.update({
      where: { id },
      data: { status: 'CLOSED', closedAt: new Date(), actualAmount: new Prisma.Decimal(205), overShort: new Prisma.Decimal(0) },
    })
  const eventosDe = (orderId: string) =>
    prisma.cashDrawerEvent.findMany({
      where: { orderId },
      select: { sessionId: true, type: true, amount: true, note: true, localId: true },
    })

  it('el cobro de 205 deja en la MISMA caja la venta (195) y la entrada de Rappi (10) con su nota', async () => {
    const caja = await abrirCaja()
    const orderId = await pedido()
    const r = await payCashOrder(venueId!, orderId, { amount: 20500, tip: 0, staffId: staffId!, idempotencyKey: `cj-${orderId}` })

    const ev = await eventosDe(orderId)
    expect(ev.map(e => [e.type, e.amount.toFixed(2), e.sessionId]).sort()).toEqual([
      ['CASH_SALE', '195.00', caja.id],
      ['PAY_IN', '10.00', caja.id],
    ])
    const payIn = ev.find(e => e.type === 'PAY_IN')!
    expect(payIn.note).toMatch(/^Cobrado por cuenta de Rappi · pedido #/)
    expect(payIn.localId).toBe(`srv-third-party:${r.paymentId}`)
    await cerrarCaja(caja.id)
  })

  it('un cobro que sólo cubre la tarifa (venta neta $0) deja sólo la entrada de Rappi', async () => {
    const caja = await abrirCaja()
    const orderId = await pedido(raw => {
      raw.order_detail.discounts = [{ amount_by_partner: 175, amount_by_rappi: 0 }]
      raw.order_detail.totals.total_discount_by_partner = 175
      raw.order_detail.totals.total_to_pay = 30
      raw.order_detail.totals.total_order = 30
    })
    await payCashOrder(venueId!, orderId, {
      amount: 500,
      tip: 0,
      staffId: staffId!,
      idempotencyKey: `cj-${orderId}`,
      isOfflineReplay: true,
    } as any)

    expect((await eventosDe(orderId)).map(e => [e.type, e.amount.toFixed(2), e.sessionId])).toEqual([['PAY_IN', '5.00', caja.id]])
    await cerrarCaja(caja.id)
  })

  it('si el proceso murió tras el cobro, el vigilante repone la entrada en la caja de la venta, aunque ya esté cerrada y haya otra abierta', async () => {
    const vieja = await abrirCaja()
    const orderId = await pedido()
    const r = await payCashOrder(venueId!, orderId, { amount: 20500, tip: 0, staffId: staffId!, idempotencyKey: `cj-${orderId}` })
    await prisma.cashDrawerEvent.deleteMany({ where: { localId: `srv-third-party:${r.paymentId}` } }) // la caída
    await cerrarCaja(vieja.id)
    const nueva = await abrirCaja(new Date())

    const vigilante = new CashDrawerReconcilerJob({
      cron: { start: () => undefined, stop: () => undefined },
      now: () => new Date(Date.now() + 10 * 60 * 1000),
    })
    await vigilante.runNow()
    await vigilante.runNow() // idempotente

    const ev = (await eventosDe(orderId)).filter(e => e.type === 'PAY_IN')
    expect(ev.map(e => [e.amount.toFixed(2), e.sessionId])).toEqual([['10.00', vieja.id]])
    expect(ev[0].sessionId).not.toBe(nueva.id)
    await cerrarCaja(nueva.id)
  })
})
