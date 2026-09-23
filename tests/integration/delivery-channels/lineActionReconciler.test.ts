/**
 * Integration (REAL DB) — Tarea 15 del KDS de Uber: el barrido de recuperación
 * (`delivery-line-action-reconciler`, spec §3.4) y `FULFILLMENT_CHANGED` que REPARA en vez de
 * sólo gritar (spec H11, §3.1).
 *
 * El proveedor va mockeado igual que en `reconciliacionDinero.test.ts`: el adaptador real con su
 * GET y su mapper reemplazados. Todo lo demás —candado, retiro, reembolso, reprecio— es el real.
 */
import { DeliveryOrderEventStatus, DeliveryProvider, KdsOrderStatus, OrderSource, Prisma, type DeliveryChannelLink } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import * as reconciliacion from '@/services/delivery-channels/core/deliveryReconciliation.service'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'
import { processUberEvent } from '@/services/delivery-channels/providers/uber-eats/uber.eventProcessor'
import type { NormalizedDeliveryItem, NormalizedDeliveryOrder, NormalizedDeliveryPayment } from '@/services/delivery-channels/core/types'
import { DeliveryLineActionReconcilerJob } from '@/jobs/delivery-line-action-reconciler.job'
import { listDeliveryLineActions } from '@/services/mobile/kdsOutOfStock.mobile.service'

type Renglon = { linea: string; nombre: string; precio: string }

const MIN = 60_000
const hace = (ms: number) => new Date(Date.now() - ms)

describe('barrido de acciones de línea y FULFILLMENT_CHANGED (Tarea 15)', () => {
  let venueId: string, orgId: string
  let link: DeliveryChannelLink
  let n = 0
  /** Lo que el proveedor contesta, por id de pedido del proveedor. */
  let fotos: Map<string, NormalizedDeliveryOrder>

  const renglon = (r: Renglon, sufijo: number): NormalizedDeliveryItem => ({
    externalId: `${r.linea}-${sufijo}`,
    lineId: r.linea,
    name: `${r.nombre} ${sufijo}`,
    quantity: 1,
    unitPrice: r.precio,
    total: r.precio,
  })

  const pago = (venta: string, propina = '0.00'): NormalizedDeliveryPayment => ({
    currency: 'MXN',
    saleAmount: venta,
    merchantFees: '0.00',
    discountAmount: '0.00',
    tipAmount: propina,
    externallyPaidSale: venta,
    externallyPaidTip: propina,
    cashDueSale: '0.00',
    cashDueTip: '0.00',
  })

  const RENGLONES: Renglon[] = [
    { linea: 'a', nombre: 'Cochinita', precio: '150.00' },
    { linea: 'b', nombre: 'Horchata', precio: '50.00' },
  ]

  /** Una venta de reparto como la deja la ingesta real, y su foto con los renglones que SIGUEN. */
  async function sembrar() {
    const sufijo = ++n
    const ext = `t15-${Date.now()}-${sufijo}`
    const normalized: NormalizedDeliveryOrder = {
      externalId: ext,
      displayId: `T15-${sufijo}`,
      source: OrderSource.UBER_EATS,
      items: RENGLONES.map(r => renglon(r, sufijo)),
      payment: pago('200.00'),
      customer: { name: 'Cliente T15' },
      raw: { fuente: 'test' },
      placedAt: new Date(),
    }
    const { order } = await ingestDeliveryOrder(normalized, link)
    const filas = await prisma.orderItem.findMany({ where: { orderId: order.id } })
    const item: Record<string, (typeof filas)[number]> = {}
    for (const f of filas) item[f.externalLineId!] = f
    const foto = (siguen: string[], venta: string): NormalizedDeliveryOrder => ({
      ...normalized,
      items: RENGLONES.filter(r => siguen.includes(r.linea)).map(r => renglon(r, sufijo)),
      payment: pago(venta),
    })
    // Por defecto el proveedor devuelve el pedido intacto.
    fotos.set(ext, foto(['a', 'b'], '200.00'))
    return { order, ext, item, foto }
  }

  const accion = (
    order: { id: string },
    ext: string,
    orderItemId: string,
    lineId: string,
    data: Partial<Prisma.DeliveryLineActionUncheckedCreateInput>,
  ) =>
    prisma.deliveryLineAction.create({
      data: {
        venueId,
        orderId: order.id,
        orderItemId,
        provider: DeliveryProvider.UBER_EATS,
        externalOrderId: ext,
        storeId: link.externalLocationId,
        lineId,
        action: 'REMOVE_ITEM',
        status: 'PENDING',
        origin: 'STAFF',
        ...data,
      },
    })

  const lecturasDe = (ext: string) => (uberAdapter.fetchOrder as jest.Mock).mock.calls.filter(c => c[0] === ext).length
  const reembolsos = (orderId: string) => prisma.payment.findMany({ where: { orderId, type: 'REFUND' } })
  const correr = (job = new DeliveryLineActionReconcilerJob()) => job.runOnce()

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org T15 ${Date.now()}`, email: `t15${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({ data: { organizationId: orgId, name: `V T15 ${Date.now()}`, slug: `v-t15-${Date.now()}` } })
    venueId = v.id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: `store-t15-${Date.now()}`, webhookSecret: 'x' },
    })
  })

  beforeEach(() => {
    fotos = new Map()
    // Hermético: nada sale a la red. El GET contesta la foto sembrada; si no hay, truena.
    jest.spyOn(uberAdapter, 'fetchOrder').mockImplementation(async (id: string) => {
      const f = fotos.get(id)
      if (!f) throw new Error(`sin foto para ${id}`)
      return f
    })
    jest.spyOn(uberAdapter, 'normalizeOrder').mockImplementation(raw => raw as NormalizedDeliveryOrder)
    jest.spyOn(uberAdapter, 'acceptOrder').mockResolvedValue({ ok: true, status: 200, raw: '' })
    jest.spyOn(uberAdapter, 'markOrderReady').mockResolvedValue({ ok: true, status: 200, raw: '' })
    jest.spyOn(uberAdapter, 'resolveFulfillmentIssues').mockResolvedValue({ ok: true, status: 200, raw: '' })
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    try {
      const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true } })).map(o => o.id)
      const pagos = (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id)
      await prisma.deliveryLineAction.deleteMany({ where: { venueId } })
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
    } catch {
      /* fixtures */
    }
  })

  it('PENDING con mas de 2 min pasa a UNCERTAIN', async () => {
    const vieja = await sembrar()
    const nueva = await sembrar()
    const a = await accion(vieja.order, vieja.ext, vieja.item.b.id, 'b', { status: 'PENDING', attempts: 2, lastAttemptAt: hace(3 * MIN) })
    const b = await accion(nueva.order, nueva.ext, nueva.item.b.id, 'b', { status: 'PENDING', attempts: 1, lastAttemptAt: hace(30_000) })

    await correr()

    // El CAS conserva el intento: el reintento humano del cajero sigue apuntando a ESTE número.
    expect(await prisma.deliveryLineAction.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: 'UNCERTAIN', attempts: 2 })
    expect(await prisma.deliveryLineAction.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: 'PENDING', attempts: 1 })
    expect(uberAdapter.resolveFulfillmentIssues).not.toHaveBeenCalled()
  })

  it('UNCERTAIN cuya linea ya no esta ⇒ CONFIRMED y liquida', async () => {
    const s = await sembrar()
    const a = await accion(s.order, s.ext, s.item.b.id, 'b', { status: 'UNCERTAIN', lastAttemptAt: hace(20 * MIN) })
    fotos.set(s.ext, s.foto(['a'], '150.00'))

    await correr()

    const [refund] = await reembolsos(s.order.id)
    expect(refund.amount.toString()).toBe('-50')
    expect(await prisma.deliveryLineAction.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: 'CONFIRMED',
      settlement: 'REFUNDED',
      refundPaymentId: refund.id,
    })
    expect(uberAdapter.resolveFulfillmentIssues).not.toHaveBeenCalled()
  })

  it('UNCERTAIN cuya linea sigue ⇒ sigue UNCERTAIN, cero reenvios', async () => {
    const s = await sembrar()
    const a = await accion(s.order, s.ext, s.item.b.id, 'b', { status: 'UNCERTAIN', attempts: 1, lastAttemptAt: hace(20 * MIN) })

    await correr()

    expect(lecturasDe(s.ext)).toBe(1) // sí se miró al proveedor
    expect(await prisma.deliveryLineAction.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: 'UNCERTAIN',
      attempts: 1,
      settlement: 'PENDING',
    })
    expect(uberAdapter.resolveFulfillmentIssues).not.toHaveBeenCalled()
    expect(await reembolsos(s.order.id)).toHaveLength(0)
  })

  it('CONFIRMED/PENDING con la linea aun presente NO sale del barrido', async () => {
    const s = await sembrar()
    const a = await accion(s.order, s.ext, s.item.b.id, 'b', { status: 'CONFIRMED', resolvedAt: new Date() })

    const job = new DeliveryLineActionReconcilerJob()
    await correr(job)
    await correr(job)

    expect(lecturasDe(s.ext)).toBe(2)
    expect(await prisma.deliveryLineAction.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: 'CONFIRMED',
      settlement: 'PENDING',
    })
    expect(await reembolsos(s.order.id)).toHaveLength(0)
  })

  it('a las 24 h en ese estado registra la alerta', async () => {
    const vieja = await sembrar()
    const nueva = await sembrar()
    const a = await accion(vieja.order, vieja.ext, vieja.item.b.id, 'b', {
      status: 'CONFIRMED',
      lastAttemptAt: hace(25 * 60 * MIN),
      resolvedAt: hace(25 * 60 * MIN),
    })
    await accion(nueva.order, nueva.ext, nueva.item.b.id, 'b', { status: 'CONFIRMED', resolvedAt: hace(60 * MIN) })
    const gritos = jest.spyOn(logger, 'error')

    await correr()
    await correr()

    const alertas = await prisma.activityLog.findMany({ where: { venueId, action: 'DELIVERY_ITEM_REMOVAL_UNREFLECTED' } })
    expect(alertas).toHaveLength(1) // una sola vez, aunque el barrido pase de nuevo
    expect(alertas[0]).toMatchObject({ entity: 'DeliveryLineAction', entityId: a.id })
    expect(gritos.mock.calls.filter(([m]) => String(m).startsWith('🚨') && String(m).includes('sin reflejar'))).toHaveLength(1)
    // El MCP lo muestra como «retiro sin reflejar en Uber» (spec §3.4).
    const { items } = await listDeliveryLineActions(venueId, { limit: 100 })
    expect(items.find(i => i.lineId === 'b' && i.orderId === vieja.order.id)?.unreflectedInProvider).toBe(true)
    expect(items.find(i => i.orderId === nueva.order.id)?.unreflectedInProvider).toBe(false)
  })

  it('reservas huerfanas de mas de 2 min se limpian', async () => {
    const huerfana = await sembrar()
    const viva = await sembrar()
    await prisma.order.update({
      where: { id: huerfana.order.id },
      data: { deliveryOpInFlight: 'READY', deliveryOpInFlightAt: hace(3 * MIN), deliveryOpToken: 'tok-huerfano' },
    })
    await prisma.order.update({
      where: { id: viva.order.id },
      data: { deliveryOpInFlight: 'REMOVE_ITEM', deliveryOpInFlightAt: hace(30_000), deliveryOpToken: 'tok-vivo' },
    })

    await correr()

    expect(await prisma.order.findUniqueOrThrow({ where: { id: huerfana.order.id } })).toMatchObject({
      deliveryOpInFlight: null,
      deliveryOpInFlightAt: null,
      deliveryOpToken: null,
    })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: viva.order.id } })).toMatchObject({
      deliveryOpInFlight: 'REMOVE_ITEM',
      deliveryOpToken: 'tok-vivo',
    })
  })

  it('una orden BLOQUEADA no entra al barrido (no monopoliza el lote)', async () => {
    const bloqueada = await sembrar()
    const libre = await sembrar()
    await prisma.order.update({ where: { id: bloqueada.order.id }, data: { deliveryReconcileBlocked: 'INCREASE_UNSUPPORTED' } })
    await accion(bloqueada.order, bloqueada.ext, bloqueada.item.b.id, 'b', { status: 'CONFIRMED', settlement: 'ACCREDITED' })
    await accion(libre.order, libre.ext, libre.item.b.id, 'b', { status: 'CONFIRMED' })

    await correr()

    expect(lecturasDe(bloqueada.ext)).toBe(0)
    expect(lecturasDe(libre.ext)).toBe(1)
  })

  it('un throw de la reconciliacion se trata como READ_FAILED, no tumba la pasada, y a la 3.a espera', async () => {
    const mala = await sembrar()
    const buena = await sembrar()
    await accion(mala.order, mala.ext, mala.item.b.id, 'b', { status: 'UNCERTAIN', lastAttemptAt: hace(20 * MIN) })
    await accion(buena.order, buena.ext, buena.item.b.id, 'b', { status: 'UNCERTAIN', lastAttemptAt: hace(20 * MIN) })
    fotos.set(buena.ext, buena.foto(['a'], '150.00'))
    const real = reconciliacion.reconcileDeliveryOrderFromProvider
    const espia = jest.spyOn(reconciliacion, 'reconcileDeliveryOrderFromProvider').mockImplementation((orderId, opts) => {
      if (orderId === mala.order.id) return Promise.reject(new Error('Transaction already closed'))
      return real(orderId, opts)
    })
    const intentosMala = () => espia.mock.calls.filter(c => c[0] === mala.order.id).length

    const job = new DeliveryLineActionReconcilerJob()
    await correr(job) // 1.er throw: la otra orden sí se liquida en la MISMA pasada
    expect((await reembolsos(buena.order.id)).length).toBe(1)
    await correr(job) // 2.º
    await correr(job) // 3.º ⇒ empieza a esperar
    expect(intentosMala()).toBe(3)
    await correr(job) // saltada
    expect(intentosMala()).toBe(3)

    const fallos = await prisma.activityLog.findMany({
      where: { venueId, entity: 'Order', entityId: mala.order.id, action: 'DELIVERY_RECONCILE_ERROR' },
      orderBy: { createdAt: 'asc' },
    })
    expect(fallos.map(f => (f.data as { consecutive: number }).consecutive)).toEqual([1, 2, 3])
    expect(new Date((fallos[2].data as { retryAt: string }).retryAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('un listo que la reserva dejo sin avisar se reintenta y se acredita', async () => {
    const s = await sembrar()
    await prisma.kdsOrder.updateMany({ where: { orderId: s.order.id }, data: { status: KdsOrderStatus.COMPLETED } })

    await correr()

    expect(uberAdapter.markOrderReady).toHaveBeenCalledWith(s.ext, link.externalLocationId)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).readyReportedAt).not.toBeNull()
  })

  it('un listo que Uber contesta sin acreditar (409) NO se martilla cada minuto', async () => {
    const s = await sembrar()
    await prisma.kdsOrder.updateMany({ where: { orderId: s.order.id }, data: { status: KdsOrderStatus.READY } })
    ;(uberAdapter.markOrderReady as jest.Mock).mockResolvedValue({ ok: true, status: 409, raw: 'already' })
    const avisosA = () => (uberAdapter.markOrderReady as jest.Mock).mock.calls.filter(c => c[0] === s.ext).length

    const job = new DeliveryLineActionReconcilerJob()
    await correr(job)
    await correr(job)

    expect(avisosA()).toBe(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).readyReportedAt).toBeNull()
  })

  describe('FULFILLMENT_CHANGED', () => {
    const evento = (ext: string) =>
      prisma.deliveryOrderEvent.create({
        data: {
          provider: DeliveryProvider.UBER_EATS,
          externalEventId: `ev-fc-${ext}`,
          eventType: 'order.fulfillment_issues.resolved',
          payload: {
            event_id: `ev-fc-${ext}`,
            event_type: 'order.fulfillment_issues.resolved',
            resource_href: `https://test-api.uber.com/v2/eats/order/${ext}`,
            meta: { user_id: link.externalLocationId, resource_id: ext, status: 'pos' },
          },
          channelLinkId: link.id,
          venueId,
          dedupKey: `UBER_EATS:ev-fc-${ext}`,
        },
      })

    it('FULFILLMENT_CHANGED que falla el GET deja el evento FAILED para reintento', async () => {
      const s = await sembrar()
      fotos.delete(s.ext) // el GET truena
      const { id: eventoId } = await evento(s.ext)

      const r = await processUberEvent(eventoId)

      expect(r.outcome).toBe('FAILED')
      const ev = await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: eventoId } })
      expect(ev.status).toBe('FAILED') // hoy queda PROCESSED aunque el GET truene
    })

    it('FULFILLMENT_CHANGED exitoso propaga removedAt a TODAS las comandas y liquida', async () => {
      const s = await sembrar()
      // Una segunda comanda del mismo pedido (reapertura / otra estación).
      await prisma.kdsOrder.create({
        data: {
          venueId,
          orderNumber: 'T15-B',
          orderType: 'DELIVERY',
          orderId: s.order.id,
          items: { create: [{ productName: 'Horchata', quantity: 1, orderItemId: s.item.b.id, externalLineId: 'b' }] },
        },
      })
      fotos.set(s.ext, s.foto(['a'], '150.00'))
      const { id: eventoId } = await evento(s.ext)

      const r = await processUberEvent(eventoId)

      expect(r).toMatchObject({ outcome: 'RECONCILED', orderId: s.order.id })
      expect((await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: eventoId } })).status).toBe(
        DeliveryOrderEventStatus.PROCESSED,
      )
      const renglonesB = await prisma.kdsOrderItem.findMany({ where: { kdsOrder: { orderId: s.order.id }, orderItemId: s.item.b.id } })
      expect(renglonesB.length).toBeGreaterThanOrEqual(2)
      expect(renglonesB.every(k => k.removedAt !== null)).toBe(true)
      const [refund] = await reembolsos(s.order.id)
      expect(refund.amount.toString()).toBe('-50')
      expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).total.toString()).toBe('150')
    })
  })
})
