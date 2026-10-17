// tests/integration/online-ordering/lifecycle.integration.test.ts
/**
 * Integration (REAL DB) — ciclo de vida de un pedido en línea.
 * Lo que los mocks no prueban: el CAS contra Postgres de verdad (dos aparatos aceptando; aceptar contra vencer), la admisión
 * serializada con `pg_advisory_xact_lock`, la idempotencia por `externalId` único, la creación real de Order + renglones +
 * extras que cuadran con la factura y, 🔴 la evidencia que `orderFiscalWriters.test.ts` pide para `casTransition` (LOCKED):
 * la máquina de estados relee la `Order` BAJO su candado y no reabre ni cancela una venta que el cobro real (`payCashOrder`)
 * dejó cobrada; tampoco revive una que la cancelación existente (`cancelOrder`) canceló. H6: el cobro cae en el turno abierto,
 * un rechazo que espera al cobro pierde, y un CAS perdido dentro de la cancelación revierte la `Order` en Postgres.
 */
import { OnlineOrderStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { examinarRenglon } from '@/services/fiscal/cfdi.service'
import { cancelOrder, payCashOrder } from '@/services/mobile/order.mobile.service'
import { listInbox } from '@/services/online-ordering/inbox.service'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import * as avisos from '@/services/online-ordering/notifications.service'
import { createOnlineOrder } from '@/services/online-ordering/order.service'
import { __resetPresenceDebounceForTests, touchInboxPoll } from '@/services/online-ordering/presence.service'
import { claimOnlineOrderPrint, confirmOnlineOrderPrinted } from '@/services/online-ordering/printClaim.service'
import { quoteCart } from '@/services/online-ordering/quote.service'
import { updateSettings } from '@/services/online-ordering/settings.service'
import {
  acceptOnlineOrder,
  cancelOnlineOrderByStaff,
  expireOnlineOrder,
  markOnlineOrderDelivered,
  markOnlineOrderReady,
  rejectOnlineOrder,
} from '@/services/online-ordering/transitions.service'

// El guardia global rechaza `av-db-25` y hosts remotos; esta suite exige además una base DESECHABLE por nombre.
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9_]+_test_[a-z0-9_]+$/.test(database.pathname)) {
  throw new Error('Esta suite sólo corre contra una base desechable avoqado_<tarea>_test_<fecha> en localhost.')
}

// Fuera de alcance aquí: sockets, avisos a terceros y armar comandas de pantalla (la tarea 9 ya cubre que se pidan). La
// cancelación existente SÍ corre real (retira comandas con la versión real de `retirarComandasDeVentaAnulada`).
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { broadcastToVenue: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(async () => undefined),
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
// H6: SIN mock de `cashDrawerPosting`. El fixture no abre cajón: el cobro real no publica al cajón (sólo lo hace con una caja OPEN).

const TITULO_COBRO_REAL = 'el cobro real deja la orden cobrada y aceptar, listo y entregar no la reabren'
const TITULO_COBRADO_NO_SE_CANCELA = 'vencer o rechazar un pedido ya cobrado no cancela la venta, y aceptarlo sigue posible'

const RUN = Date.now()

describe('Pedidos en línea — ciclo de vida (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let shiftId: string
  let customerId: string
  let otherCustomerId: string
  let productId: string
  let modifierId: string
  let seq = 0
  let phoneSeq = 0
  const nextKey = () => `itest-${RUN}-${++seq}-`.padEnd(40, 'x')
  // R23: un teléfono distinto (y válido para libphonenumber) por pedido.
  const nextPhone = () => `+5255${40_000_000 + (((RUN % 100_000) * 100 + ++phoneSeq) % 60_000_000)}`
  const ITEMS = () => [{ productId, quantity: 2, modifiers: [{ modifierId }] }]

  const newOrder = (o: { key?: string; phone?: string; expectedTotal?: string; items?: any[]; customer?: string } = {}) => {
    const phone = o.phone ?? nextPhone()
    return createOnlineOrder({
      venueId: venueId!,
      idempotencyKey: o.key ?? nextKey(),
      items: o.items ?? ITEMS(),
      paymentMode: 'PAY_AT_PICKUP',
      expectedTotal: o.expectedTotal ?? '206.00',
      customer: { name: 'María ITEST', phone },
      customerId: o.customer ?? customerId,
      verifiedPhone: phone,
      note: null,
      whatsappConsent: false,
    })
  }
  // R23: cada caso que necesita presencia escribe su propio latido.
  const beat = async () => {
    __resetPresenceDebounceForTests()
    await touchInboxPoll(venueId!)
  }
  const pay = (orderId: string) => payCashOrder(venueId!, orderId, { amount: 20_600, tip: 0, idempotencyKey: `itest-pay-${orderId}` })
  /** Preparación que muerde: si aceptar no deja el pedido ACCEPTED, el caso no arranca desde un estado equivocado. */
  const aceptar = (orderId: string) =>
    expect(acceptOnlineOrder({ venueId: venueId!, orderId, staffId: null })).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })
  /**
   * H6: espera a que alguna sesión quede BLOQUEADA por la del cobro (la carrera es real, no secuencial). Se ata al proceso de
   * Postgres que retiene el candado (`pg_blocking_pids`), no al texto de la consulta. Acotada: si no ocurre, INCONCLUSO.
   */
  const esperarQueAlguienEspereAlCobro = async (pidDelCobro: number | undefined) => {
    for (let i = 0; pidDelCobro !== undefined && i < 100; i++) {
      const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND ${pidDelCobro}::int = ANY(pg_blocking_pids(pid))`
      if (n > 0) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('INCONCLUSO: el rechazo nunca quedó esperando el candado que retiene el cobro')
  }

  const estadoDe = async (onlineOrderId: string) => (await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).status
  /** `logAction` es un simulacro en TODA la integración (`integration-setup.ts`): se miran sus llamadas para ESTE pedido. */
  const bitacora = (onlineOrderId: string, action: string) =>
    (logAction as jest.Mock).mock.calls.map(([p]) => p).filter(p => p.entityId === onlineOrderId && p.action === action)
  /** Listo para cobrar: aceptado y (si se pide) marcado listo; devuelve también su cuenta. */
  const pedidoListo = async (o: { ready?: boolean } = {}) => {
    const created = await newOrder()
    await aceptar(created.orderId)
    if (o.ready !== false) {
      await expect(markOnlineOrderReady({ venueId: venueId!, orderId: created.orderId, staffId: null })).resolves.toMatchObject({
        outcome: 'OK',
      })
    }
    return created
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Pedidos Org', slug: `itest-pedidos-org-${RUN}`, email: `itest-pedidos-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    // R18 (1b): encender la tienda exige domicilio, teléfono y aviso de privacidad publicado del negocio.
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Pedidos Venue',
        slug: `itest-pedidos-${RUN}`,
        organizationId: org.id,
        timezone: 'America/Mexico_City',
        address: 'Av. Coyoacán 123',
        city: 'CDMX',
        state: 'CDMX',
        zipCode: '04000',
        phone: '5512345678',
      },
    })
    venueId = venue.id
    await prisma.privacyNoticeVersion.create({ data: { venueId, content: 'Aviso de privacidad ITEST', contentHash: `itest-${RUN}` } })

    // H6: un turno de caja ABIERTO del negocio (lo abre una persona). El cobro real lo reclama y estampa `Payment.shiftId`.
    staffId = (
      await prisma.staff.create({
        data: { email: `itest-pedidos-staff-${RUN}@test.com`, firstName: 'Caja', lastName: 'ITEST', active: true },
      })
    ).id
    shiftId = (await prisma.shift.create({ data: { venueId, staffId, startTime: new Date(), status: 'OPEN', startingCash: 0 } })).id

    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Flautas', slug: `flautas-${RUN}` } })
    const group = await prisma.modifierGroup.create({
      data: { venueId, name: 'Salsa', required: true, allowMultiple: false, minSelections: 1, maxSelections: 1 },
    })
    const mod = await prisma.modifier.create({ data: { groupId: group.id, name: 'Salsa verde', price: 10 } })
    modifierId = mod.id
    const product = await prisma.product.create({
      data: { venueId, name: 'Flautas de pollo', sku: `FLA-${RUN}`, price: 93, categoryId: category.id, availableOnline: true },
    })
    productId = product.id
    await prisma.productModifierGroup.create({ data: { productId, groupId: group.id, displayOrder: 0 } })

    customerId = (await prisma.customer.create({ data: { venueId, phone: nextPhone(), firstName: 'María', provider: 'PHONE' } })).id
    otherCustomerId = (await prisma.customer.create({ data: { venueId, phone: nextPhone(), firstName: 'Otra', provider: 'PHONE' } })).id

    await updateSettings(venueId, { enabled: true, minOrderAmount: 0, defaultPrepMinutes: 15 }, null)
    clearPublicMenuCache()
  })

  afterAll(async () => {
    // Limpieza acotada: sin venueId NO se borra nada (una limpieza sin filtro vaciaría tablas enteras).
    if (!venueId) return
    const v = { venueId }
    await prisma.activityLog.deleteMany({ where: v })
    await prisma.paymentEffect.deleteMany({ where: v })
    await prisma.inventoryPosting.deleteMany({ where: v })
    await prisma.venueTransaction.deleteMany({ where: v })
    await prisma.payment.deleteMany({ where: v }) // recibos digitales y asignaciones del pago se van en cascada
    await prisma.onlineOrder.deleteMany({ where: v })
    await prisma.order.deleteMany({ where: v }) // renglones y extras se van en cascada
    await prisma.shift.deleteMany({ where: v }) // después de pagos y órdenes, que lo referencian
    await prisma.productModifierGroup.deleteMany({ where: { product: v } })
    await prisma.product.deleteMany({ where: v })
    await prisma.modifier.deleteMany({ where: { group: v } })
    await prisma.modifierGroup.deleteMany({ where: v })
    await prisma.menuCategory.deleteMany({ where: v })
    await prisma.customer.deleteMany({ where: v })
    await prisma.onlineOrderingSettings.deleteMany({ where: v })
    await prisma.privacyNoticeVersion.deleteMany({ where: v })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } }) // ya sin turnos que la referencien
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  it('sin bandeja abierta la tienda NO recibe pedidos; con su latido sí', async () => {
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { lastInboxPollAt: null } })
    __resetPresenceDebounceForTests()
    await expect(newOrder()).rejects.toMatchObject({ code: 'ORDERING_OFFLINE' })
    await beat()
    await expect(newOrder()).resolves.toMatchObject({ status: 'PENDING_ACCEPTANCE', replay: false })
  })

  it('cotiza en el servidor y crea Order + renglones + extras POR UNIDAD que cuadran con la factura (F2, R3)', async () => {
    await beat()
    const q = await quoteCart(venueId!, ITEMS())
    expect(q.total.toFixed(2)).toBe('206.00') // (93 + 10) × 2

    const res = await newOrder()
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: res.orderId },
      include: { items: { include: { modifiers: true } } },
    })
    expect(order).toMatchObject({
      type: 'PICKUP',
      source: 'WEB',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      contratoDePrecio: 'IVA_INCLUIDO',
    })
    expect(Number(order.total)).toBe(206)
    const item = order.items[0]
    expect(item.categoryName).toBe('Flautas')
    expect(Number(item.total)).toBe(206)
    expect(item.modifiers[0]).toMatchObject({ quantity: 1 })
    expect(Number(item.modifiers[0].price)).toBe(10) // por unidad, como la terminal
    const examinado = examinarRenglon(
      {
        id: item.id,
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountAmount: item.discountAmount,
        total: item.total,
        modifiers: item.modifiers,
        product: { name: 'Flautas de pollo', taxRate: 0.16, objetoImp: '02' },
      },
      0,
    )
    expect(examinado).not.toHaveProperty('motivos')
  })

  it('la misma llave del MISMO cliente devuelve el mismo pedido aunque ya esté aceptado; de otro cliente es 409 (R8)', async () => {
    await beat()
    const key = nextKey()
    const phone = nextPhone()
    const one = [{ productId, quantity: 1, modifiers: [{ modifierId }] }]
    const first = await newOrder({ key, phone, items: one, expectedTotal: '103.00' })
    await aceptar(first.orderId)
    const again = await newOrder({ key, phone, items: one, expectedTotal: '103.00' })
    expect(again).toMatchObject({ replay: true, orderId: first.orderId, trackingToken: first.trackingToken, status: 'ACCEPTED' })
    await expect(newOrder({ key, items: one, expectedTotal: '103.00', customer: otherCustomerId })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
    })
    expect(await prisma.order.count({ where: { venueId: venueId!, externalId: `web:${key}` } })).toBe(1)
  })

  it('la misma llave en dos peticiones SIMULTÁNEAS crea un solo pedido: una lo crea y la otra recibe la repetición (R8)', async () => {
    await beat()
    const key = nextKey()
    const phone = nextPhone()
    const [a, b] = await Promise.all([newOrder({ key, phone }), newOrder({ key, phone })])
    expect([a.replay, b.replay].sort()).toEqual([false, true])
    expect(b.orderId).toBe(a.orderId)
    expect(b.trackingToken).toBe(a.trackingToken)
    expect(await prisma.order.count({ where: { venueId: venueId!, externalId: `web:${key}` } })).toBe(1)
    expect(await prisma.onlineOrder.count({ where: { venueId: venueId!, orderId: a.orderId } })).toBe(1)
  })

  it('si el total cambió, PRICE_CHANGED con la cotización nueva y no se crea nada (R5)', async () => {
    await beat()
    const key = nextKey()
    await expect(newOrder({ key, expectedTotal: '200.00' })).rejects.toMatchObject({
      code: 'PRICE_CHANGED',
      details: { quote: { total: 206 } },
    })
    expect(await prisma.order.count({ where: { venueId: venueId!, externalId: `web:${key}` } })).toBe(0)
  })

  it('dos aparatos aceptando a la vez: exactamente uno gana', async () => {
    await beat()
    const { orderId } = await newOrder()
    const [a, b] = await Promise.all([
      acceptOnlineOrder({ venueId: venueId!, orderId, staffId: null }),
      acceptOnlineOrder({ venueId: venueId!, orderId, staffId: null }),
    ])
    expect([a.outcome, b.outcome].sort()).toEqual(['OK', 'STALE'])
  })

  it('aceptar justo al vencer: gana el vencimiento, la cuenta queda cancelada y aceptar responde EXPIRED', async () => {
    await beat()
    const { orderId, onlineOrderId } = await newOrder()
    await prisma.onlineOrder.update({ where: { id: onlineOrderId }, data: { acceptDeadlineAt: new Date(Date.now() - 1_000) } })
    const [accept] = await Promise.all([
      acceptOnlineOrder({ venueId: venueId!, orderId, staffId: null }),
      expireOnlineOrder({ venueId: venueId!, orderId }),
    ])
    expect(accept).toEqual({ outcome: 'STALE', status: 'EXPIRED' })
    expect((await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).status).toBe(OnlineOrderStatus.EXPIRED)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
  })

  it('rechazar cancela la cuenta; un segundo rechazo es STALE', async () => {
    await beat()
    const { orderId } = await newOrder()
    await expect(rejectOnlineOrder({ venueId: venueId!, orderId, staffId: null, reason: 'OUT_OF_ITEMS' })).resolves.toMatchObject({
      outcome: 'OK',
      status: 'REJECTED',
    })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    await expect(rejectOnlineOrder({ venueId: venueId!, orderId, staffId: null, reason: 'OTHER' })).resolves.toMatchObject({
      outcome: 'STALE',
    })
  })

  it(TITULO_COBRO_REAL, async () => {
    await beat()
    const { orderId } = await newOrder()
    const turnoAntes = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
    const cobro = await pay(orderId)
    const cobrada = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(cobrada.paymentStatus).toBe('PAID')
    // H6: el cobro cae en el turno ABIERTO del negocio y le suma su importe; la orden en línea no se ata al turno (tarea 7).
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: cobro.paymentId } })).shiftId).toBe(shiftId)
    expect(cobrada.shiftId).toBeNull()
    const turnoDespues = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
    expect(turnoDespues.totalSales.minus(turnoAntes.totalSales).toFixed(2)).toBe('206.00')
    expect(turnoDespues.totalOrders - turnoAntes.totalOrders).toBe(1)

    await expect(acceptOnlineOrder({ venueId: venueId!, orderId, staffId: null })).resolves.toMatchObject({
      outcome: 'OK',
      status: 'ACCEPTED',
    })
    await expect(markOnlineOrderReady({ venueId: venueId!, orderId, staffId: null })).resolves.toMatchObject({
      outcome: 'OK',
      status: 'READY',
    })
    // ni CONFIRMED ni READY: la venta cobrada no se reabre
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(cobrada.status)
    await expect(markOnlineOrderDelivered({ venueId: venueId!, orderId, staffId: null })).resolves.toMatchObject({
      outcome: 'OK',
      status: 'COMPLETED',
    })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'COMPLETED', paymentStatus: 'PAID' })
  })

  it(TITULO_COBRADO_NO_SE_CANCELA, async () => {
    await beat()
    const { orderId, onlineOrderId } = await newOrder()
    await expect(pay(orderId)).resolves.toMatchObject({ status: 'COMPLETED' })
    await prisma.onlineOrder.update({ where: { id: onlineOrderId }, data: { acceptDeadlineAt: new Date(Date.now() - 1_000) } })

    await expect(expireOnlineOrder({ venueId: venueId!, orderId })).resolves.toEqual({ outcome: 'HAS_PAYMENTS' })
    await expect(rejectOnlineOrder({ venueId: venueId!, orderId, staffId: null, reason: 'TOO_BUSY' })).resolves.toEqual({
      outcome: 'HAS_PAYMENTS',
    })
    // `payCashOrder` salda y cierra la cuenta (`COMPLETED`); ni vencer ni rechazar la movieron a CANCELLED.
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED' })
    expect((await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).status).toBe('PENDING_ACCEPTANCE')
    // Un pedido ya cobrado no vence: se acepta aunque haya pasado la hora límite.
    await expect(acceptOnlineOrder({ venueId: venueId!, orderId, staffId: null })).resolves.toMatchObject({
      outcome: 'OK',
      status: 'ACCEPTED',
    })
  })

  it('una cuenta cancelada por la cancelación del POS no revive al aceptar: el pedido queda cancelado por el negocio (R2)', async () => {
    await beat()
    const { orderId, onlineOrderId } = await newOrder()
    await cancelOrder(venueId!, orderId)
    await expect(acceptOnlineOrder({ venueId: venueId!, orderId, staffId: null })).resolves.toEqual({
      outcome: 'STALE',
      status: 'CANCELLED_BY_STAFF',
    })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    expect((await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).cancelledBy).toBe('ORDER_CANCELLED_ELSEWHERE')
  })

  it('cancelar por personal usa la cancelación existente: cuenta CANCELLED y pedido CANCELLED_BY_STAFF en la misma transacción (R1)', async () => {
    await beat()
    const { orderId, onlineOrderId } = await newOrder()
    await aceptar(orderId)
    await expect(cancelOnlineOrderByStaff({ venueId: venueId!, orderId, staffId: null })).resolves.toEqual({
      outcome: 'OK',
      status: 'CANCELLED_BY_STAFF',
    })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    expect((await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).status).toBe('CANCELLED_BY_STAFF')
  })

  it('la admisión es serializada: con cupo para UN pedido más del mismo teléfono, de dos simultáneos entra uno (R4)', async () => {
    await beat()
    const phone = nextPhone()
    await newOrder({ phone })
    await newOrder({ phone }) // 2 de 3
    const results = await Promise.allSettled([newOrder({ phone }), newOrder({ phone })])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'TOO_MANY_PENDING_ORDERS' })
  })

  it('el reclamo de impresión lo gana un solo aparato', async () => {
    await beat()
    const { orderId } = await newOrder()
    await aceptar(orderId)
    const [a, b] = await Promise.all([claimOnlineOrderPrint(venueId!, orderId, 'dev-A'), claimOnlineOrderPrint(venueId!, orderId, 'dev-B')])
    expect([a.claimed, b.claimed].sort()).toEqual([false, true])
  })

  it('un reclamo de impresión vencido (más de 90 s) lo toma otro aparato, y sólo el nuevo dueño confirma el papel', async () => {
    await beat()
    const { orderId, onlineOrderId } = await newOrder()
    await aceptar(orderId)
    await expect(claimOnlineOrderPrint(venueId!, orderId, 'dev-A')).resolves.toEqual({ claimed: true })
    // El aparato A se apagó a media impresión: su reclamo envejece más allá del TTL de 90 s.
    await prisma.onlineOrder.update({ where: { id: onlineOrderId }, data: { printClaimedAt: new Date(Date.now() - 91_000) } })
    await expect(claimOnlineOrderPrint(venueId!, orderId, 'dev-B')).resolves.toEqual({ claimed: true })
    await expect(confirmOnlineOrderPrinted(venueId!, orderId, 'dev-A')).resolves.toEqual({ ok: false })
    await expect(confirmOnlineOrderPrinted(venueId!, orderId, 'dev-B')).resolves.toEqual({ ok: true })
    expect(await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).toMatchObject({ printClaimedBy: 'dev-B' })
  })

  it('un reclamo de impresión de 89 s sigue vigente: otro aparato NO lo toma', async () => {
    await beat()
    const { orderId, onlineOrderId } = await newOrder()
    await aceptar(orderId)
    await expect(claimOnlineOrderPrint(venueId!, orderId, 'dev-A')).resolves.toEqual({ claimed: true })
    // Reloj fijo para B: el reclamo de A tiene exactamente 89 s, un segundo antes del TTL de 90 s.
    const ahora = new Date()
    await prisma.onlineOrder.update({ where: { id: onlineOrderId }, data: { printClaimedAt: new Date(ahora.getTime() - 89_000) } })
    await expect(claimOnlineOrderPrint(venueId!, orderId, 'dev-B', ahora)).resolves.toEqual({ claimed: false })
    expect(await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).toMatchObject({ printClaimedBy: 'dev-A' })
  })

  it('H6: un rechazo que llega mientras el cobro real retiene el candado de la orden espera, y al soltarse pierde (HAS_PAYMENTS)', async () => {
    await beat()
    const { orderId, onlineOrderId } = await newOrder()
    let soltar!: () => void
    const retenido = new Promise<void>(resolve => (soltar = resolve))
    let avisarDentro!: () => void
    const cobroDentro = new Promise<void>(resolve => (avisarDentro = resolve))
    let pidDelCobro: number | undefined

    // El cobro toma el candado de la orden, crea su Payment y se queda esperando DENTRO de su transacción, sin commit. Anota
    // el proceso de Postgres de ESA transacción: es el que retiene el candado.
    const cobro = payCashOrder(venueId!, orderId, {
      amount: 20_600,
      tip: 0,
      idempotencyKey: `itest-pay-carrera-${orderId}`,
      dentroDeLaTx: async tx => {
        pidDelCobro = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid
        avisarDentro()
        await retenido
      },
    })
    await Promise.race([cobroDentro, cobro]) // si el cobro lanza antes del gancho, falla aquí en vez de colgarse
    const rechazo = rejectOnlineOrder({ venueId: venueId!, orderId, staffId: null, reason: 'TOO_BUSY' })
    // El cobro se suelta pase lo que pase, y los tres se esperan antes de afirmar: nada queda corriendo ni sin manejar.
    const [espera, pago, rechazado] = await Promise.allSettled([
      esperarQueAlguienEspereAlCobro(pidDelCobro).finally(soltar),
      cobro,
      rechazo,
    ])
    if (espera.status === 'rejected') throw espera.reason // el rechazo nunca quedó formado detrás del cobro
    expect(pago).toMatchObject({ status: 'fulfilled', value: { status: 'COMPLETED' } })
    expect(rechazado).toEqual({ status: 'fulfilled', value: { outcome: 'HAS_PAYMENTS' } })
    // nada incoherente: la venta cobrada sigue cobrada, el pedido sigue por aceptar y hay un solo pago
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED' })
    expect((await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).status).toBe('PENDING_ACCEPTANCE')
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1)
  })

  it('H6: si el CAS del pedido pierde DENTRO de la cancelación existente, Postgres revierte la cancelación de la Order', async () => {
    await beat()
    const { orderId, onlineOrderId } = await newOrder()
    await aceptar(orderId)
    // Otro actor "cambió" el pedido entre la lectura y el CAS: un disparador efímero hace que el UPDATE de ESTE pedido a
    // CANCELLED_BY_STAFF no toque ninguna fila (count 0, igual que un CAS perdido). `orderId` es un cuid que creó esta prueba.
    const sufijo = `${RUN}_${++seq}`
    const fn = `itest_cas_pierde_fn_${sufijo}`
    const tr = `itest_cas_pierde_tr_${sufijo}`
    try {
      // Dentro del `try`: si algo falla a medio crear, el `finally` borra lo que sí se creó.
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $b$ BEGIN IF NEW."orderId" = '${orderId}' AND NEW.status = 'CANCELLED_BY_STAFF' THEN RETURN NULL; END IF; RETURN NEW; END $b$`,
      )
      await prisma.$executeRawUnsafe(`CREATE TRIGGER "${tr}" BEFORE UPDATE ON "OnlineOrder" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`)
      await expect(cancelOnlineOrderByStaff({ venueId: venueId!, orderId, staffId: null })).resolves.toEqual({
        outcome: 'STALE',
        status: 'ACCEPTED',
      })
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${tr}" ON "OnlineOrder"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`)
    }
    // `cancelOrder` ya había escrito CANCELLED en la Order dentro de su transacción; el gancho lanzó y TODO se revirtió.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CONFIRMED')
    expect((await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).status).toBe('ACCEPTED')
  })

  it('I-1: si el POS cancela la cuenta de un pedido ACEPTADO, la bandeja lo cierra y el comensal recibe el aviso UNA sola vez', async () => {
    await beat()
    const { orderId, onlineOrderId } = await newOrder()
    await aceptar(orderId)
    const aviso = jest.spyOn(avisos, 'notifyOrderEvent').mockResolvedValue(undefined)
    try {
      await cancelOrder(venueId!, orderId) // la cancelación existente del POS: no pasa por la máquina de estados
      const cancelados = () => aviso.mock.calls.filter(([id, evento]) => id === orderId && evento === 'CANCELLED')

      await listInbox({ venueId: venueId! })
      expect(await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).toMatchObject({
        status: OnlineOrderStatus.CANCELLED_BY_STAFF,
        cancelledBy: 'ORDER_CANCELLED_ELSEWHERE',
      })
      expect(cancelados()).toHaveLength(1)
      expect(bitacora(onlineOrderId, 'ONLINE_ORDER_CANCELLED_BY_STAFF')).toEqual([
        expect.objectContaining({
          staffId: null,
          venueId,
          entity: 'OnlineOrder',
          data: expect.objectContaining({ cancelledBy: 'ORDER_CANCELLED_ELSEWHERE' }),
        }),
      ])

      await listInbox({ venueId: venueId! }) // la siguiente bandeja ya no lo encuentra abierto: no vuelve a avisar
      expect(cancelados()).toHaveLength(1)
      expect(bitacora(onlineOrderId, 'ONLINE_ORDER_CANCELLED_BY_STAFF')).toHaveLength(1)
    } finally {
      aviso.mockRestore()
    }
  })

  it('opción 1: pagado completo y LISTO ⇒ la bandeja lo entrega sola, con su bitácora automática y sin tocar la cuenta', async () => {
    await beat()
    const { orderId, onlineOrderId } = await pedidoListo()
    await expect(pay(orderId)).resolves.toMatchObject({ status: 'COMPLETED' })
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(cuenta.paymentStatus).toBe('PAID')

    await listInbox({ venueId: venueId! })
    const online = await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })
    expect(online.status).toBe(OnlineOrderStatus.COMPLETED)
    expect(online.completedAt).not.toBeNull()
    expect(bitacora(onlineOrderId, 'ONLINE_ORDER_COLLECTED')).toEqual([
      expect.objectContaining({ staffId: null, venueId, entity: 'OnlineOrder', data: expect.objectContaining({ automatic: true }) }),
    ])
    // La cuenta la cerró el cobro: sigue igual.
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: cuenta.status, paymentStatus: 'PAID' })
  })

  it('opción 1: con un pago PARCIAL el pedido listo NO se entrega solo', async () => {
    await beat()
    const { orderId, onlineOrderId } = await pedidoListo()
    await payCashOrder(venueId!, orderId, { amount: 10_000, tip: 0, idempotencyKey: `itest-pay-parcial-${orderId}` })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PARTIAL')
    await listInbox({ venueId: venueId! })
    expect(await estadoDe(onlineOrderId)).toBe(OnlineOrderStatus.READY)
  })

  it('opción 1: ACEPTADO y pagado ANTES de su hora estimada sigue en preparación; pasada la hora, se entrega solo', async () => {
    await beat()
    const antes = await pedidoListo({ ready: false })
    const despues = await pedidoListo({ ready: false })
    await pay(antes.orderId)
    await pay(despues.orderId)
    await prisma.onlineOrder.update({ where: { id: despues.onlineOrderId }, data: { estimatedReadyAt: new Date(Date.now() - 1_000) } })

    await listInbox({ venueId: venueId! })
    expect(await estadoDe(antes.onlineOrderId)).toBe(OnlineOrderStatus.ACCEPTED)
    expect(await estadoDe(despues.onlineOrderId)).toBe(OnlineOrderStatus.COMPLETED)
  })

  it('opción 1: si la cuenta está cancelada gana R2 (cancelado por el negocio), aunque diga pagada', async () => {
    await beat()
    const { orderId, onlineOrderId } = await pedidoListo()
    await pay(orderId)
    // Estado que ningún flujo de hoy produce (la cancelación existente se niega con dinero): se arma a mano para fijar que el
    // pedido de una cuenta cancelada NUNCA queda «entregado».
    await prisma.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } })
    await listInbox({ venueId: venueId! })
    expect(await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).toMatchObject({
      status: OnlineOrderStatus.CANCELLED_BY_STAFF,
      cancelledBy: 'ORDER_CANCELLED_ELSEWHERE',
      completedAt: null,
    })
  })

  it('M-1: rechazar o vencer un pedido cuya cuenta ya está cerrada sin dinero (cortesía) no responde OK: Postgres revierte el CAS', async () => {
    await beat()
    const { orderId, onlineOrderId } = await newOrder()
    // Una cortesía: la caja cerró la cuenta sin cobrarla. Ni rechazar ni vencer pueden cancelarla.
    await prisma.order.update({ where: { id: orderId }, data: { status: 'COMPLETED' } })
    await expect(rejectOnlineOrder({ venueId: venueId!, orderId, staffId: null, reason: 'TOO_BUSY' })).resolves.toEqual({
      outcome: 'STALE',
      status: OnlineOrderStatus.PENDING_ACCEPTANCE,
    })
    await prisma.onlineOrder.update({ where: { id: onlineOrderId }, data: { acceptDeadlineAt: new Date(Date.now() - 1_000) } })
    await expect(expireOnlineOrder({ venueId: venueId!, orderId })).resolves.toEqual({
      outcome: 'STALE',
      status: OnlineOrderStatus.PENDING_ACCEPTANCE,
    })
    expect(await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).toMatchObject({
      status: OnlineOrderStatus.PENDING_ACCEPTANCE,
      rejectedAt: null,
      expiredAt: null,
    })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('COMPLETED')
  })

  it('A3: una cuenta pagada que tiene un reembolso registrado NO se entrega sola; queda para que una persona decida', async () => {
    await beat()
    const { orderId, onlineOrderId } = await pedidoListo()
    await pay(orderId)
    // Así queda un reembolso en la casa: un `Payment` REFUND de la cuenta, y la cuenta sigue diciendo PAID.
    await prisma.payment.create({
      data: {
        venueId: venueId!,
        orderId,
        amount: -206,
        method: 'CASH',
        status: 'COMPLETED',
        type: 'REFUND',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -206,
      },
    })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PAID')

    await listInbox({ venueId: venueId! })
    expect(await estadoDe(onlineOrderId)).toBe(OnlineOrderStatus.READY)
    expect(bitacora(onlineOrderId, 'ONLINE_ORDER_COLLECTED')).toHaveLength(0)
  })

  it('A14: dos bandejas A LA VEZ sobre un pedido cuya cuenta se canceló ⇒ un solo aviso al comensal y una sola bitácora', async () => {
    await beat()
    const { orderId, onlineOrderId } = await newOrder()
    await aceptar(orderId)
    const aviso = jest.spyOn(avisos, 'notifyOrderEvent').mockResolvedValue(undefined)
    try {
      await cancelOrder(venueId!, orderId)
      await Promise.all([listInbox({ venueId: venueId! }), listInbox({ venueId: venueId! })])
      expect(await estadoDe(onlineOrderId)).toBe(OnlineOrderStatus.CANCELLED_BY_STAFF)
      expect(aviso.mock.calls.filter(([id, evento]) => id === orderId && evento === 'CANCELLED')).toHaveLength(1)
      expect(bitacora(onlineOrderId, 'ONLINE_ORDER_CANCELLED_BY_STAFF')).toHaveLength(1)
    } finally {
      aviso.mockRestore()
    }
  })

  it('A14 y A12: dos bandejas A LA VEZ sobre un pedido pagado y listo ⇒ un solo ONLINE_ORDER_COLLECTED; «entregado» después es éxito sin escribir', async () => {
    await beat()
    const { orderId, onlineOrderId } = await pedidoListo()
    await pay(orderId)
    await Promise.all([listInbox({ venueId: venueId! }), listInbox({ venueId: venueId! })])
    expect(await estadoDe(onlineOrderId)).toBe(OnlineOrderStatus.COMPLETED)
    expect(bitacora(onlineOrderId, 'ONLINE_ORDER_COLLECTED')).toHaveLength(1)

    const antes = await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })
    await expect(markOnlineOrderDelivered({ venueId: venueId!, orderId, staffId: null })).resolves.toMatchObject({
      outcome: 'OK',
      status: OnlineOrderStatus.COMPLETED,
    })
    expect(await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).toEqual(antes)
    expect(bitacora(onlineOrderId, 'ONLINE_ORDER_COLLECTED')).toHaveLength(1)
  })

  it('A6: dos ajustes simultáneos (encender + quitar pagar al recoger) se serializan: el segundo ve al primero y uno se rechaza', async () => {
    try {
      for (let ronda = 0; ronda < 5; ronda++) {
        await updateSettings(venueId!, { enabled: false, acceptsPayAtPickup: true }, null)
        const r = await Promise.allSettled([
          updateSettings(venueId!, { enabled: true }, null),
          updateSettings(venueId!, { acceptsPayAtPickup: false }, null),
        ])
        expect(r.filter(x => x.status === 'rejected')).toEqual([
          expect.objectContaining({ reason: expect.objectContaining({ code: 'NO_PAYMENT_MODE' }) }),
        ])
        const fila = await prisma.onlineOrderingSettings.findUniqueOrThrow({ where: { venueId: venueId! } })
        // Nunca encendida sin medio de pago.
        expect(fila.enabled && !fila.acceptsPayAtPickup).toBe(false)
      }
    } finally {
      await updateSettings(venueId!, { enabled: true, acceptsPayAtPickup: true }, null)
    }
  })
})
