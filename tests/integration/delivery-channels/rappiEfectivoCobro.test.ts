/**
 * Integration (Postgres REAL) — Rappi 2b: el cobro de un pedido con repartidor propio en efectivo (diseño 2026-10-23, T5/T5b/T5c,
 * T8 y la comisión del canal). Pedido real DEV 881655210: venta 175 (Burger 140 + Envío 35), propina 20, tarifa de Rappi 10.
 *
 * El reparto lo pone el SERVIDOR (terceros → propina → venta); el dinero ya capturado nunca se rechaza ni se recorta.
 *
 * Sólo crea filas propias (sufijo único) y las borra en `afterAll`, falle o no.
 */
import { DeliveryProvider, type DeliveryChannelLink } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { cancelDeliveryOrder } from '@/services/delivery-channels/core/cancelDeliveryOrder.service'
import { normalizeRappiOrder } from '@/services/delivery-channels/providers/rappi/rappi.mapper'
import { getOrder, payCashOrder } from '@/services/mobile/order.mobile.service'
import { notificarConciliacionDeReparto } from '@/services/shared/avisoDeRappiEfectivo'
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

describe('Rappi 2b: cobrar un pedido con repartidor propio en efectivo', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let link: DeliveryChannelLink
  let n = 0

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: `Org cobro-it ${sufijo}`, email: `cobro-it-${sufijo}@t.mx`, phone: '5555555555' } })
    ).id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V cobro-it ${sufijo}`, slug: `v-cobro-it-${sufijo}` } }))
      .id
    staffId = (await prisma.staff.create({ data: { email: `cajero-${sufijo}@t.mx`, firstName: 'Caja', lastName: 'Rappi' } })).id
    await prisma.staffVenue.create({ data: { venueId, staffId, role: 'OWNER' } })
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.RAPPI, externalLocationId: `rappi-cobro-it-${sufijo}`, webhookSecret: 'x' },
    })
  })

  afterAll(async () => {
    if (!venueId || !orgId) return
    try {
      const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true } })).map(o => o.id)
      const pagos = (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id)
      await prisma.deliveryOrderEvent.deleteMany({ where: { venueId } })
      await prisma.notification.deleteMany({ where: { venueId } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.venueTransaction.deleteMany({ where: { venueId } })
      await prisma.paymentEffect.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.digitalReceipt.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.payment.deleteMany({ where: { venueId } })
      await prisma.inventoryPosting.deleteMany({ where: { venueId } })
      await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } })
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
      console.error(`cobro-it ${sufijo}: la limpieza falló (quedaron filas propias)`, e)
    }
  })

  /** El pedido real, con folio propio (y cambios opcionales al payload crudo). */
  async function pedido(cambiar?: (raw: any) => void): Promise<string> {
    const raw = JSON.parse(JSON.stringify(pedido881655210))
    raw.order_detail.order_id = `${raw.order_detail.order_id}-${sufijo}-${++n}`
    cambiar?.(raw)
    const { order } = await ingestDeliveryOrder(normalizeRappiOrder(raw), link)
    return order.id
  }

  const cobrar = (orderId: string, amount: number, extra: Record<string, unknown> = {}) =>
    payCashOrder(venueId!, orderId, { amount, tip: 0, staffId: staffId!, idempotencyKey: `k-${orderId}-${++n}`, ...extra } as any)

  const reparto = (p: { amount: unknown; tipAmount: unknown; thirdPartyCashAmount: unknown }) => [
    String(p.amount),
    String(p.tipAmount),
    p.thirdPartyCashAmount == null ? null : String(p.thirdPartyCashAmount),
  ]
  const pagosDe = (orderId: string) => prisma.payment.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })
  const bitacora = (orderId: string, action: string) => prisma.activityLog.count({ where: { entityId: orderId, action } })

  it('cobro nuevo de 205: venta 175, propina 20, Rappi 10; nada de cambio y la orden queda pagada', async () => {
    const orderId = await pedido()
    const r = await cobrar(orderId, 20500)

    const [p] = await pagosDe(orderId)
    expect(reparto(p)).toEqual(['175', '20', '10'])
    expect(r).toMatchObject({ amount: 17500, tipAmount: 2000, cashRetainedCents: 20500, changeCents: 0, remainingBalanceCents: 0 })
    // Plan de apps (Codex r1 #2): la app concilia con lo que este pago cubrió de cada parte, no con lo que mandó.
    expect(r.deliveryCashAllocation).toEqual({ saleCents: 17500, tipCents: 2000, thirdPartyCents: 1000 })
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(o.paymentStatus).toBe('PAID')
    expect(o.remainingBalance.toFixed(2)).toBe('0.00')
  })

  it('cobro nuevo de 500: mismo reparto y 295 de cambio', async () => {
    const orderId = await pedido()
    const r = await cobrar(orderId, 50000)
    expect(reparto((await pagosDe(orderId))[0])).toEqual(['175', '20', '10'])
    expect(r).toMatchObject({ cashRetainedCents: 20500, changeCents: 29500 })
  })

  it('una app que manda 175 + propina 30 recibe el mismo reparto (lo decide el servidor)', async () => {
    const orderId = await pedido()
    const r = await cobrar(orderId, 17500, { tip: 3000 })
    expect(reparto((await pagosDe(orderId))[0])).toEqual(['175', '20', '10'])
    expect(r).toMatchObject({ cashRetainedCents: 20500, changeCents: 0 })
  })

  it('abono capturado sin red de 100: Rappi 10, propina 20, venta 70; quedan 105 pendientes, también tras reingerir', async () => {
    const orderId = await pedido()
    const r = await cobrar(orderId, 10000, { isOfflineReplay: true })
    expect(reparto((await pagosDe(orderId))[0])).toEqual(['70', '20', '10'])
    expect(r).toMatchObject({ remainingBalanceCents: 10500, cashRetainedCents: 10000, changeCents: 0 })
    expect(r.deliveryCashAllocation).toEqual({ saleCents: 7000, tipCents: 2000, thirdPartyCents: 1000 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PARTIAL')

    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    await ingestDeliveryOrder(normalizeRappiOrder(o.posRawData), link)
    expect((await getOrder(venueId!, orderId)).preBillBalance).toMatchObject({
      remainingBalanceCents: 10500,
      deliveryCashBreakdown: { saleCents: 10500, tipCents: 0, thirdPartyCents: 0 },
    })
  })

  it('dos aparatos lo cobran: el segundo se registra completo como venta y avisa sobrepago', async () => {
    const orderId = await pedido()
    await cobrar(orderId, 20500)
    const otro = await cobrar(orderId, 20500, { isOfflineReplay: true })

    const [, segundo] = await pagosDe(orderId)
    expect(reparto(segundo)).toEqual(['205', '0', '0'])
    expect(otro.deliveryCashAllocation).toEqual({ saleCents: 20500, tipCents: 0, thirdPartyCents: 0 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PAID')
    expect(await bitacora(orderId, 'SOBREPAGO_DETECTADO')).toBe(1)
  })

  it('la cola vieja (H1) que manda el total se recorta como cobro nuevo, no se registran 500', async () => {
    const orderId = await pedido()
    await cobrar(orderId, 50000, { isOfflineReplay: true, colaConDefectoH1: true })
    expect(reparto((await pagosDe(orderId))[0])).toEqual(['175', '20', '10'])
  })

  it('reintento con la misma llave: misma respuesta, un solo cobro', async () => {
    const orderId = await pedido()
    const llave = `misma-${orderId}`
    const a = await cobrar(orderId, 20500, { idempotencyKey: llave })
    const b = await cobrar(orderId, 20500, { idempotencyKey: llave })
    expect(b.paymentId).toBe(a.paymentId)
    expect(b).toMatchObject({ cashRetainedCents: 20500, changeCents: 0 })
    expect(b.deliveryCashAllocation).toEqual(a.deliveryCashAllocation)
    expect(b.deliveryCashAllocation).toEqual({ saleCents: 17500, tipCents: 2000, thirdPartyCents: 1000 })
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1)
  })

  it('venta neta en $0 con propina y tarifa: 5 recibidos cubren sólo la tarifa y la orden NO queda pagada', async () => {
    const orderId = await pedido(raw => {
      raw.order_detail.discounts = [{ amount_by_partner: 175, amount_by_rappi: 0 }]
      raw.order_detail.totals.total_discount_by_partner = 175
      raw.order_detail.totals.total_to_pay = 30
      raw.order_detail.totals.total_order = 30
    })
    await cobrar(orderId, 500, { isOfflineReplay: true })
    expect(reparto((await pagosDe(orderId))[0])).toEqual(['0', '0', '5'])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PARTIAL')
  })

  it('tarjeta externa ya cobrada: propina y venta (185 + 20), sin Rappi; queda pagada y avisa conciliar la tarifa', async () => {
    const orderId = await pedido()
    await cobrar(orderId, 20500, { method: 'CREDIT_CARD' })
    expect(reparto((await pagosDe(orderId))[0])).toEqual(['185', '20', null])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PAID')
    expect(await bitacora(orderId, 'RAPPI_CASH_ORDER_OTHER_MEDIUM')).toBe(1)
  })

  it('con comisión del canal configurada (30 %): el cobro la congela sobre la venta y sigue siendo efectivo de cajón', async () => {
    const orderId = await pedido()
    await prisma.venueTenderType.updateMany({ where: { venueId: venueId!, name: 'Rappi' }, data: { commissionPercent: 30 } })
    await cobrar(orderId, 20500)
    const [p] = await pagosDe(orderId)
    expect(p.tenderCommissionAmount?.toFixed(2)).toBe('52.50')
    expect(p.method).toBe('CASH')
    expect(p.fundsFlow).toBe('CASH_DRAWER')
    expect(p.tenderSatFormaPago).toBeNull()
    await prisma.venueTenderType.updateMany({ where: { venueId: venueId!, name: 'Rappi' }, data: { commissionPercent: null } })
  })

  it('Rappi canceló y después llega el efectivo sin red: se registra, el pedido sigue cancelado y queda el aviso', async () => {
    const orderId = await pedido()
    const folio = (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).externalId!.split(':')[1]
    await cancelDeliveryOrder(folio, DeliveryProvider.RAPPI, 'qa')
    await cobrar(orderId, 20500, { isOfflineReplay: true })
    expect(await prisma.payment.count({ where: { orderId, status: 'COMPLETED' } })).toBe(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    expect(await bitacora(orderId, 'RAPPI_CASH_ON_CANCELLED_ORDER')).toBe(1)
  })

  it('cobrado y después Rappi cancela: se cancela, el cobro queda y el aviso sale una sola vez aunque se repita', async () => {
    const orderId = await pedido()
    await cobrar(orderId, 20500)
    const externalId = (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).externalId!.split(':')[1]
    await cancelDeliveryOrder(externalId, DeliveryProvider.RAPPI, 'qa')
    await cancelDeliveryOrder(externalId, DeliveryProvider.RAPPI, 'qa')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    expect(await prisma.payment.count({ where: { orderId, status: 'COMPLETED' } })).toBe(1)
    expect(await bitacora(orderId, 'DELIVERY_CANCELLED_AFTER_CASH')).toBe(1)
  })

  // ── Codex código r1 ─────────────────────────────────────────────────────────────────────
  it('#1 la cola vieja (H1) con una tarjeta YA cobrada no se recorta: se registra todo y no hay «cambio»', async () => {
    const orderId = await pedido()
    const r = await cobrar(orderId, 50000, { isOfflineReplay: true, colaConDefectoH1: true, method: 'CREDIT_CARD' })
    expect(reparto((await pagosDe(orderId))[0])).toEqual(['480', '20', null])
    expect(r.changeCents).toBe(0)
  })

  it('#2 con tarifa de Rappi en $0 el carril sigue: 195 = venta 175 + propina 20, sin cambio', async () => {
    const orderId = await pedido(raw => {
      raw.order_detail.totals.charges.service_fee = 0
      raw.order_detail.totals.total_to_pay = 195
      raw.order_detail.totals.total_order = 195
    })
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(o.thirdPartyCashDue?.toFixed(2)).toBe('0.00')
    const r = await cobrar(orderId, 19500)
    expect(reparto((await pagosDe(orderId))[0])).toEqual(['175', '20', '0'])
    expect(r).toMatchObject({ changeCents: 0, cashRetainedCents: 19500 })
  })

  it('#4 con «Efectivo» del catálogo, el cobro igual congela la comisión de Rappi', async () => {
    const orderId = await pedido()
    await prisma.venueTenderType.updateMany({ where: { venueId: venueId!, name: 'Rappi' }, data: { commissionPercent: 30 } })
    const efectivo = await prisma.venueTenderType.create({
      data: {
        venueId: venueId!,
        name: 'Efectivo',
        normalizedName: 'efectivo',
        baseMethod: 'CASH',
        isSystem: true,
        countsAsPhysicalCash: true,
        captureTip: true,
        satFormaPago: '01',
        showOnPos: true,
        revision: 1,
      },
    })
    await prisma.venueTenderTypeRevision.create({
      data: {
        venueId: venueId!,
        tenderTypeId: efectivo.id,
        revision: 1,
        name: 'Efectivo',
        countsAsPhysicalCash: true,
        captureTip: true,
        satFormaPago: '01',
      },
    })
    try {
      await cobrar(orderId, 20500, { tenderTypeId: efectivo.id, tenderRevision: 1 })
      const [p] = await pagosDe(orderId)
      expect(p.tenderCommissionAmount?.toFixed(2)).toBe('52.50')
      expect(p.fundsFlow).toBe('CASH_DRAWER')
      expect(reparto(p)).toEqual(['175', '20', '10'])
    } finally {
      await prisma.venueTenderType.updateMany({ where: { venueId: venueId!, name: 'Rappi' }, data: { commissionPercent: null } })
    }
  })

  it('#5 cobrado con tarjeta externa (T5c): la precuenta ya no pide los $10 de Rappi a la caja', async () => {
    const orderId = await pedido()
    await cobrar(orderId, 20500, { method: 'CREDIT_CARD' })
    expect((await getOrder(venueId!, orderId)).preBillBalance).toMatchObject({ remainingBalanceCents: 0 })
  })

  it('#6 Rappi canceló y llegó el efectivo: el gerente recibe una notificación (no sólo la bitácora)', async () => {
    const orderId = await pedido()
    const folio = (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).externalId!.split(':')[1]
    await cancelDeliveryOrder(folio, DeliveryProvider.RAPPI, 'qa')
    await cobrar(orderId, 20500, { isOfflineReplay: true })
    await new Promise(r => setTimeout(r, 300)) // el aviso corre después del commit, sin bloquear el cobro
    expect(
      await prisma.notification.count({
        where: { venueId: venueId!, recipientId: staffId!, metadata: { path: ['orderId'], equals: orderId } },
      }),
    ).toBe(1)
  })

  it('código r2: dos avisos A LA VEZ del mismo pedido y motivo dejan UNA sola notificación por persona', async () => {
    const orderId = await pedido()
    await Promise.all([
      notificarConciliacionDeReparto({ motivo: 'RAPPI_CASH_ON_CANCELLED_ORDER', venueId: venueId!, orderId }),
      notificarConciliacionDeReparto({ motivo: 'RAPPI_CASH_ON_CANCELLED_ORDER', venueId: venueId!, orderId }),
      notificarConciliacionDeReparto({ motivo: 'RAPPI_CASH_ON_CANCELLED_ORDER', venueId: venueId!, orderId }),
    ])
    expect(
      await prisma.notification.count({
        where: { venueId: venueId!, recipientId: staffId!, metadata: { path: ['orderId'], equals: orderId } },
      }),
    ).toBe(1)
  })
})
