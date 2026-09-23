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
import * as deliveryOrderLock from '@/services/delivery-channels/core/deliveryOrderLock'
import * as respuestas from '@/services/delivery-channels/core/respondToDeliveryOrder.service'
import { utcTs } from '@/utils/sqlDates'
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
  async function sembrar(propina = '0.00', renglones: Renglon[] = RENGLONES) {
    const sufijo = ++n
    const ext = `t15-${Date.now()}-${sufijo}`
    const normalized: NormalizedDeliveryOrder = {
      externalId: ext,
      displayId: `T15-${sufijo}`,
      source: OrderSource.UBER_EATS,
      items: renglones.map(r => renglon(r, sufijo)),
      payment: pago('200.00', propina),
      customer: { name: 'Cliente T15' },
      raw: { fuente: 'test' },
      placedAt: new Date(),
    }
    const { order } = await ingestDeliveryOrder(normalized, link)
    const filas = await prisma.orderItem.findMany({ where: { orderId: order.id } })
    const item: Record<string, (typeof filas)[number]> = {}
    for (const f of filas) item[f.externalLineId!] = f
    const foto = (siguen: string[], venta: string, prop = propina): NormalizedDeliveryOrder => ({
      ...normalized,
      items: renglones.filter(r => siguen.includes(r.linea)).map(r => renglon(r, sufijo)),
      payment: pago(venta, prop),
    })
    // Por defecto el proveedor devuelve el pedido intacto.
    fotos.set(ext, foto(renglones.map(r => r.linea), '200.00'))
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
  /** Corre `fn` con el reloj de la app adelantado `ms` (vence las esperas en memoria del job). */
  const dentroDe = async <T>(ms: number, fn: () => Promise<T>): Promise<T> => {
    const real = Date.now.bind(Date)
    const reloj = jest.spyOn(Date, 'now').mockImplementation(() => real() + ms)
    try {
      return await fn()
    } finally {
      reloj.mockRestore()
    }
  }
  /** Sin escrituras en más de 24 h: la acción deja de ser «reciente» para el barrido. */
  const dormir = (ids: string[]) =>
    prisma.$executeRaw`UPDATE "DeliveryLineAction" SET "updatedAt" = ${utcTs(hace(30 * 60 * MIN))} WHERE id = ANY(${ids}::text[])`

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

  beforeEach(async () => {
    // El barrido no distingue venue: cada prueba arranca sin acciones de las anteriores.
    await prisma.deliveryLineAction.deleteMany({ where: { venueId } })
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
    await correr(job) // dentro de su espera corta: no se relee
    await dentroDe(2 * MIN, () => correr(job)) // vencida la espera, vuelve a entrar

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
    // Una UNCERTAIN sobre una orden BLOQUEADA no entra al barrido: la alerta es lo que la deja ver.
    const bloqueada = await sembrar()
    await prisma.order.update({ where: { id: bloqueada.order.id }, data: { deliveryReconcileBlocked: 'INCREASE_UNSUPPORTED' } })
    const u = await accion(bloqueada.order, bloqueada.ext, bloqueada.item.b.id, 'b', {
      status: 'UNCERTAIN',
      lastAttemptAt: hace(25 * 60 * MIN),
    })
    const gritos = jest.spyOn(logger, 'error')

    await correr()
    await correr()

    const alertas = await prisma.activityLog.findMany({ where: { venueId, action: 'DELIVERY_ITEM_REMOVAL_UNREFLECTED' } })
    // Una sola vez cada una, aunque el barrido pase de nuevo.
    expect(alertas.map(x => x.entityId).sort()).toEqual([a.id, u.id].sort())
    expect(alertas.every(x => x.entity === 'DeliveryLineAction')).toBe(true)
    expect(gritos.mock.calls.filter(([m]) => String(m).startsWith('🚨') && String(m).includes('sin reflejar'))).toHaveLength(2)
    // El MCP lo muestra como «retiro sin reflejar en Uber» (spec §3.4).
    const { items } = await listDeliveryLineActions(venueId, { limit: 100 })
    expect(items.find(i => i.lineId === 'b' && i.orderId === vieja.order.id)?.unreflectedInProvider).toBe(true)
    expect(items.find(i => i.orderId === nueva.order.id)?.unreflectedInProvider).toBe(false)
    expect(items.find(i => i.orderId === bloqueada.order.id)?.unreflectedInProvider).toBe(true) // lo mismo que la alerta
  })

  it('I-2: pedido CERRADO en Uber con el renglón presente ⇒ UNCERTAIN→REJECTED y CONFIRMED/PENDING→NO_DELTA, una sola vez', async () => {
    const s = await sembrar()
    const incierta = await accion(s.order, s.ext, s.item.b.id, 'b', { status: 'UNCERTAIN', lastAttemptAt: hace(20 * MIN) })
    const confirmada = await accion(s.order, s.ext, s.item.a.id, 'a', { status: 'CONFIRMED', resolvedAt: new Date() })
    fotos.set(s.ext, { ...s.foto(['a', 'b'], '200.00'), providerClosed: true })
    const gritos = jest.spyOn(logger, 'error')

    const job = new DeliveryLineActionReconcilerJob()
    await correr(job)
    await dentroDe(30 * MIN, () => correr(job)) // vencidas las esperas: ya no queda nada que releer

    expect(lecturasDe(s.ext)).toBe(1)
    expect(await prisma.deliveryLineAction.findUniqueOrThrow({ where: { id: incierta.id } })).toMatchObject({
      status: 'REJECTED',
      providerBody: 'pedido cerrado en el proveedor con el renglón presente',
    })
    expect(await prisma.deliveryLineAction.findUniqueOrThrow({ where: { id: confirmada.id } })).toMatchObject({
      status: 'CONFIRMED',
      settlement: 'NO_DELTA',
    })
    expect(await prisma.activityLog.count({ where: { venueId, entityId: s.order.id, action: 'DELIVERY_LINE_ACTIONS_CLOSED_BY_PROVIDER' } })).toBe(1)
    expect(gritos.mock.calls.filter(([m]) => String(m).startsWith('🚨') && String(m).includes('cerró el pedido'))).toHaveLength(1)
    expect(await reembolsos(s.order.id)).toHaveLength(0)
  })

  it('I-1: a las 24 h alerta UNA vez el retiro FISCAL_PENDING y la orden bloqueada sin retiros pendientes', async () => {
    const hace25h = hace(25 * 60 * MIN)
    const bloqueadaHace25h = async (orderId: string) => {
      const l = await prisma.activityLog.create({
        data: { venueId, action: 'DELIVERY_ORDER_RECONCILE_BLOCKED', entity: 'Order', entityId: orderId, data: {} },
      })
      await prisma.$executeRaw`UPDATE "ActivityLog" SET "createdAt" = ${utcTs(hace25h)} WHERE id = ${l.id}`
    }
    const fiscal = await sembrar()
    await prisma.order.update({ where: { id: fiscal.order.id }, data: { deliveryReconcileBlocked: 'FISCAL_RECLASS_UNSUPPORTED' } })
    await bloqueadaHace25h(fiscal.order.id)
    const f = await accion(fiscal.order, fiscal.ext, fiscal.item.b.id, 'b', {
      status: 'CONFIRMED',
      settlement: 'FISCAL_PENDING',
      lastAttemptAt: hace25h,
      resolvedAt: hace25h,
    })
    const sube = await sembrar() // bloqueada por un aumento del proveedor, sin ningún retiro
    await prisma.order.update({ where: { id: sube.order.id }, data: { deliveryReconcileBlocked: 'INCREASE_UNSUPPORTED' } })
    await bloqueadaHace25h(sube.order.id)
    const reciente = await sembrar() // bloqueada hace un rato: todavía no
    await prisma.order.update({ where: { id: reciente.order.id }, data: { deliveryReconcileBlocked: 'INCREASE_UNSUPPORTED' } })
    await prisma.activityLog.create({
      data: { venueId, action: 'DELIVERY_ORDER_RECONCILE_BLOCKED', entity: 'Order', entityId: reciente.order.id, data: {} },
    })
    const gritos = jest.spyOn(logger, 'error')

    await correr()
    await correr()

    const cuenta = (entityId: string, action: string) => prisma.activityLog.count({ where: { venueId, entityId, action } })
    expect(await cuenta(f.id, 'DELIVERY_ITEM_REMOVAL_UNREFLECTED')).toBe(1)
    expect(await cuenta(sube.order.id, 'DELIVERY_ORDER_BLOCKED_UNRESOLVED')).toBe(1)
    // La orden fiscal ya la cubre la alerta de su retiro: no se grita dos veces el mismo caso.
    expect(await cuenta(fiscal.order.id, 'DELIVERY_ORDER_BLOCKED_UNRESOLVED')).toBe(0)
    expect(await cuenta(reciente.order.id, 'DELIVERY_ORDER_BLOCKED_UNRESOLVED')).toBe(0)
    const deOrden = (gritos.mock.calls as unknown[][]).filter(
      ([m, d]) => String(m).includes('orden bloqueada') && (d as { orderId?: string } | undefined)?.orderId === sube.order.id,
    )
    expect(deOrden).toHaveLength(1)
  })

  it('I-1: el MCP ve qué órdenes están bloqueadas y por qué, aunque no tengan retiros', async () => {
    const s = await sembrar()
    await accion(s.order, s.ext, s.item.b.id, 'b', { status: 'CONFIRMED', settlement: 'ACCREDITED' })
    await prisma.order.update({ where: { id: s.order.id }, data: { deliveryReconcileBlocked: 'INCREASE_UNSUPPORTED' } })
    const sola = await sembrar()
    await prisma.order.update({ where: { id: sola.order.id }, data: { deliveryReconcileBlocked: 'FISCAL_RECLASS_UNSUPPORTED' } })

    const vista = await listDeliveryLineActions(venueId, { limit: 100 })

    expect(vista.items.find(i => i.orderId === s.order.id)?.reconcileBlocked).toBe('INCREASE_UNSUPPORTED')
    expect(vista.blockedOrders.map(o => o.orderId)).toEqual(expect.arrayContaining([s.order.id, sola.order.id]))
    expect(vista.blockedOrders.find(o => o.orderId === sola.order.id)?.reason).toBe('FISCAL_RECLASS_UNSUPPORTED')
    expect(vista.blockedOrdersTotal).toBeGreaterThanOrEqual(2)
  })

  it('N-2: las órdenes bloqueadas tienen su PROPIO cursor: 21 se alcanzan en dos páginas', async () => {
    const mias: string[] = []
    for (let i = 0; i < 21; i++) {
      const s = await sembrar()
      await prisma.order.update({ where: { id: s.order.id }, data: { deliveryReconcileBlocked: 'INCREASE_UNSUPPORTED' } })
      mias.push(s.order.id)
    }

    const p1 = await listDeliveryLineActions(venueId, { limit: 100 })
    expect(p1.blockedOrders).toHaveLength(20)
    expect(p1.blockedOrdersNextCursor).not.toBeNull()
    const vistas = [...p1.blockedOrders.map(o => o.orderId)]
    let cursor = p1.blockedOrdersNextCursor
    while (cursor) {
      const pag = await listDeliveryLineActions(venueId, { limit: 100, blockedCursor: cursor })
      vistas.push(...pag.blockedOrders.map(o => o.orderId))
      cursor = pag.blockedOrdersNextCursor
    }

    expect(new Set(vistas).size).toBe(vistas.length) // sin duplicados
    expect(vistas).toHaveLength(p1.blockedOrdersTotal)
    expect(vistas).toEqual(expect.arrayContaining(mias))
  })

  it('P2: el listado de retiros se recorre COMPLETO por cursor, estable aunque empaten en updatedAt', async () => {
    const x = await sembrar()
    const y = await sembrar()
    const acciones = [
      await accion(x.order, x.ext, x.item.a.id, 'a', { status: 'REJECTED' }),
      await accion(x.order, x.ext, x.item.b.id, 'b', { status: 'REJECTED' }),
      await accion(y.order, y.ext, y.item.a.id, 'a', { status: 'REJECTED' }),
    ]
    await prisma.$executeRaw`UPDATE "DeliveryLineAction" SET "updatedAt" = ${utcTs(hace(MIN))} WHERE id = ANY(${acciones.map(a => a.id)}::text[])`

    const p1 = await listDeliveryLineActions(venueId, { limit: 2 })
    expect(p1).toMatchObject({ total: 3, hasMore: true })
    expect(p1.items).toHaveLength(2)
    const p2 = await listDeliveryLineActions(venueId, { limit: 2, cursor: p1.nextCursor! })
    expect(p2).toMatchObject({ total: 3, hasMore: false, nextCursor: null })

    expect([...p1.items, ...p2.items].map(i => i.id).sort()).toEqual(acciones.map(a => a.id).sort())
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

  it('las dormidas ROTAN: dos pasadas alcanzan a las 25 aunque el lote sea de 20', async () => {
    const dormidas: Array<Awaited<ReturnType<typeof sembrar>>> = []
    for (let i = 0; i < 25; i++) dormidas.push(await sembrar())
    const acciones: Array<{ id: string }> = []
    for (const d of dormidas) acciones.push(await accion(d.order, d.ext, d.item.b.id, 'b', { status: 'CONFIRMED' }))
    await dormir(acciones.map(x => x.id))
    const leidas = () => new Set(dormidas.filter(d => lecturasDe(d.ext) > 0).map(d => d.ext))

    const job = new DeliveryLineActionReconcilerJob()
    await correr(job)
    expect(leidas().size).toBe(20)
    await correr(job)

    expect(leidas().size).toBe(25) // sin el cursor, la 2.ª pasada vuelve a las mismas 20
  })

  it('una acción RECIENTE entra en su primer tick aunque haya más de 20 dormidas', async () => {
    const dormidas: Array<Awaited<ReturnType<typeof sembrar>>> = []
    for (let i = 0; i < 22; i++) dormidas.push(await sembrar())
    const viejas: Array<{ id: string }> = []
    for (const d of dormidas) viejas.push(await accion(d.order, d.ext, d.item.b.id, 'b', { status: 'CONFIRMED' }))
    await dormir(viejas.map(x => x.id))
    const fresca = await sembrar() // su id es el mayor: por id, iría al final de la fila
    await accion(fresca.order, fresca.ext, fresca.item.b.id, 'b', { status: 'UNCERTAIN', lastAttemptAt: hace(3 * MIN) })

    await correr()

    expect(lecturasDe(fresca.ext)).toBe(1)
  })

  it('16 recientes atoradas no dejan fuera a una reciente más vieja: entra a más tardar en el 2.º tick', async () => {
    const atoradas: Array<Awaited<ReturnType<typeof sembrar>>> = []
    for (let i = 0; i < 16; i++) atoradas.push(await sembrar())
    for (const a of atoradas) await accion(a.order, a.ext, a.item.b.id, 'b', { status: 'CONFIRMED' })
    const vieja = await sembrar()
    const v = await accion(vieja.order, vieja.ext, vieja.item.b.id, 'b', { status: 'CONFIRMED' })
    // Reciente (menos de 24 h), pero con la escritura más vieja: por `updatedAt DESC` es la 17.ª.
    await prisma.$executeRaw`UPDATE "DeliveryLineAction" SET "updatedAt" = ${utcTs(hace(2 * 60 * MIN))} WHERE id = ${v.id}`

    const job = new DeliveryLineActionReconcilerJob()
    await correr(job)
    expect(lecturasDe(vieja.ext)).toBe(0) // la cubeta de recientes (15) se llenó con las más nuevas
    await correr(job)

    expect(lecturasDe(vieja.ext)).toBe(1) // sin la espera, la 2.ª pasada re-elige las mismas 15
  })

  it('una DORMIDA que no avanza suma a la racha y espera; una reciente que no avanza, no', async () => {
    const dormida = await sembrar()
    const reciente = await sembrar()
    const d = await accion(dormida.order, dormida.ext, dormida.item.b.id, 'b', { status: 'CONFIRMED' })
    await accion(reciente.order, reciente.ext, reciente.item.b.id, 'b', { status: 'CONFIRMED' })
    await dormir([d.id])
    const rachaDe = (orderId: string) =>
      prisma.activityLog.findMany({ where: { entity: 'Order', entityId: orderId, action: 'DELIVERY_RECONCILE_ERROR' } })

    const job = new DeliveryLineActionReconcilerJob()
    for (let i = 0; i < 4; i++) await correr(job)

    const racha = await rachaDe(dormida.order.id)
    expect(racha.map(x => (x.data as { error: string }).error)).toEqual(['SIN_AVANCE', 'SIN_AVANCE', 'SIN_AVANCE'])
    expect(lecturasDe(dormida.ext)).toBe(3) // la 4.ª pasada ya la saltó en SQL
    // La reciente sin avance espera en memoria (1 min), no en la racha: las 3 pasadas siguientes
    // son inmediatas y no la releen.
    expect(lecturasDe(reciente.ext)).toBe(1)
    expect(await rachaDe(reciente.order.id)).toHaveLength(0)
  })

  it('una venta CANCELADA no mueve dinero: la reconciliación la rechaza y el barrido no la toma', async () => {
    const s = await sembrar()
    const a = await accion(s.order, s.ext, s.item.b.id, 'b', { status: 'CONFIRMED' })
    fotos.set(s.ext, s.foto(['a'], '150.00')) // compensaría $50 si no estuviera cancelada
    await prisma.order.update({ where: { id: s.order.id }, data: { status: 'CANCELLED' } })

    const r = await reconciliacion.reconcileDeliveryOrderFromProvider(s.order.id, { trigger: 'JOB' })

    expect(r.outcome).toBe('ORDER_CANCELLED')
    expect(lecturasDe(s.ext)).toBe(0)
    expect(await reembolsos(s.order.id)).toHaveLength(0)
    expect(await prisma.deliveryLineAction.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: 'CONFIRMED',
      settlement: 'PENDING',
    })
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: s.item.b.id } })).removedAt).toBeNull()

    const espia = jest.spyOn(reconciliacion, 'reconcileDeliveryOrderFromProvider')
    await correr()
    expect(espia.mock.calls.filter(c => c[0] === s.order.id)).toHaveLength(0)
  })

  it('un PROGRAMADO colocado hace más de 24 h también reintenta su listo (manda la comanda)', async () => {
    const s = await sembrar()
    await prisma.order.update({ where: { id: s.order.id }, data: { createdAt: hace(30 * 60 * MIN) } })
    await prisma.kdsOrder.updateMany({ where: { orderId: s.order.id }, data: { status: KdsOrderStatus.COMPLETED } })

    await correr()

    expect(uberAdapter.markOrderReady).toHaveBeenCalledWith(s.ext, link.externalLocationId)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).readyReportedAt).not.toBeNull()
  })

  it('un retiro en curso deja fuera el reintento del listo (no gasta reservas)', async () => {
    const s = await sembrar()
    await accion(s.order, s.ext, s.item.b.id, 'b', { status: 'UNCERTAIN', lastAttemptAt: hace(3 * MIN) })
    await prisma.kdsOrder.updateMany({ where: { orderId: s.order.id }, data: { status: KdsOrderStatus.COMPLETED } })
    const espia = jest.spyOn(respuestas, 'markDeliveryOrderReady')

    await correr()

    expect(espia.mock.calls.filter(c => c[1] === s.order.id)).toHaveLength(0)
  })

  it('el listo que otro acreditó entre la lectura y la reserva no se manda dos veces', async () => {
    const s = await sembrar()
    const real = deliveryOrderLock.tomarReserva
    jest.spyOn(deliveryOrderLock, 'tomarReserva').mockImplementation(async (orderId, op, tx) => {
      // El 2xx del bump se acredita justo antes de que esta operación tome la reserva.
      await prisma.order.update({ where: { id: orderId }, data: { readyReportedAt: new Date() } })
      return real(orderId, op, tx)
    })

    const r = await respuestas.markDeliveryOrderReady(venueId, s.order.id)

    expect(r.outcome).toBe('ALREADY_DONE')
    expect(uberAdapter.markOrderReady).not.toHaveBeenCalled()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).deliveryOpToken).toBeNull()
  })

  it('un pedido sin canal que avise «listo» no se reevalúa en toda la ventana ni cuenta como reintento', async () => {
    const s = await sembrar()
    await prisma.order.update({ where: { id: s.order.id }, data: { deliveryChannelLinkId: null } })
    await prisma.kdsOrder.updateMany({ where: { orderId: s.order.id }, data: { status: KdsOrderStatus.COMPLETED } })
    // Los «listos» pendientes de pruebas anteriores no deben entrar al contador de esta pasada.
    await prisma.order.updateMany({ where: { venueId, id: { not: s.order.id } }, data: { readyReportedAt: new Date() } })
    const espia = jest.spyOn(respuestas, 'markDeliveryOrderReady')

    const job = new DeliveryLineActionReconcilerJob()
    const primera = await correr(job)
    await correr(job)

    expect(espia.mock.calls.filter(c => c[1] === s.order.id)).toHaveLength(1)
    expect(primera.listos).toBe(0)
  })

  it('M-5: un pedido de un proveedor SIN adaptador no ocupa lugar en el reintento de «listo»', async () => {
    const s = await sembrar()
    await prisma.order.update({ where: { id: s.order.id }, data: { externalId: `DELIVERECT:${s.ext}` } })
    await prisma.kdsOrder.updateMany({ where: { orderId: s.order.id }, data: { status: KdsOrderStatus.COMPLETED } })
    const espia = jest.spyOn(respuestas, 'markDeliveryOrderReady')

    await correr()

    expect(espia.mock.calls.filter(c => c[1] === s.order.id)).toHaveLength(0)
  })

  it('los índices que sirven al barrido existen', async () => {
    const idx = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('KdsOrder_orderId_idx', 'KdsOrder_delivery_done_updatedAt_idx', 'Order_deliveryOpInFlightAt_pending_idx',
                          'Order_deliveryReconcileBlocked_idx')`
    expect(idx.map(i => i.indexname).sort()).toEqual([
      'KdsOrder_delivery_done_updatedAt_idx',
      'KdsOrder_orderId_idx',
      'Order_deliveryOpInFlightAt_pending_idx',
      'Order_deliveryReconcileBlocked_idx',
    ])
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
      expect(ev.externalOrderId).toBe(s.ext) // el evento sigue nombrando al pedido de Uber
    })

    // P1-2 definitivo (3.ª pasada): el aviso SÓLO se cierra con evidencia — el pedido CERRADO en Uber
    // con su foto final reconciliada — o al agotarse la vida del pedido (~3 h), con incidencia visible.
    const H = 60 * MIN
    const VIDA = 3 * H
    const cerrada = (f: NormalizedDeliveryOrder): NormalizedDeliveryOrder => ({ ...f, providerClosed: true })
    const envejecer = (id: string, ms: number) => prisma.deliveryOrderEvent.update({ where: { id }, data: { receivedAt: hace(ms) } })
    const incidencias = (orderId: string, action: string) => prisma.activityLog.findMany({ where: { venueId, entityId: orderId, action } })

    it('P1-2: ni la foto VIEJA ni una foto repetida cierran el aviso; cierra cuando el pedido CIERRA y su foto final se reconcilia', async () => {
      const s = await sembrar() // el proveedor aún devuelve el pedido intacto
      const { id: eventoId } = await evento(s.ext)

      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'FAILED', error: 'CAMBIO_SIN_CONFIRMAR' })
      expect(await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: eventoId } })).toMatchObject({
        status: 'FAILED',
        error: 'CAMBIO_SIN_CONFIRMAR',
        orderId: s.order.id,
      })
      fotos.set(s.ext, { ...s.foto(['a'], '150.00'), raw: { fuente: 'foto-fresca' } }) // cambió; el pedido sigue abierto
      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'FAILED', error: 'CAMBIO_SIN_CONFIRMAR' })
      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'FAILED', error: 'CAMBIO_SIN_CONFIRMAR' }) // repetida: nada
      fotos.set(s.ext, cerrada({ ...s.foto(['a'], '150.00'), raw: { fuente: 'foto-final' } }))
      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'RECONCILED', orderId: s.order.id })

      expect((await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: eventoId } })).status).toBe('PROCESSED')
      expect((await reembolsos(s.order.id)).map(f => f.amount.toString())).toEqual(['-50'])
      // M-1: tras el reprecio la orden guarda la foto que lo justificó.
      expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).posRawData).toEqual({ fuente: 'foto-fresca' })
      expect(await incidencias(s.order.id, 'DELIVERY_ORDER_CHANGE_UNREFLECTED')).toHaveLength(0)
      expect(await incidencias(s.order.id, 'DELIVERY_ORDER_CHANGE_UNCONFIRMED')).toHaveLength(0)
    })

    it('Codex r3 #1: foto parcial REPETIDA y después el retiro ⇒ ambos reembolsos y la venta en $150', async () => {
      const s = await sembrar('10.00')
      fotos.set(s.ext, s.foto(['a', 'b'], '200.00', '5.00')) // bajó la propina; el artículo aún no
      const { id: eventoId } = await evento(s.ext)

      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'FAILED', error: 'CAMBIO_SIN_CONFIRMAR' })
      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'FAILED', error: 'CAMBIO_SIN_CONFIRMAR' }) // la MISMA foto
      fotos.set(s.ext, s.foto(['a'], '150.00', '5.00'))
      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'FAILED', error: 'CAMBIO_SIN_CONFIRMAR' })
      fotos.set(s.ext, cerrada(s.foto(['a'], '150.00', '5.00')))
      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'RECONCILED', orderId: s.order.id })

      const refunds = await reembolsos(s.order.id)
      expect(refunds.reduce((t, f) => t.plus(f.amount), new Prisma.Decimal(0)).toString()).toBe('-50')
      expect(refunds.reduce((t, f) => t.plus(f.tipAmount), new Prisma.Decimal(0)).toString()).toBe('-5')
      expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).subtotal.toString()).toBe('150')
    })

    it('Codex r3 #2: retiro A por la ruta; el aviso de un retiro B con foto atrasada NO se cierra hasta que el pedido cierra', async () => {
      const tres: Renglon[] = [
        { linea: 'a', nombre: 'Cochinita', precio: '100.00' },
        { linea: 'b', nombre: 'Horchata', precio: '50.00' },
        { linea: 'c', nombre: 'Agua', precio: '50.00' },
      ]
      const s = await sembrar('0.00', tres)
      await accion(s.order, s.ext, s.item.c.id, 'c', { status: 'CONFIRMED', resolvedAt: new Date() })
      fotos.set(s.ext, s.foto(['a', 'b'], '150.00'))
      expect((await reconciliacion.reconcileDeliveryOrderFromProvider(s.order.id, { trigger: 'ROUTE' })).outcome).toBe('REFUNDED')
      const { id: eventoId } = await evento(s.ext) // avisa el retiro de B; la foto aún lo trae

      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'FAILED', error: 'CAMBIO_SIN_CONFIRMAR' })
      expect((await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: eventoId } })).status).toBe('FAILED')

      fotos.set(s.ext, cerrada(s.foto(['a'], '100.00'))) // la foto FINAL ya sin B
      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'RECONCILED', orderId: s.order.id })

      expect((await reembolsos(s.order.id)).map(f => f.amount.toString()).sort()).toEqual(['-50', '-50'])
      expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).subtotal.toString()).toBe('100')
    })

    it('N-3: un fallo de lectura a media secuencia no borra el avance: al vencer, la incidencia dice que el cambio SÍ se vio', async () => {
      const s = await sembrar()
      fotos.set(s.ext, s.foto(['a'], '150.00'))
      const { id: eventoId } = await evento(s.ext)

      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'FAILED', error: 'CAMBIO_SIN_CONFIRMAR' })
      fotos.delete(s.ext) // el GET truena
      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'FAILED', error: 'READ_FAILED' })
      fotos.set(s.ext, s.foto(['a'], '150.00'))
      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'FAILED', error: 'CAMBIO_SIN_CONFIRMAR' })
      await envejecer(eventoId, VIDA + MIN)
      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'RECONCILED', orderId: s.order.id })

      const [refund] = await reembolsos(s.order.id)
      expect(await incidencias(s.order.id, 'DELIVERY_ORDER_CHANGE_UNREFLECTED')).toHaveLength(0) // nada de «nunca se reflejó»
      const [inc] = await incidencias(s.order.id, 'DELIVERY_ORDER_CHANGE_UNCONFIRMED')
      expect(inc.data).toMatchObject({ eventId: eventoId, cambioVisto: true, reembolsos: [refund.id] })
    })

    it('N-4: la vida del pedido vence mientras la foto sigue cambiando ⇒ incidencia aunque el último resultado sea REFUNDED', async () => {
      const s = await sembrar('10.00')
      fotos.set(s.ext, s.foto(['a', 'b'], '200.00', '5.00'))
      const { id: eventoId } = await evento(s.ext)
      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'FAILED', error: 'CAMBIO_SIN_CONFIRMAR' })
      await envejecer(eventoId, VIDA + MIN)
      fotos.set(s.ext, s.foto(['a'], '150.00', '5.00')) // sigue abierto y acaba de cambiar
      const gritos = jest.spyOn(logger, 'error')

      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'RECONCILED', orderId: s.order.id })

      expect((await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: eventoId } })).status).toBe('PROCESSED')
      expect((await reembolsos(s.order.id)).some(f => f.amount.toString() === '-50')).toBe(true) // esta lectura sí liquidó
      expect(await incidencias(s.order.id, 'DELIVERY_ORDER_CHANGE_UNCONFIRMED')).toHaveLength(1)
      const deEsta = (gritos.mock.calls as unknown[][]).filter(
        ([m, d]) => String(m).startsWith('🚨') && String(m).includes('no se confirmó') && (d as { orderId?: string } | undefined)?.orderId === s.order.id,
      )
      expect(deEsta).toHaveLength(1)
    })

    it('P1-2: si Uber ya CERRÓ el pedido, una foto sin cambios es definitiva: se cierra el aviso sin releer', async () => {
      const s = await sembrar()
      fotos.set(s.ext, cerrada(s.foto(['a', 'b'], '200.00')))
      const { id: eventoId } = await evento(s.ext)

      expect(await processUberEvent(eventoId)).toMatchObject({ outcome: 'RECONCILED', orderId: s.order.id })

      expect((await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: eventoId } })).status).toBe('PROCESSED')
      expect(await reembolsos(s.order.id)).toHaveLength(0)
    })

    it('P1-2: un cambio que NUNCA se refleja se cierra VISIBLE al agotarse la vida del pedido, sin reintentar para siempre', async () => {
      const s = await sembrar()
      const { id: eventoId } = await evento(s.ext)
      await envejecer(eventoId, VIDA + MIN)
      const gritos = jest.spyOn(logger, 'error')

      const r = await processUberEvent(eventoId)

      expect(r).toMatchObject({ outcome: 'RECONCILED', orderId: s.order.id })
      expect((await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: eventoId } })).status).toBe('PROCESSED')
      const rastro = await incidencias(s.order.id, 'DELIVERY_ORDER_CHANGE_UNREFLECTED')
      expect(rastro).toHaveLength(1)
      expect(rastro[0].data).toMatchObject({ eventId: eventoId, cambioVisto: false })
      expect(gritos.mock.calls.some(([m]) => String(m).startsWith('🚨') && String(m).includes('nunca mostró el cambio'))).toBe(true)
      expect(await reembolsos(s.order.id)).toHaveLength(0)
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
      fotos.set(s.ext, { ...s.foto(['a'], '150.00'), providerClosed: true }) // la foto final, ya cerrada
      const { id: eventoId } = await evento(s.ext)

      const r = await processUberEvent(eventoId)

      expect(r).toMatchObject({ outcome: 'RECONCILED', orderId: s.order.id })
      expect(lecturasDe(s.ext)).toBe(1)
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
