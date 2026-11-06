// tests/integration/online-ordering/folios.integration.test.ts
/**
 * Integration (REAL DB) — tienda híbrida T9 (decisión 18): pagado ⇒ «Por entregar», en un solo lugar, también con dinero tardío.
 *
 * R14: cada camino de dinero corre de verdad contra Postgres (cobro de la TPV, del POS, pago manual del panel, «Liquidar saldo»,
 * reembolso, la cola sin red, la tarjeta tardía, la ligada declarada «No se cobró», «Editar» del panel, el abono y el resto). Al final
 * de cada uno el folio queda `ACCEPTED` («Por entregar»), nunca `COMPLETED`, y la cocina tiene UNA comanda como mucho: la del cobro
 * que salda (decisión 19), nunca la del dinero que reabre. Las carreras (la bandeja contra el dinero tardío; el aparato contra la
 * sincronización) corren con candados reales.
 *
 * Los armados de comanda «después del commit» están simulados (correrían sueltos); `comandas()` hace lo que haría el barrido con la
 * marca `kitchenPendingAt` que dejó cada paso, con el armado real, y cuenta las comandas de la cuenta.
 */
import { randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { settleCustomerBalance } from '@/services/dashboard/customer.dashboard.service'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'
import { updateOrder } from '@/services/dashboard/order.dashboard.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { authorKitchenTickets } from '@/services/kds/kitchenTicketAuthoring.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { cerrarCanceladasReleyendo } from '@/services/online-ordering/cancelledOrderSync'
import {
  cerrarFoliosDelDiaTerminado,
  leerFoliosConAbonoDevuelto,
  leerPedidosVencidos,
  listFolios,
  syncPaidFolios,
  type CursorDeVencer,
} from '@/services/online-ordering/folios.service'
import { listInbox } from '@/services/online-ordering/inbox.service'
import {
  acceptOnlineOrder,
  markOnlineOrderDelivered,
  cancelOnlineOrderByStaff,
  expireOnlineOrder,
  rejectOnlineOrder,
} from '@/services/online-ordering/transitions.service'
import { reabrirSiRecibeDinero } from '@/services/shared/cuentaCancelada'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { OnlineOrderAcceptanceExpiryJob } from '@/jobs/online-order-acceptance-expiry.job'
import { crearFixture, exigir, exigirBaseDesechable, type Fixture } from '../payments/webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn(), broadcastToUser: jest.fn() },
}))
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/online-ordering/notifications.service', () => ({ notifyOrderEvent: jest.fn(async () => undefined) }))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(async () => undefined),
}))

let f: Fixture
let productId: string
let seq = 0

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('t9folios')
  // Un negocio con pantalla de cocina: así cada cobro que salda (y `prepararFolioPagado`) marca la cocina, y se puede contar.
  await prisma.printStation.create({
    data: {
      venueId: f.venueId,
      name: 'Cocina',
      isDefault: true,
      hasKitchenDisplay: true,
      kitchenDisplaySince: new Date(Date.now() - 24 * 3_600_000),
    },
  })
  // Un renglón sin producto es importe libre y no va a la cocina (`planKitchenTickets`): el folio vende un producto del catálogo.
  const categoria = await prisma.menuCategory.create({ data: { venueId: f.venueId, name: 'Antojitos', slug: `antojitos-${f.fixture}` } })
  productId = (
    await prisma.product.create({
      data: { venueId: f.venueId, name: 'Flautas', sku: `FLA-${f.fixture}`, price: 100, categoryId: categoria.id, availableOnline: true },
    })
  ).id
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(async () => {
  const programadas = (terminalPaymentService as any).ventanasProgramadas as Map<string, NodeJS.Timeout> | undefined
  for (const t of programadas?.values() ?? []) clearTimeout(t)
  programadas?.clear()
  await prisma.kdsOrderItem.deleteMany({ where: { kdsOrder: { venueId: f.venueId } } })
  await prisma.kdsOrder.deleteMany({ where: { venueId: f.venueId } })
  await prisma.paymentEffect.deleteMany({ where: { venueId: f.venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await prisma.notification.deleteMany({ where: { venueId: f.venueId } })
  await prisma.posSyncIntent.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
  await prisma.customer.deleteMany({ where: { venueId: f.venueId } })
})
afterAll(async () => {
  if (!f) return
  await prisma.onlineOrderingSettings.deleteMany({ where: { venueId: f.venueId } })
  await prisma.printStation.deleteMany({ where: { venueId: f.venueId } })
  await prisma.product.deleteMany({ where: { venueId: f.venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId: f.venueId } })
  await f.destruir()
})

const CIEN = 10_000 // $100.00 en centavos (la cuenta de cada folio)
const CINCUENTA = 5_000

/** Un folio de «Nadie» (o un pedido de «Mi equipo»), con la forma de `writeOnlineOrderInTx`: cuenta WEB de $100 y un renglón. */
async function nuevoFolio(o: { equipo?: boolean; vencido?: boolean } = {}) {
  const orden = await prisma.order.create({
    data: {
      venueId: f.venueId,
      orderNumber: `F-${randomUUID().slice(0, 8)}`,
      type: 'PICKUP',
      source: 'WEB',
      originSystem: 'AVOQADO',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: 100,
      discountAmount: 0,
      taxAmount: 0,
      tipAmount: 0,
      total: 100,
      paidAmount: 0,
      remainingBalance: 100,
      customerName: 'Ana ITEST',
      items: {
        create: [
          { productId, productName: 'Flautas', quantity: 1, unitPrice: 100, discountAmount: 0, taxAmount: 0, total: 100, sequence: 0 },
        ],
      },
    },
  })
  const pedido = await prisma.onlineOrder.create({
    data: {
      orderId: orden.id,
      venueId: f.venueId,
      status: 'PENDING_ACCEPTANCE',
      paymentMode: 'PAY_AT_PICKUP',
      trackingToken: `${randomUUID()}${randomUUID()}`.replace(/-/g, ''),
      acceptDeadlineAt: o.vencido ? new Date(Date.now() - 60_000) : new Date(Date.now() + 30 * 60_000),
      requiresAcceptance: o.equipo === true,
      channel: o.equipo ? null : 'QR',
    },
  })
  return { orderId: orden.id, onlineOrderId: pedido.id }
}

const pedido = (onlineOrderId: string) => exigir(prisma.onlineOrder.findUnique({ where: { id: onlineOrderId } }))
const cuenta = (orderId: string) => exigir(prisma.order.findUnique({ where: { id: orderId } }))
/** Lo que corre la Bandeja antes de leer: R2 releyendo bajo candado, pagado al recoger, folios pagados y cerrados ya saldados. */
const pasada = () => listInbox({ venueId: f.venueId })

/** El barrido de comandas: arma lo que quedó marcado (con el armado real) y cuenta las comandas de la cuenta. */
async function comandas(orderId: string): Promise<number> {
  for (let i = 0; i < 3; i++) {
    const marca = await prisma.order.findUnique({ where: { id: orderId }, select: { kitchenPendingAt: true } })
    if (!marca?.kitchenPendingAt) break
    await authorKitchenTickets({ venueId: f.venueId, orderId, trigger: 'SWEEP' })
  }
  return prisma.kdsOrder.count({ where: { venueId: f.venueId, orderId } })
}

/** «Por entregar»: ACCEPTED con su hora; nunca Entregado. */
async function porEntregar(onlineOrderId: string) {
  const p = await pedido(onlineOrderId)
  expect(p.status).toBe('ACCEPTED')
  expect(p.acceptedAt).not.toBeNull()
  expect(p.completedAt).toBeNull()
}

const vencer = async (orderId: string) =>
  expect(await expireOnlineOrder({ venueId: f.venueId, orderId })).toMatchObject({ outcome: 'OK', status: 'EXPIRED' })

const efectivoDelPos = (orderId: string, centavos = CIEN) =>
  payCashOrder(f.venueId, orderId, { amount: centavos, tip: 0, staffId: f.staffId, idempotencyKey: randomUUID() })

/** La cola sin red del POS: efectivo YA cobrado que llega tarde (nunca se rechaza). */
async function colaSinRed(orderId: string, centavos = CIEN) {
  const [ack] = await processIntents({
    venueId: f.venueId,
    staffId: f.staffId,
    deviceId: `aparato-${f.fixture}`,
    intents: [{ id: randomUUID(), seq: ++seq, type: 'PAY_CASH', payload: { orderId, amountCents: centavos, tipCents: 0, method: 'CASH' } }],
    authorizeIntent: () => true,
  })
  expect(ack).toMatchObject({ status: 'ACKED' })
}

/** El cobro con tarjeta que la TPV hizo por su cuenta (el servidor no lo vio empezar). */
const tarjetaDeLaTpv = (orderId: string, centavos = CIEN, extra: { requestId?: string; attemptId?: string } = {}) =>
  recordOrderPayment(
    f.venueId,
    orderId,
    f.registroDeLaTerminal({ attemptId: extra.attemptId ?? randomUUID(), amount: centavos, requestId: extra.requestId }),
    f.staffId,
  )

const efectivoDeLaTpv = (orderId: string, centavos: number) =>
  recordOrderPayment(
    f.venueId,
    orderId,
    {
      ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinMerchant: true, amount: centavos }),
      method: 'CASH',
      authorizationNumber: undefined,
    },
    f.staffId,
  )

/** Espera a que alguna sesión quede bloqueada por el proceso `pid` (la carrera es real, no secuencial). Acotada: si no, INCONCLUSO. */
async function esperarBloqueadoPor(pid: number, queNoPaso: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [bloqueado] = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND ${pid}::int = ANY(pg_blocking_pids(pid))`
    if (bloqueado) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`INCONCLUSO: ${queNoPaso}`)
}

const aceptadosEnBitacora = (onlineOrderId: string) =>
  (logAction as jest.Mock).mock.calls.map(([p]) => p).filter(p => p.entityId === onlineOrderId && p.action === 'ONLINE_ORDER_ACCEPTED')

describe('T9 · por cada camino de dinero el folio queda «Por entregar» con UNA comanda', () => {
  it('cobro de la TPV: la cuenta ya COMPLETED y con su cocina marcada; la pasada no la reabre ni saca otra comanda', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()

    await tarjetaDeLaTpv(orderId)
    expect(await cuenta(orderId)).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED' })
    expect(await comandas(orderId)).toBe(1) // la del cobro

    await pasada()

    await porEntregar(onlineOrderId)
    expect((await cuenta(orderId)).status).toBe('COMPLETED')
    expect(await comandas(orderId)).toBe(1)
    expect(aceptadosEnBitacora(onlineOrderId)).toHaveLength(1)
  })

  it('cobro del POS (efectivo con red)', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()

    await efectivoDelPos(orderId)
    await pasada()

    await porEntregar(onlineOrderId)
    expect(await comandas(orderId)).toBe(1)
  })

  it('pago manual del panel', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()

    const pago = await createManualPayment(f.venueId, f.staffId, {
      orderId,
      amount: '100.00',
      tipAmount: '0',
      method: 'CASH',
      source: 'OTHER',
    } as any)
    expect(pago.status).toBe('COMPLETED')
    await pasada()

    await porEntregar(onlineOrderId)
    expect(await comandas(orderId)).toBe(1)
  })

  it('«Liquidar saldo» de Clientes: la cuenta pagada pasa de PENDING a CONFIRMED (no queda escondida) y el folio a «Por entregar»', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    const cliente = await prisma.customer.create({
      data: { venueId: f.venueId, firstName: 'Fiado', phone: `+5255${Date.now() % 100_000_000}` },
    })
    await prisma.orderCustomer.create({ data: { orderId, customerId: cliente.id, isPrimary: true } })

    const r = await settleCustomerBalance(f.venueId, cliente.id, undefined, f.staffId)
    expect(r.settledOrderCount).toBe(1)
    expect(await cuenta(orderId)).toMatchObject({ paymentStatus: 'PAID', status: 'PENDING' })

    await pasada()

    await porEntregar(onlineOrderId)
    expect((await cuenta(orderId)).status).toBe('CONFIRMED')
    expect(await comandas(orderId)).toBe(1)
  })

  it('R5: pagado y luego reembolsado completo (la forma real: cuenta PAID con un Payment REFUND) también pasa a «Por entregar»', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    await prisma.shift.create({ data: { venueId: f.venueId, staffId: f.staffId, startTime: new Date(), status: 'OPEN', startingCash: 0 } })
    const cobro = await efectivoDelPos(orderId)

    await issueRefund({ venueId: f.venueId, paymentId: cobro.paymentId, amount: CIEN, reason: 'RETURNED_GOODS', staffId: f.staffId })
    const reembolsos = await prisma.payment.count({ where: { venueId: f.venueId, orderId, type: 'REFUND' } })
    expect(reembolsos).toBe(1)
    expect(['PAID', 'REFUNDED']).toContain((await cuenta(orderId)).paymentStatus)
    expect((await pedido(onlineOrderId)).status).toBe('PENDING_ACCEPTANCE')

    await pasada()

    await porEntregar(onlineOrderId)
  })
})

describe('T9 · dinero tardío sobre un folio cerrado: «Por entregar», nunca «Entregado»', () => {
  it('efectivo de la cola sin red que SALDA un folio vencido ⇒ ACCEPTED en la MISMA transacción del dinero, sin comanda de cocina', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio({ vencido: true })
    await vencer(orderId)

    await colaSinRed(orderId)

    // Sin ninguna pasada de por medio: lo hizo la conciliación, con el dinero.
    await porEntregar(onlineOrderId)
    expect(await cuenta(orderId)).toMatchObject({ paymentStatus: 'PAID' })
    expect(await comandas(orderId)).toBe(0)
  })

  it('tarjeta de la TPV aprobada después de vencer ⇒ lo mismo', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio({ vencido: true })
    await vencer(orderId)

    await tarjetaDeLaTpv(orderId)

    await porEntregar(onlineOrderId)
    expect(await comandas(orderId)).toBe(0)
    await pasada()
    await porEntregar(onlineOrderId) // ni la bandeja lo vuelve a cerrar
  })

  it('tarjeta ligada declarada «No se cobró» y aprobada después de vencer ⇒ lo mismo', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio({ vencido: true })
    // El cajero declaró «no se presentó tarjeta»: la solicitud ya no retiene la cuenta (`OPERATOR_RECONCILED_NO_CHARGE`).
    const solicitud = await f.solicitud({
      orderId,
      status: 'FAILED',
      failureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
      expiresAt: new Date(Date.now() - 60_000),
    })
    const attemptId = randomUUID()
    await prisma.terminalPaymentAttemptLink.create({
      data: { attemptId, requestId: solicitud.requestId, venueId: f.venueId, terminalId: f.llaveTerminal },
    })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, orderId)).toBe(false)
    await vencer(orderId)

    // El banco sí aprobó: la terminal registra el cobro ligado, tarde.
    const pago = await tarjetaDeLaTpv(orderId, CIEN, { attemptId, requestId: solicitud.requestId })

    expect(await exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId: solicitud.requestId } }))).toMatchObject({
      status: 'COMPLETED',
      paymentId: pago.id,
    })
    await porEntregar(onlineOrderId)
    expect(await comandas(orderId)).toBe(0)
  })

  it('codex-plan-r4: «Editar» del panel cancela la cuenta con el folio todavía por pagar; el cobro propio de la TPV aprueba el total ⇒ ACCEPTED', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    await updateOrder(f.venueId, orderId, { status: 'CANCELLED' } as any, { staffId: f.staffId })
    expect((await cuenta(orderId)).status).toBe('CANCELLED')
    expect((await pedido(onlineOrderId)).status).toBe('PENDING_ACCEPTANCE') // nadie leyó la bandeja

    await tarjetaDeLaTpv(orderId)

    await porEntregar(onlineOrderId)
    await pasada()
    await porEntregar(onlineOrderId)
    expect(await comandas(orderId)).toBe(0)
  })

  it('codex-plan-r6 #1: abono tardío y el resto cobrado desde las cuentas abiertas por el POS ⇒ `syncPaidClosedFolios` lo pasa a «Por entregar», con UNA comanda como mucho', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio({ vencido: true })
    await vencer(orderId)

    await colaSinRed(orderId, CINCUENTA)
    expect((await pedido(onlineOrderId)).status).toBe('EXPIRED') // sólo abona: sigue cerrado
    expect(await cuenta(orderId)).toMatchObject({ status: 'PENDING', paymentStatus: 'PARTIAL' })
    expect(await comandas(orderId)).toBe(0) // el que reabrió no marca

    await efectivoDelPos(orderId, CINCUENTA)
    expect((await pedido(onlineOrderId)).status).toBe('EXPIRED')

    await pasada()

    await porEntregar(onlineOrderId)
    expect(await comandas(orderId)).toBeLessThanOrEqual(1) // la del cobro que saldó (decisión 19)
    expect(aceptadosEnBitacora(onlineOrderId)).toEqual([
      expect.objectContaining({ staffId: null, data: expect.objectContaining({ from: 'EXPIRED' }) }),
    ])
  })

  it('lo mismo con el resto cobrado por la TPV', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio({ vencido: true })
    await vencer(orderId)
    await colaSinRed(orderId, CINCUENTA)

    await efectivoDeLaTpv(orderId, CINCUENTA)
    expect((await cuenta(orderId)).paymentStatus).toBe('PAID')
    await pasada()

    await porEntregar(onlineOrderId)
    expect(await comandas(orderId)).toBeLessThanOrEqual(1)
  })

  it('lo mismo con un folio REJECTED (R46: un folio ya no se rechaza; el estado queda sólo por datos que lo traigan)', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    // R46: lo que dejaba el rechazo se escribe directo: el folio REJECTED y su cuenta CANCELLED.
    await prisma.onlineOrder.update({
      where: { id: onlineOrderId },
      data: { status: 'REJECTED', rejectedAt: new Date(), rejectReason: 'OTHER' },
    })
    await prisma.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } })
    await colaSinRed(orderId, CINCUENTA)
    expect((await pedido(onlineOrderId)).status).toBe('REJECTED')

    await efectivoDelPos(orderId, CINCUENTA)
    await pasada()

    await porEntregar(onlineOrderId)
    expect(await comandas(orderId)).toBeLessThanOrEqual(1)
  })

  it('«Mi equipo» en esos casos sigue como hoy: saldado tarde ⇒ COMPLETED; con abono y el resto aparte ⇒ sigue cerrado', async () => {
    const saldado = await nuevoFolio({ equipo: true, vencido: true })
    await vencer(saldado.orderId)
    await colaSinRed(saldado.orderId)
    expect((await pedido(saldado.onlineOrderId)).status).toBe('COMPLETED')

    const abonado = await nuevoFolio({ equipo: true, vencido: true })
    await vencer(abonado.orderId)
    await colaSinRed(abonado.orderId, CINCUENTA)
    await efectivoDelPos(abonado.orderId, CINCUENTA)
    await pasada()
    expect((await pedido(abonado.onlineOrderId)).status).toBe('EXPIRED')
  })
})

describe('R44 · folio con su abono reembolsado completo (cuenta PARTIAL, dinero neto 0)', () => {
  /** El trabajo de cada 30 s, con sus dependencias reales (sin cron). */
  const pasarElTrabajo = () => new OnlineOrderAcceptanceExpiryJob({ cron: { start: jest.fn(), stop: jest.fn() } as never }).checkNow()
  const porPagar = async () => (await listFolios({ venueId: f.venueId })).toPay.map(o => o.orderId)
  const vencerPlazo = (onlineOrderId: string) =>
    prisma.onlineOrder.update({ where: { id: onlineOrderId }, data: { acceptDeadlineAt: new Date(Date.now() - 60_000) } })

  it('abono de $50 de $100 y reembolso REAL de $50 ⇒ pasado el plazo el trabajo lo vence; la cuenta queda intacta (PARTIAL, sin cancelar) y sale de «Por pagar»; si después llega dinero, revive', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    // El reembolso en efectivo sale del cajón: pide un turno abierto.
    await prisma.shift.create({ data: { venueId: f.venueId, staffId: f.staffId, startTime: new Date(), status: 'OPEN', startingCash: 0 } })
    const abono = await efectivoDelPos(orderId, CINCUENTA)
    await issueRefund({ venueId: f.venueId, paymentId: abono.paymentId, amount: CINCUENTA, reason: 'RETURNED_GOODS', staffId: f.staffId })
    expect(await prisma.payment.count({ where: { orderId, type: 'REFUND', status: 'COMPLETED' } })).toBe(1)
    const antes = await cuenta(orderId)
    expect(antes).toMatchObject({ status: 'PENDING', paymentStatus: 'PARTIAL' }) // el reembolso no la recalcula (deuda ajena)
    expect(await porPagar()).toContain(orderId) // dentro del plazo sigue «Por pagar»

    await vencerPlazo(onlineOrderId)
    await pasarElTrabajo()

    expect((await pedido(onlineOrderId)).status).toBe('EXPIRED')
    const despues = await cuenta(orderId)
    expect(despues).toMatchObject({ status: 'PENDING', paymentStatus: 'PARTIAL' }) // ni cancelada ni tocada
    expect(despues.paidAmount.toString()).toBe(antes.paidAmount.toString())
    expect(await porPagar()).not.toContain(orderId)

    // Llega dinero después: el cobro salda la cuenta y la pasada lo revive a «Por entregar» (`syncPaidClosedFolios`), como hoy.
    await efectivoDelPos(orderId, CINCUENTA)
    expect((await cuenta(orderId)).paymentStatus).toBe('PAID')
    await pasada()
    await porEntregar(onlineOrderId)
  })

  it('control (R18): un abono SIN reembolso no vence aunque pase el plazo, y sigue en «Por pagar»', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    await efectivoDelPos(orderId, CINCUENTA)
    await vencerPlazo(onlineOrderId)

    await pasarElTrabajo()

    expect((await pedido(onlineOrderId)).status).toBe('PENDING_ACCEPTANCE')
    expect(await cuenta(orderId)).toMatchObject({ status: 'PENDING', paymentStatus: 'PARTIAL' })
    expect(await porPagar()).toContain(orderId)
  })
})

describe('R50 · las lecturas de vencer excluyen EN SU SQL la cuenta con un cobro de terminal sin desenlace (contra Postgres)', () => {
  // El cobro «de otro negocio» no cuelga de la fixture (sin llave foránea): se borra aquí.
  afterEach(() => prisma.terminalPaymentRequest.deleteMany({ where: { venueId: `${f.venueId}-otro` } }))

  /** Todas las páginas de una lectura, con su cursor, y sólo lo de este negocio (la base desechable la comparten otras suites). */
  async function leidos(leer: typeof leerPedidosVencidos, now = new Date()) {
    const filas: Array<{ id: string; orderId: string; acceptDeadlineAt: Date }> = []
    let despues: CursorDeVencer | null = null
    for (let pagina = 0; pagina < 50; pagina++) {
      const lote = await leer(now, despues)
      filas.push(...lote.filter(r => r.venueId === f.venueId))
      if (lote.length < 100) break
      const ultimo = lote[lote.length - 1]
      despues = { at: ultimo.acceptDeadlineAt, id: ultimo.id }
    }
    return filas
  }
  const cobroDeTerminal = (orderId: string, extra: Partial<Prisma.TerminalPaymentRequestUncheckedCreateInput> = {}) =>
    prisma.terminalPaymentRequest.create({
      data: {
        requestId: randomUUID(),
        venueId: f.venueId,
        terminalId: `r50-${randomUUID().slice(0, 8)}`,
        status: 'TIMED_OUT',
        amountCents: CIEN,
        orderId,
        expiresAt: new Date(Date.now() - 60_000),
        ...extra,
      },
    })
  const abonoDevuelto = async () => {
    const folio = await nuevoFolio()
    const abono = await efectivoDelPos(folio.orderId, CINCUENTA)
    await issueRefund({ venueId: f.venueId, paymentId: abono.paymentId, amount: CINCUENTA, reason: 'RETURNED_GOODS', staffId: f.staffId })
    await prisma.onlineOrder.update({ where: { id: folio.onlineOrderId }, data: { acceptDeadlineAt: new Date(Date.now() - 60_000) } })
    return folio
  }

  it('vencer principal: el cobro TIMED_OUT (incierto) saca de la lectura a su folio; el acreditado como «no se cobró» y el que no tiene cobro sí salen, también de «Mi equipo»', async () => {
    const incierto = await nuevoFolio({ vencido: true })
    await cobroDeTerminal(incierto.orderId)
    const acreditado = await nuevoFolio({ vencido: true })
    await cobroDeTerminal(acreditado.orderId, { status: 'FAILED', failureCode: 'TPV_NEVER_RECEIVED' })
    const equipo = await nuevoFolio({ vencido: true, equipo: true })
    // Otro negocio con el mismo número de orden no cuenta: la guarda pregunta por el negocio de la orden.
    const otroNegocio = await nuevoFolio({ vencido: true })
    await cobroDeTerminal(otroNegocio.orderId, { venueId: `${f.venueId}-otro` })

    const ids = (await leidos(leerPedidosVencidos)).map(r => r.orderId)

    expect(ids).toEqual(expect.arrayContaining([acreditado.orderId, equipo.orderId, otroNegocio.orderId]))
    expect(ids).not.toContain(incierto.orderId)
    // La guarda real del vencimiento dice lo mismo que el SQL.
    expect(await expireOnlineOrder({ venueId: f.venueId, orderId: incierto.orderId })).toEqual({ outcome: 'HAS_PAYMENTS' })
    await vencer(acreditado.orderId)
  })

  it('abono devuelto (neto 0): el cobro incierto lo saca de la lectura; sin cobro sale; la guarda real coincide', async () => {
    await prisma.shift.create({ data: { venueId: f.venueId, staffId: f.staffId, startTime: new Date(), status: 'OPEN', startingCash: 0 } })
    const incierto = await abonoDevuelto()
    await cobroDeTerminal(incierto.orderId, { status: 'UNKNOWN' })
    const libre = await abonoDevuelto()

    const ids = (await leidos(leerFoliosConAbonoDevuelto)).map(r => r.orderId)

    expect(ids).toContain(libre.orderId)
    expect(ids).not.toContain(incierto.orderId)
    expect(await expireOnlineOrder({ venueId: f.venueId, orderId: incierto.orderId })).toEqual({ outcome: 'HAS_PAYMENTS' })
    await vencer(libre.orderId)
  })

  it('el cursor sigue DESPUÉS de la fila dada (la fecha va y vuelve exacta por `utcTs`)', async () => {
    const a = await nuevoFolio({ vencido: true })
    const b = await nuevoFolio({ vencido: true })
    await prisma.onlineOrder.update({ where: { id: b.onlineOrderId }, data: { acceptDeadlineAt: new Date(Date.now() - 30_000) } })
    const propios = await leidos(leerPedidosVencidos)
    const primero = propios.find(r => r.orderId === a.orderId)!
    expect(primero.acceptDeadlineAt.getTime()).toBe((await pedido(a.onlineOrderId)).acceptDeadlineAt.getTime())

    const despues = (await leerPedidosVencidos(new Date(), { at: primero.acceptDeadlineAt, id: primero.id })).map(r => r.orderId)

    expect(despues).not.toContain(a.orderId)
    expect(despues).toContain(b.orderId)
  })
})

describe('T9 · carreras con candados reales', () => {
  it('r3/r4: la Bandeja lee el folio abierto con la cuenta CANCELLED; antes de su CAS el dinero tardío reabre la cuenta y lo pasa a ACCEPTED; la sincronización relee bajo el candado y no lo cancela', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    await updateOrder(f.venueId, orderId, { status: 'CANCELLED' } as any, { staffId: f.staffId })

    let pidDelDinero = 0
    let avisar!: () => void
    const candadoTomado = new Promise<void>(resolve => (avisar = resolve))
    let soltar!: () => void
    const sigue = new Promise<void>(resolve => (soltar = resolve))
    // El cobro capturado (la cola sin red, la tarjeta) toma el candado de la orden y, con él, reabre la cuenta y concilia el folio:
    // es `reabrirSiRecibeDinero` real, el mismo que corre dentro de cada camino de dinero.
    const dinero = prisma.$transaction(
      async tx => {
        expect(await lockExistingOrderForPayment(tx, { venueId: f.venueId, orderId })).toBe(true)
        pidDelDinero = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid
        avisar()
        await sigue
        await reabrirSiRecibeDinero(tx, {
          venueId: f.venueId,
          orderId,
          status: 'CANCELLED',
          originSystem: 'AVOQADO',
          cobrado: 100,
          cubreComoCancelada: true,
          canal: 'itest:carrera-r3r4',
          staffId: f.staffId,
        })
      },
      { timeout: 20_000, maxWait: 5_000 },
    )
    await candadoTomado

    const bandeja = cerrarCanceladasReleyendo({ venueId: f.venueId }, new Date())
    await esperarBloqueadoPor(pidDelDinero, 'la sincronización nunca esperó el candado que retiene el cobro')
    soltar()
    await dinero

    expect(await bandeja).toEqual([])
    await porEntregar(onlineOrderId)
  })

  it('el aparato que acepta y la sincronización compiten por el mismo CAS: gana uno; el otro queda STALE sin efecto', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    await efectivoDelPos(orderId)

    const [aparato, sincronizados] = await Promise.all([
      acceptOnlineOrder({ venueId: f.venueId, orderId, staffId: f.staffId }),
      syncPaidFolios({ venueId: f.venueId }, new Date()),
    ])

    expect((aparato.outcome === 'OK' ? 1 : 0) + sincronizados).toBe(1)
    if (aparato.outcome !== 'OK') expect(aparato).toEqual({ outcome: 'STALE', status: 'ACCEPTED' })
    await porEntregar(onlineOrderId)
    expect(aceptadosEnBitacora(onlineOrderId)).toHaveLength(1)
    expect(await comandas(orderId)).toBe(1)
  })
})

describe('T9 · el cierre automático de pagar al recoger no toca folios', () => {
  it('un folio ACCEPTED, pagado e impreso, con su hora cumplida, NO se entrega solo; un pedido de «Mi equipo» igual sí, como hoy', async () => {
    const pasadaLaHora = {
      printClaimedAt: new Date(Date.now() - 120_000),
      printedAt: new Date(Date.now() - 90_000),
      estimatedReadyAt: new Date(Date.now() - 60_000),
    }

    const folio = await nuevoFolio()
    await efectivoDelPos(folio.orderId)
    await pasada()
    await porEntregar(folio.onlineOrderId)
    await prisma.onlineOrder.update({ where: { id: folio.onlineOrderId }, data: pasadaLaHora })

    const equipo = await nuevoFolio({ equipo: true })
    expect(await acceptOnlineOrder({ venueId: f.venueId, orderId: equipo.orderId, staffId: f.staffId })).toMatchObject({ outcome: 'OK' })
    await efectivoDelPos(equipo.orderId)
    await prisma.onlineOrder.update({ where: { id: equipo.onlineOrderId }, data: pasadaLaHora })

    await pasada()

    await porEntregar(folio.onlineOrderId)
    expect((await pedido(equipo.onlineOrderId)).status).toBe('COMPLETED')
  })
})

const entregarPorPersona = (orderId: string) => markOnlineOrderDelivered({ venueId: f.venueId, orderId, staffId: f.staffId })

describe('T9b · «Entregado» sólo por una persona o al terminar el día del negocio (corte de las 04:00, zona del negocio)', () => {
  // México no tiene horario de verano desde 2022: en noviembre la hora local es UTC-6.
  const Z = (iso: string) => new Date(`${iso}-06:00`)
  const poner = (timezone: string) => prisma.venue.update({ where: { id: f.venueId }, data: { timezone } })

  /** Un folio ya en «Por entregar» desde `aceptado` (la hora local del negocio). */
  async function porEntregarDesde(aceptado: Date, o: { estado?: 'ACCEPTED' | 'READY'; equipo?: boolean; creado?: Date } = {}) {
    const x = await nuevoFolio({ equipo: o.equipo })
    await prisma.onlineOrder.update({
      where: { id: x.onlineOrderId },
      data: { status: o.estado ?? 'ACCEPTED', acceptedAt: aceptado, ...(o.creado ? { createdAt: o.creado } : {}) },
    })
    return x
  }
  const cierra = async (hora: Date) => cerrarFoliosDelDiaTerminado({ venueId: f.venueId }, hora)
  const estado = async (id: string) => (await pedido(id)).status

  it('aceptado a las 23:50 sigue en la lista a las 03:59 y sale a las 04:00 (zona del negocio)', async () => {
    await poner('America/Mexico_City')
    const x = await porEntregarDesde(Z('2026-11-05T23:50:00'))
    expect(await cierra(Z('2026-11-06T00:30:00'))).toBe(0)
    expect(await cierra(Z('2026-11-06T03:59:00'))).toBe(0)
    expect(await estado(x.onlineOrderId)).toBe('ACCEPTED')
    expect(await cierra(Z('2026-11-06T04:00:00'))).toBe(1)
    const p = await pedido(x.onlineOrderId)
    expect(p.status).toBe('COMPLETED')
    expect(p.completedAt).toEqual(Z('2026-11-06T04:00:00'))
    expect(await cierra(Z('2026-11-06T04:01:00'))).toBe(0) // ya no es candidato
  })

  it('un folio que el dinero tardío pasó a la lista hoy a las 09:00, aunque se creó ayer, sale hasta mañana a las 04:00', async () => {
    await poner('America/Mexico_City')
    const x = await porEntregarDesde(Z('2026-11-06T09:00:00'), { creado: Z('2026-11-05T12:00:00') })
    expect(await cierra(Z('2026-11-06T20:00:00'))).toBe(0)
    expect(await cierra(Z('2026-11-07T03:59:00'))).toBe(0)
    expect(await cierra(Z('2026-11-07T04:00:00'))).toBe(1)
    expect(await estado(x.onlineOrderId)).toBe('COMPLETED')
  })

  it('READY también sale al terminar el día', async () => {
    await poner('America/Mexico_City')
    const x = await porEntregarDesde(Z('2026-11-05T12:00:00'), { estado: 'READY' })
    expect(await cierra(Z('2026-11-06T04:00:00'))).toBe(1)
    expect(await estado(x.onlineOrderId)).toBe('COMPLETED')
  })

  it('«Mi equipo» no lo toca este cierre, ni lo que está pendiente de pago', async () => {
    await poner('America/Mexico_City')
    const equipo = await porEntregarDesde(Z('2026-11-05T12:00:00'), { equipo: true })
    const porPagar = await nuevoFolio()
    expect(await cierra(Z('2026-11-08T04:00:00'))).toBe(0)
    expect(await estado(equipo.onlineOrderId)).toBe('ACCEPTED')
    expect(await estado(porPagar.onlineOrderId)).toBe('PENDING_ACCEPTANCE')
  })

  it('zona desconocida ⇒ la de respaldo (México), sin tumbar la pasada', async () => {
    await poner('Marte/Olimpo')
    const x = await porEntregarDesde(Z('2026-11-05T23:50:00'))
    expect(await cierra(Z('2026-11-06T03:59:00'))).toBe(0)
    expect(await cierra(Z('2026-11-06T04:00:00'))).toBe(1)
    expect(await estado(x.onlineOrderId)).toBe('COMPLETED')
    await poner('America/Mexico_City')
  })

  it('la zona del negocio manda: en Tijuana (UTC-8) las 04:00 locales son las 12:00Z', async () => {
    await poner('America/Tijuana')
    const x = await porEntregarDesde(new Date('2026-11-06T07:50:00Z')) // 23:50 del 5 en Tijuana
    expect(await cierra(new Date('2026-11-06T11:59:00Z'))).toBe(0)
    expect(await cierra(new Date('2026-11-06T12:00:00Z'))).toBe(1)
    expect(await estado(x.onlineOrderId)).toBe('COMPLETED')
    await poner('America/Mexico_City')
  })

  it('una cuenta cancelada no termina «Entregado» (si la sincronización de cancelaciones falló en la pasada)', async () => {
    await poner('America/Mexico_City')
    const x = await porEntregarDesde(Z('2026-11-05T12:00:00'))
    await prisma.order.update({ where: { id: x.orderId }, data: { status: 'CANCELLED' } })
    expect(await cierra(Z('2026-11-06T04:00:00'))).toBe(0)
    expect(await estado(x.onlineOrderId)).toBe('ACCEPTED')
  })

  it('una persona que entrega antes gana: el cierre del día no escribe encima', async () => {
    await poner('America/Mexico_City')
    const x = await nuevoFolio()
    await efectivoDelPos(x.orderId) // la puerta de «Entregado» pide la cuenta pagada
    await pasada()
    await prisma.onlineOrder.update({ where: { id: x.onlineOrderId }, data: { acceptedAt: Z('2026-11-05T12:00:00') } })
    const r = await entregarPorPersona(x.orderId)
    expect(r.outcome).toBe('OK')
    expect(await cierra(Z('2026-11-06T04:00:00'))).toBe(0)
  })
})

describe('T13 · «Cancelar folio» (personal) sobre un folio por pagar', () => {
  const cancelar = (orderId: string) => cancelOnlineOrderByStaff({ venueId: f.venueId, orderId, staffId: f.staffId })

  it('sin dinero: el folio queda CANCELLED_BY_STAFF y su cuenta CANCELLED (cancelOrder real)', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    expect(await cancelar(orderId)).toEqual({ outcome: 'OK', status: 'CANCELLED_BY_STAFF' })
    expect((await pedido(onlineOrderId)).status).toBe('CANCELLED_BY_STAFF')
    expect((await cuenta(orderId)).status).toBe('CANCELLED')
  })

  it('con un abono: HAS_PAYMENTS y nada cambia', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    await efectivoDelPos(orderId, CINCUENTA)
    const antes = (await pedido(onlineOrderId)).status
    expect(await cancelar(orderId)).toEqual({ outcome: 'HAS_PAYMENTS' })
    expect((await pedido(onlineOrderId)).status).toBe(antes)
    expect((await cuenta(orderId)).status).not.toBe('CANCELLED')
  })

  it('R46: «Rechazar» un folio responde STALE y no toca nada: el folio se quita con «Cancelar folio»', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    expect(await rejectOnlineOrder({ venueId: f.venueId, orderId, staffId: f.staffId, reason: 'OTHER' })).toEqual({
      outcome: 'STALE',
      status: 'PENDING_ACCEPTANCE',
    })
    expect((await pedido(onlineOrderId)).status).toBe('PENDING_ACCEPTANCE')
    expect((await cuenta(orderId)).status).toBe('PENDING')
    // «Mi equipo» sigue rechazando como hoy.
    const equipo = await nuevoFolio({ equipo: true })
    expect(await rejectOnlineOrder({ venueId: f.venueId, orderId: equipo.orderId, staffId: f.staffId, reason: 'OTHER' })).toEqual({
      outcome: 'OK',
      status: 'REJECTED',
    })
    expect((await cuenta(equipo.orderId)).status).toBe('CANCELLED')
  })

  it('un pedido de «Mi equipo» por aceptar sigue en STALE y no se toca', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio({ equipo: true })
    expect(await cancelar(orderId)).toEqual({ outcome: 'STALE', status: 'PENDING_ACCEPTANCE' })
    expect((await pedido(onlineOrderId)).status).toBe('PENDING_ACCEPTANCE')
    expect((await cuenta(orderId)).status).not.toBe('CANCELLED')
  })

  it('orden (a): primero «Cancelar folio», después el cobro: folio y cuenta cancelados, el cobro se rechaza y no hay Payment', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    expect(await cancelar(orderId)).toEqual({ outcome: 'OK', status: 'CANCELLED_BY_STAFF' })
    await expect(efectivoDelPos(orderId)).rejects.toBeDefined()
    expect(await prisma.payment.count({ where: { orderId } })).toBe(0)
    expect((await cuenta(orderId)).status).toBe('CANCELLED')
    expect((await pedido(onlineOrderId)).status).toBe('CANCELLED_BY_STAFF')
  })

  it('orden (b): primero el cobro, después «Cancelar folio»: se niega por el dinero y la cuenta queda cobrada', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    await efectivoDelPos(orderId)
    const r = await cancelar(orderId)
    // Lo que pasa de verdad: el cobro deja el folio «Por entregar» (T9) y la guarda de dinero bajo candado lo frena.
    expect(r).toEqual({ outcome: 'HAS_PAYMENTS' })
    expect((await cuenta(orderId)).status).not.toBe('CANCELLED')
    expect((await pedido(onlineOrderId)).status).not.toBe('CANCELLED_BY_STAFF')
    expect(await prisma.payment.count({ where: { orderId, status: 'COMPLETED' } })).toBe(1)
  })

  it('carrera: el cobro de la caja y «Cancelar folio» a la vez: gana uno solo, nunca dinero nuevo sobre una cuenta cancelada', async () => {
    let ganoCobro = 0
    let ganoCancelar = 0
    for (let ronda = 0; ronda < 4; ronda++) {
      const { orderId, onlineOrderId } = await nuevoFolio()
      const [cobro, cancelacion] = await Promise.allSettled([efectivoDelPos(orderId), cancelar(orderId)])

      const dinero = await prisma.payment.count({ where: { orderId, status: 'COMPLETED' } })
      const cuentaFinal = await cuenta(orderId)
      const folioFinal = await pedido(onlineOrderId)
      const cancelo = cancelacion.status === 'fulfilled' && cancelacion.value.outcome === 'OK'

      expect([cobro.status === 'fulfilled', cancelo]).toContain(true) // al menos uno ganó
      if (cancelo) {
        ganoCancelar++
        // Ganó «Cancelar folio»: la cuenta cancelada, sin un solo pago, y el cobro nuevo se rechazó.
        expect(cobro.status).toBe('rejected')
        expect(dinero).toBe(0)
        expect(cuentaFinal.status).toBe('CANCELLED')
        expect(folioFinal.status).toBe('CANCELLED_BY_STAFF')
      } else {
        ganoCobro++
        // Ganó el cobro: queda cobrado y NO cancelado; la cancelación se negó por el dinero (o el folio ya cambió).
        expect(cobro.status).toBe('fulfilled')
        expect(dinero).toBe(1)
        expect(cuentaFinal.status).not.toBe('CANCELLED')
        expect(folioFinal.status).not.toBe('CANCELLED_BY_STAFF')
        if (cancelacion.status === 'fulfilled') expect(['HAS_PAYMENTS', 'STALE']).toContain(cancelacion.value.outcome)
      }
      await f.limpiar()
    }
    // Informativo (no se exige >0 de cada lado: sería inestable; para eso están los órdenes (a) y (b)).
    console.info(`T13 carrera: ganó el cobro ${ganoCobro}, ganó «Cancelar folio» ${ganoCancelar}`)
  })
})
