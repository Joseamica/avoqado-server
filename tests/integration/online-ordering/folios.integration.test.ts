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
import { armarComandasTrasCommit, authorKitchenTickets } from '@/services/kds/kitchenTicketAuthoring.service'
import { mergeOrders, payCashOrder, splitOrderBySeat } from '@/services/mobile/order.mobile.service'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { cerrarCanceladasReleyendo } from '@/services/online-ordering/cancelledOrderSync'
import {
  cerrarFoliosDelDiaTerminado,
  leerFoliosConAbonoDevuelto,
  leerPedidosVencidos,
  listFolios,
  prepararFolioPagado,
  syncPaidFolios,
  type CursorDeVencer,
} from '@/services/online-ordering/folios.service'
import { createKdsOrder } from '@/services/mobile/kds.mobile.service'
import { addItemsToOrder } from '@/services/tpv/order.tpv.service'
import { processWebhook } from '@/services/b4bit/b4bit.service'
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
/** S9 v5 (K6): un segundo producto del catálogo. */
let otroProductoId: string
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
  otroProductoId = (
    await prisma.product.create({
      data: { venueId: f.venueId, name: 'Gorditas', sku: `GOR-${f.fixture}`, price: 50, categoryId: categoria.id, availableOnline: true },
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

/** La cola sin red del POS: efectivo YA cobrado que llega tarde (nunca se rechaza). `cobradoEn`: la hora del aparato al cobrar. */
async function colaSinRed(orderId: string, centavos = CIEN, cobradoEn?: Date) {
  const [ack] = await processIntents({
    venueId: f.venueId,
    staffId: f.staffId,
    deviceId: `aparato-${f.fixture}`,
    intents: [
      {
        id: randomUUID(),
        seq: ++seq,
        type: 'PAY_CASH',
        payload: { orderId, amountCents: centavos, tipCents: 0, method: 'CASH' },
        ...(cobradoEn ? { createdAtLocal: cobradoEn.getTime() } : {}),
      },
    ],
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
  it('efectivo de la cola sin red que SALDA un folio vencido ⇒ ACCEPTED en la siguiente pasada (que publica), sin comanda de cocina', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio({ vencido: true })
    await vencer(orderId)

    await colaSinRed(orderId)

    // S9 (Codex r2): el dinero salda la cuenta y avisa; el folio cerrado lo revive `syncPaidClosedFolios` (en la bandeja o el trabajo de
    // cada 30 s), que publica después del commit lo que la transacción del dinero no puede.
    expect((await pedido(onlineOrderId)).status).toBe('EXPIRED')
    await pasada()
    await porEntregar(onlineOrderId)
    expect(aceptadosEnBitacora(onlineOrderId)).toEqual([
      expect.objectContaining({ staffId: null, data: expect.objectContaining({ from: 'EXPIRED' }) }),
    ])
    expect(await cuenta(orderId)).toMatchObject({ paymentStatus: 'PAID' })
    expect(await comandas(orderId)).toBe(0)
  })

  it('tarjeta de la TPV aprobada después de vencer ⇒ lo mismo', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio({ vencido: true })
    await vencer(orderId)

    await tarjetaDeLaTpv(orderId)

    await pasada() // S9 (Codex r2): lo revive la pasada
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
    await pasada() // S9 (Codex r2): lo revive la pasada
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

describe('S9 v5 · la cocina «en duda, manda» en un folio sellado (K1–K10)', () => {
  const HACE_UNA_HORA = () => new Date(Date.now() - 3_600_000)
  /** Lo que la cajera NO tocó: renglones de hace una hora (un folio real se arma minutos antes de vencer, no en el mismo milisegundo). */
  const renglonesViejos = (orderId: string) =>
    prisma.orderItem.updateMany({ where: { orderId }, data: { createdAt: HACE_UNA_HORA(), updatedAt: HACE_UNA_HORA() } })
  const cobroDirecto = (orderId: string, pesos: number, type: 'REGULAR' | 'REFUND' = 'REGULAR') =>
    prisma.payment.create({
      data: {
        venueId: f.venueId,
        orderId,
        amount: pesos,
        tipAmount: 0,
        method: 'CASH',
        source: 'TPV',
        status: 'COMPLETED',
        type,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: pesos,
        processedById: f.staffId,
      },
    })
  /** R44 reciente: su abono de $50 se devolvió completo y venció sin cancelar su cuenta (T = `expiredAt`). */
  async function r44Reciente() {
    const folio = await nuevoFolio({ vencido: true })
    await cobroDirecto(folio.orderId, 50)
    await cobroDirecto(folio.orderId, -50, 'REFUND')
    await prisma.order.update({ where: { id: folio.orderId }, data: { paymentStatus: 'PARTIAL', paidAmount: 50, remainingBalance: 50 } })
    await renglonesViejos(folio.orderId)
    await vencer(folio.orderId)
    expect((await cuenta(folio.orderId)).status).toBe('PENDING')
    return folio
  }
  /** `KdsOrderItem` de la cuenta, por renglón y cantidad. */
  const enCocina = async (orderId: string) =>
    (
      await prisma.kdsOrderItem.findMany({
        where: { kdsOrder: { venueId: f.venueId, orderId } },
        select: { orderItemId: true, quantity: true, productName: true },
      })
    ).map(i => ({ producto: i.productName, cantidad: i.quantity }))
  const legado = (orderId: string) =>
    createKdsOrder(f.venueId, { orderNumber: `legado-${orderId}`, orderId, items: [{ productName: 'Flautas', quantity: 1 }] })
  /** Los cuatro disparadores del armado: el gancho del cobro, una ronda, el barrido y el POST legado. Ninguno arma. */
  async function ningunDisparadorArma(orderId: string) {
    for (const trigger of ['PAID', 'ROUND', 'SWEEP'] as const) {
      await expect(authorKitchenTickets({ venueId: f.venueId, orderId, trigger })).resolves.toEqual({ ticketIds: [] })
    }
    await expect(legado(orderId)).resolves.toBeNull()
    expect(await enCocina(orderId)).toEqual([])
    expect((await cuenta(orderId)).kitchenPendingAt).toBeNull()
  }
  const version = async (orderId: string) => (await cuenta(orderId)).version

  it.each([
    ['TPV', (orderId: string) => efectivoDeLaTpv(orderId, CINCUENTA)],
    ['POS sin red', (orderId: string) => colaSinRed(orderId, CINCUENTA)],
    ['POS en vivo', (orderId: string) => efectivoDelPos(orderId, CINCUENTA)],
    [
      'pago manual',
      (orderId: string) =>
        createManualPayment(f.venueId, f.staffId, { orderId, amount: '50.00', tipAmount: '0', method: 'BANK_TRANSFER', source: 'OTHER' }),
    ],
    [
      'cripto',
      async (orderId: string) => {
        const p = await prisma.payment.create({
          data: {
            venueId: f.venueId,
            orderId,
            amount: 50,
            tipAmount: 0,
            method: 'CRYPTOCURRENCY',
            source: 'TPV',
            status: 'PENDING',
            type: 'FAST',
            processor: 'B4BIT',
            processedById: f.staffId,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: 50,
          },
        })
        await processWebhook({
          identifier: randomUUID(),
          reference: p.id,
          fiat_amount: 50,
          fiat_currency: 'MXN',
          crypto_amount: '0.001',
          currency: 'BTC',
          status: 'CO',
          tx_hash: `tx-${p.id}`,
          confirmations: 3,
        })
      },
    ],
  ] as const)(
    'K1 (R44, sin tocar) por %s: el dinero tardío que la salda ⇒ 0 comandas con cada disparador; revivida, sigue en 0',
    async (_c, pagar) => {
      const { orderId, onlineOrderId } = await r44Reciente()
      await pagar(orderId)
      expect((await cuenta(orderId)).paymentStatus).toBe('PAID')

      await ningunDisparadorArma(orderId)
      await pasada()
      await porEntregar(onlineOrderId)
      await ningunDisparadorArma(orderId)
    },
  )

  it('K2 (el hueco, r6 #1): el panel anula; sin sincronizar, $100 sin red y la conciliación lo pasa a ACCEPTED ⇒ 0 con el POST legado, PAID y SWEEP', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    await renglonesViejos(orderId)
    await updateOrder(f.venueId, orderId, { status: 'CANCELLED' } as any, { staffId: f.staffId })
    expect((await pedido(onlineOrderId)).cancelledAt).not.toBeNull() // B1

    await colaSinRed(orderId)
    await porEntregar(onlineOrderId)
    await ningunDisparadorArma(orderId)
  })

  it('K3 (folio normal, sin sello): pagado por la TPV y preparado ⇒ su comanda de siempre, todos sus renglones, una vez', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    await tarjetaDeLaTpv(orderId)
    await prepararFolioPagado({ venueId: f.venueId, orderId, staffId: null })
    await authorKitchenTickets({ venueId: f.venueId, orderId, trigger: 'PAID' })
    await authorKitchenTickets({ venueId: f.venueId, orderId, trigger: 'SWEEP' })
    await porEntregar(onlineOrderId)
    expect(await enCocina(orderId)).toEqual([{ producto: 'Flautas', cantidad: 1 }])
  })

  it.each(['PAID', 'SWEEP'] as const)(
    'K4 (1 → 2): vence; $50 sin red lo reabren; el carrito con el producto en 2 (se funde, mostrador); se cobra el resto ⇒ al cobrar (%s) se manda el renglón con 2',
    async trigger => {
      const { orderId } = await nuevoFolio({ vencido: true })
      await renglonesViejos(orderId)
      await vencer(orderId)
      await colaSinRed(orderId, CINCUENTA)
      await addItemsToOrder(f.venueId, orderId, [{ productId, quantity: 2 }], await version(orderId))
      expect(await prisma.orderItem.count({ where: { orderId } })).toBe(1) // se fundió en el mismo renglón

      await efectivoDeLaTpv(orderId, 15_000)
      const pagada = await cuenta(orderId)
      expect(pagada.paymentStatus).toBe('PAID')
      expect(pagada.kitchenPendingAt).not.toBeNull() // el cobro marcó la cocina: mostrador, sin ROUND
      await authorKitchenTickets({ venueId: f.venueId, orderId, trigger })
      expect(await enCocina(orderId)).toEqual([{ producto: 'Flautas', cantidad: 2 }])
    },
  )

  it('K5 (2 → 1 → 2, r8 #1): dos en un renglón; vence; un abono; carrito con 1; carrito con 2; se cobra ⇒ se manda con 2', async () => {
    const { orderId } = await nuevoFolio({ vencido: true })
    await prisma.orderItem.updateMany({ where: { orderId }, data: { quantity: 2, total: 200 } })
    await prisma.order.update({ where: { id: orderId }, data: { subtotal: 200, total: 200, remainingBalance: 200 } })
    await renglonesViejos(orderId)
    await vencer(orderId)
    await colaSinRed(orderId, CINCUENTA)
    await addItemsToOrder(f.venueId, orderId, [{ productId, quantity: 1 }], await version(orderId))
    await addItemsToOrder(f.venueId, orderId, [{ productId, quantity: 2 }], await version(orderId))

    await efectivoDeLaTpv(orderId, 15_000)
    await authorKitchenTickets({ venueId: f.venueId, orderId, trigger: 'PAID' })
    expect(await enCocina(orderId)).toEqual([{ producto: 'Flautas', cantidad: 2 }])
  })

  it('K6 (producto distinto, E14): como K4 pero se agrega otro producto ⇒ se manda como hoy, el nuevo y el original', async () => {
    const { orderId } = await nuevoFolio({ vencido: true })
    await renglonesViejos(orderId)
    await vencer(orderId)
    await colaSinRed(orderId, CINCUENTA)
    await addItemsToOrder(
      f.venueId,
      orderId,
      [
        { productId, quantity: 1 },
        { productId: otroProductoId, quantity: 1 },
      ],
      await version(orderId),
    )
    await efectivoDeLaTpv(orderId, 10_000)
    await authorKitchenTickets({ venueId: f.venueId, orderId, trigger: 'PAID' })
    expect((await enCocina(orderId)).sort((a, b) => a.producto.localeCompare(b.producto))).toEqual([
      { producto: 'Flautas', cantidad: 1 },
      { producto: 'Gorditas', cantidad: 1 },
    ])
  })

  it('K7 (anulado antes del despliegue, r8 #2): R44 sólo con expiredAt; 1 → 2 y se cobra ⇒ se manda con 2', async () => {
    const { orderId } = await r44Reciente()
    await addItemsToOrder(f.venueId, orderId, [{ productId, quantity: 2 }], await version(orderId))
    await efectivoDeLaTpv(orderId, 15_000)
    expect((await cuenta(orderId)).paymentStatus).toBe('PAID')
    await authorKitchenTickets({ venueId: f.venueId, orderId, trigger: 'PAID' })
    expect(await enCocina(orderId)).toEqual([{ producto: 'Flautas', cantidad: 2 }])
  })

  it('K8 (hueco viejo): sin su cancelledAt, $100 sin red ⇒ la conciliación lo sella y sin tocar da 0; con 1 → 2 y cobro, se manda', async () => {
    const sinTocar = await nuevoFolio()
    await renglonesViejos(sinTocar.orderId)
    await updateOrder(f.venueId, sinTocar.orderId, { status: 'CANCELLED' } as any, { staffId: f.staffId })
    await prisma.onlineOrder.update({ where: { id: sinTocar.onlineOrderId }, data: { cancelledAt: null } })
    await colaSinRed(sinTocar.orderId)
    expect((await pedido(sinTocar.onlineOrderId)).cancelledAt).not.toBeNull()
    await ningunDisparadorArma(sinTocar.orderId)

    const tocado = await nuevoFolio()
    await renglonesViejos(tocado.orderId)
    await updateOrder(f.venueId, tocado.orderId, { status: 'CANCELLED' } as any, { staffId: f.staffId })
    await prisma.onlineOrder.update({ where: { id: tocado.onlineOrderId }, data: { cancelledAt: null } })
    await colaSinRed(tocado.orderId, CINCUENTA)
    await addItemsToOrder(f.venueId, tocado.orderId, [{ productId, quantity: 2 }], await version(tocado.orderId))
    await efectivoDeLaTpv(tocado.orderId, 15_000)
    await authorKitchenTickets({ venueId: f.venueId, orderId: tocado.orderId, trigger: 'PAID' })
    expect(await enCocina(tocado.orderId)).toEqual([{ producto: 'Flautas', cantidad: 2 }])
  })

  it('K9 (holgura de 5 s): un renglón tocado en T − 2 s cuenta como tocado y se manda; uno de T − 10 s da 0', async () => {
    const cerca = await r44Reciente()
    const lejos = await r44Reciente()
    for (const [folio, segundos] of [
      [cerca, 2],
      [lejos, 10],
    ] as const) {
      const T = (await pedido(folio.onlineOrderId)).expiredAt!
      await prisma.orderItem.updateMany({
        where: { orderId: folio.orderId },
        data: { createdAt: HACE_UNA_HORA(), updatedAt: new Date(T.getTime() - segundos * 1_000) },
      })
      await efectivoDeLaTpv(folio.orderId, CINCUENTA)
      await authorKitchenTickets({ venueId: f.venueId, orderId: folio.orderId, trigger: 'SWEEP' })
    }
    expect(await enCocina(cerca.orderId)).toEqual([{ producto: 'Flautas', cantidad: 1 }])
    expect(await enCocina(lejos.orderId)).toEqual([])
  })

  it('K10 («Mi equipo»): anulado, reabierto y cobrado ⇒ como hoy (sin marca al reabrir; un armado directo no se suprime)', async () => {
    const { orderId } = await nuevoFolio({ equipo: true, vencido: true })
    await renglonesViejos(orderId)
    await vencer(orderId)
    await colaSinRed(orderId)
    expect((await cuenta(orderId)).kitchenPendingAt).toBeNull()
    await authorKitchenTickets({ venueId: f.venueId, orderId, trigger: 'SWEEP' })
    expect(await enCocina(orderId)).toEqual([{ producto: 'Flautas', cantidad: 1 }])
  })

  // ── Regla C (founder, 10-nov): la cajera cobró el folio sin red ANTES de que venciera; el dinero sube después ─────────────
  describe('K12–K16 · regla C: el folio cobrado A TIEMPO en la caja que sube tarde llega a la cocina', () => {
    const MIN = 60_000
    /** Un folio pedido hace 40 min, con sus renglones de entonces (nadie los vuelve a tocar). */
    async function folioDeHace40() {
      const folio = await nuevoFolio({ vencido: true })
      const hace40 = new Date(Date.now() - 40 * MIN)
      await prisma.onlineOrder.update({ where: { id: folio.onlineOrderId }, data: { createdAt: hace40 } })
      await prisma.orderItem.updateMany({ where: { orderId: folio.orderId }, data: { createdAt: hace40, updatedAt: hace40 } })
      return folio
    }
    const cerrar = {
      vence: vencer,
      'el personal lo cancela': async (orderId: string) =>
        expect(await cancelOnlineOrderByStaff({ venueId: f.venueId, orderId, staffId: f.staffId })).toMatchObject({ outcome: 'OK' }),
    }
    /** Lo que hace el gancho de después del commit (simulado en este archivo): el armado ROUND. */
    const ganchoRound = (orderId: string) => authorKitchenTickets({ venueId: f.venueId, orderId, trigger: 'ROUND' })
    const rondasProgramadas = (orderId: string) =>
      (armarComandasTrasCommit as jest.Mock).mock.calls.filter(([v, o, t]) => v === f.venueId && o === orderId && t === 'ROUND')

    it.each(Object.keys(cerrar) as Array<keyof typeof cerrar>)(
      'K12 (a, d) %s a los 30; la cajera lo cobró sin red a los 25 y sube a los 40 ⇒ revive con UNA comanda, aunque la pasada corra dos veces',
      async como => {
        const { orderId, onlineOrderId } = await folioDeHace40()
        await cerrar[como](orderId) // T = ahora
        expect((await cuenta(orderId)).status).toBe('CANCELLED')

        await colaSinRed(orderId, CIEN, new Date(Date.now() - 15 * MIN)) // cobrado antes de T, sube ahora
        expect(await cuenta(orderId)).toMatchObject({ paymentStatus: 'PAID', kitchenPendingAt: null }) // el que reabre no marca
        expect((await pedido(onlineOrderId)).status).not.toBe('ACCEPTED')

        await pasada()
        await porEntregar(onlineOrderId)
        expect((await cuenta(orderId)).kitchenPendingAt).not.toBeNull() // marcada en la transacción del revivir
        expect(rondasProgramadas(orderId)).toHaveLength(1)
        await ganchoRound(orderId)
        expect(await comandas(orderId)).toBe(1)
        expect(await enCocina(orderId)).toEqual([{ producto: 'Flautas', cantidad: 1 }])
        expect((await cuenta(orderId)).kitchenPendingAt).toBeNull()

        // (d) La pasada otra vez (el trabajo y la bandeja), y el gancho y el barrido repetidos: sigue UNA comanda.
        await pasada()
        await pasada()
        expect(rondasProgramadas(orderId)).toHaveLength(1)
        await ganchoRound(orderId)
        await authorKitchenTickets({ venueId: f.venueId, orderId, trigger: 'SWEEP' })
        expect(await comandas(orderId)).toBe(1)
        expect(await enCocina(orderId)).toEqual([{ producto: 'Flautas', cantidad: 1 }])
      },
    )

    it.each([
      ['cobrado de verdad a los 45 (después de vencer)', () => new Date(Date.now() + 1_000)],
      ['con una hora anterior a que existiera el folio (reloj del aparato sin hora)', () => new Date(Date.now() - 60 * MIN)],
      ['sin hora del cobro', () => undefined],
    ])('K13 (b) %s ⇒ como hoy: revive a «Por entregar» sin comanda con ningún disparador', async (_c, cobradoEn) => {
      const { orderId, onlineOrderId } = await folioDeHace40()
      await vencer(orderId)
      await colaSinRed(orderId, CIEN, cobradoEn())

      await pasada()
      await porEntregar(onlineOrderId)
      expect(rondasProgramadas(orderId)).toHaveLength(0)
      await ningunDisparadorArma(orderId)
    })

    it('K14 (c) sin pantalla de cocina ⇒ revive sin marca ni comanda', async () => {
      await prisma.printStation.updateMany({ where: { venueId: f.venueId }, data: { hasKitchenDisplay: false } })
      try {
        const { orderId, onlineOrderId } = await folioDeHace40()
        await vencer(orderId)
        await colaSinRed(orderId, CIEN, new Date(Date.now() - 15 * MIN))

        await pasada()
        await porEntregar(onlineOrderId)
        expect((await cuenta(orderId)).kitchenPendingAt).toBeNull()
        expect(rondasProgramadas(orderId)).toHaveLength(0)
        expect(await comandas(orderId)).toBe(0)
      } finally {
        await prisma.printStation.updateMany({ where: { venueId: f.venueId }, data: { hasKitchenDisplay: true } })
      }
    })

    it('K16 el panel anula la CUENTA y la sincronización cierra el folio («cancelado por otra vía»: su hora no es la de la anulación) ⇒ como hoy', async () => {
      const { orderId, onlineOrderId } = await folioDeHace40()
      const antesDeAnular = new Date(Date.now() - 15 * MIN)
      await updateOrder(f.venueId, orderId, { status: 'CANCELLED' } as any, { staffId: f.staffId })
      await cerrarCanceladasReleyendo({ venueId: f.venueId }, () => new Date())
      expect(await pedido(onlineOrderId)).toMatchObject({ status: 'CANCELLED_BY_STAFF', cancelledBy: 'ORDER_CANCELLED_ELSEWHERE' })
      await colaSinRed(orderId, CIEN, antesDeAnular)

      await pasada()
      await porEntregar(onlineOrderId)
      expect(rondasProgramadas(orderId)).toHaveLength(0)
      await ningunDisparadorArma(orderId)
    })

    it('K15 cobro a tiempo que sólo ABONA y el resto con red después de vencer ⇒ como hoy (la cuenta se terminó de pagar tarde)', async () => {
      const { orderId, onlineOrderId } = await folioDeHace40()
      await vencer(orderId)
      await colaSinRed(orderId, CINCUENTA, new Date(Date.now() - 15 * MIN))
      await efectivoDelPos(orderId, CINCUENTA)
      expect((await cuenta(orderId)).paymentStatus).toBe('PAID')

      await pasada()
      await porEntregar(onlineOrderId)
      expect(rondasProgramadas(orderId)).toHaveLength(0)
      expect(await comandas(orderId)).toBeLessThanOrEqual(1) // la del cobro que saldó, como hoy (decisión 19)
    })
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

    const bandeja = cerrarCanceladasReleyendo({ venueId: f.venueId }, () => new Date())
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
      syncPaidFolios({ venueId: f.venueId }, () => new Date()),
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
  const cierra = async (hora: Date) => cerrarFoliosDelDiaTerminado({ venueId: f.venueId }, () => hora)
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

describe('R52 · reloj viejo: la pasada que empieza antes de las 04:00 no fecha «ayer» un folio que se salda después (contra Postgres)', () => {
  // México no tiene horario de verano desde 2022: en noviembre la hora local es UTC-6.
  const Z = (iso: string) => new Date(`${iso}-06:00`)
  /** El trabajo de cada 30 s, con sus dependencias reales (sin cron) y el reloj que se le da. */
  const pasarElTrabajo = (now: () => Date) =>
    new OnlineOrderAcceptanceExpiryJob({ cron: { start: jest.fn(), stop: jest.fn() } as never, now }).checkNow()

  it('pasada desde las 03:59:50; la cajera salda el folio vencido a las 04:00:05 ⇒ revive con `acceptedAt` ≥ 04:00:05 y el fin del día no lo toca hasta mañana a las 04:00', async () => {
    await prisma.venue.update({ where: { id: f.venueId }, data: { timezone: 'America/Mexico_City' } })
    const x = await nuevoFolio()
    // El folio venció a las 03:30 y otro cobro terminó de saldar su cuenta (la cuenta ya PAID y cerrada por la TPV; los caminos de
    // dinero reales tienen sus pruebas arriba): es candidato de `syncPaidClosedFolios`.
    await prisma.onlineOrder.update({
      where: { id: x.onlineOrderId },
      data: { status: 'EXPIRED', expiredAt: Z('2026-11-06T03:30:00'), updatedAt: Z('2026-11-06T03:30:00') },
    })
    await prisma.order.update({
      where: { id: x.orderId },
      data: { status: 'COMPLETED', paymentStatus: 'PAID', paidAmount: 100, remainingBalance: 0 },
    })

    // La pasada toma su hora a las 03:59:50; todo lo que lee el reloj después (la escritura bajo el candado) ya marca 04:00:05.
    const reloj = jest.fn().mockReturnValueOnce(Z('2026-11-06T03:59:50')).mockReturnValue(Z('2026-11-06T04:00:05'))
    await pasarElTrabajo(reloj)

    const revivido = await pedido(x.onlineOrderId)
    expect(revivido.status).toBe('ACCEPTED')
    expect(revivido.acceptedAt!.getTime()).toBeGreaterThanOrEqual(Z('2026-11-06T04:00:05').getTime())

    // Las pasadas siguientes del mismo día del negocio no lo sacan de «Por entregar»…
    for (const hora of [Z('2026-11-06T04:00:40'), Z('2026-11-06T23:59:00'), Z('2026-11-07T03:59:59')]) {
      await pasarElTrabajo(() => hora)
      expect((await pedido(x.onlineOrderId)).status).toBe('ACCEPTED')
    }
    // …y sale al terminar SU día: mañana a las 04:00.
    await pasarElTrabajo(() => Z('2026-11-07T04:00:00'))
    const entregado = await pedido(x.onlineOrderId)
    expect(entregado.status).toBe('COMPLETED')
    expect(entregado.completedAt).toEqual(Z('2026-11-07T04:00:00'))
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

describe('R53 · un folio no se junta ni se divide con otra cuenta (Postgres real)', () => {
  const FOLIO_NO_SE_JUNTA = { statusCode: 409, code: 'ONLINE_ORDER_FOLIO_NO_SE_JUNTA' }

  it('de folio a otra cuenta, de otra al folio y dividir: 409 y el folio queda intacto (sigue «Por pagar», con su renglón)', async () => {
    const folio = await nuevoFolio()
    const otra = await nuevoFolio({ equipo: true })
    await expect(mergeOrders(f.venueId, otra.orderId, folio.orderId)).rejects.toMatchObject(FOLIO_NO_SE_JUNTA)
    await expect(mergeOrders(f.venueId, folio.orderId, otra.orderId)).rejects.toMatchObject(FOLIO_NO_SE_JUNTA)
    await expect(splitOrderBySeat(f.venueId, folio.orderId)).rejects.toMatchObject(FOLIO_NO_SE_JUNTA)
    const c = await cuenta(folio.orderId)
    expect(c.status).toBe('PENDING')
    expect(await prisma.orderItem.count({ where: { orderId: folio.orderId } })).toBe(1)
    expect(await prisma.orderItem.count({ where: { orderId: otra.orderId } })).toBe(1)
    expect((await pedido(folio.onlineOrderId)).status).toBe('PENDING_ACCEPTANCE')
  })

  it('un pedido de «Mi equipo» no lo frena esta guarda', async () => {
    const a = await nuevoFolio({ equipo: true })
    const b = await nuevoFolio({ equipo: true })
    await mergeOrders(f.venueId, a.orderId, b.orderId).catch(e => expect(e.code).not.toBe('ONLINE_ORDER_FOLIO_NO_SE_JUNTA'))
  })
})
