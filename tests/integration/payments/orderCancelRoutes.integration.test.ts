/**
 * Diseño §C.6 (11-sep): TODA ruta que cancela o anula una orden respeta el candado de la orden y el cobro de
 * terminal vivo, igual que `cancelOrder` móvil (T22). Postgres real, base aislada elegida por quien corre la suite.
 *
 * Por ruta:
 *  (a) una ADMISIÓN retiene el candado → la ruta espera → 409 `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE` y la orden no
 *      queda cancelada;
 *  (b) un REGISTRO pone PAID mientras retiene → la ruta espera → 400 y la orden sigue PAID;
 *  (c) al revés: la RUTA retiene el candado → la admisión espera → 400 `ORDER_CANCELLED_NO_NEW_CHARGE`, sin fila;
 *  (d) control sin bloqueador.
 * Más: fusiones cruzadas A→B / B→A concurrentes, y anular todo mientras aterriza un pago con tarjeta que NO sube la
 * versión de la orden (el CAS no lo ve; el candado sí).
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { logAction } from '@/services/dashboard/activity-log.service'
import { deleteOrder, updateOrder } from '@/services/dashboard/order.dashboard.service'
import { voidItems } from '@/services/tpv/order.tpv.service'
import { mergeOrders } from '@/services/mobile/order.mobile.service'
import { cancelAreaTicketCheckout } from '@/services/mobile/areaTicketV7.mobile.service'
import { processPosOrderDeleteEvent } from '@/services/pos-sync/posSyncOrder.service'
import { cancelDeliveryOrder } from '@/services/delivery-channels/core/cancelDeliveryOrder.service'
import * as referralRefund from '@/services/referrals/referralRefund.service'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const fixture = `cancelroutes-${randomUUID()}`
const venueId = fixture
let staffId: string
let directEmit: jest.Mock

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  // La base de este trabajo en la Mac, o la de CI (`avoqado_*_test_*`): nunca otra.
  expect(url.pathname).toMatch(/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/)
  await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: fixture, name: fixture, slug: fixture } })
  const staff = await prisma.staff.create({ data: { email: `${fixture}@staff.test`, firstName: 'Prueba', lastName: 'Cancelaciones' } })
  staffId = staff.id
})

beforeEach(() => {
  jest.clearAllMocks()
  directEmit = jest.fn()
  const socket = { emit: directEmit, timeout: () => ({ emit: directEmit }) }
  ;(socketManager.getServer as jest.Mock).mockReturnValue({
    sockets: { sockets: new Map([['fixture-socket', socket]]) },
    to: () => ({ emit: jest.fn() }),
  })
  ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
    terminalId,
    venueId,
    socketId: 'fixture-socket',
    terminalPaymentAckVersion: 1,
  }))
})

afterEach(async () => {
  jest.restoreAllMocks()
  await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
})

afterAll(async () => {
  await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
  await prisma.orderAction.deleteMany({ where: { order: { venueId } } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: fixture } })
})

// ─── Helpers (copiados de terminalPaymentRecovery.integration.test.ts, que otra tarea edita) ─────────────────────────

const nextRequest = () => randomUUID()
const esperar = (ms: number) => new Promise(r => setTimeout(r, ms))

function nuevaOrden(extra: Record<string, unknown> = {}) {
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: `${fixture}-${randomUUID().slice(0, 8)}`,
      subtotal: new Prisma.Decimal(100),
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(100),
      remainingBalance: new Prisma.Decimal(100),
      ...extra,
    } as Prisma.OrderUncheckedCreateInput,
  })
}

/** Una orden con `n` renglones de $50: lo mínimo que exigen anular y fusionar. */
async function nuevaOrdenConArticulos(n = 2, extra: Record<string, unknown> = {}) {
  const orden = await nuevaOrden({
    subtotal: new Prisma.Decimal(50 * n),
    total: new Prisma.Decimal(50 * n),
    remainingBalance: new Prisma.Decimal(50 * n),
    ...extra,
  })
  for (let i = 0; i < n; i++) {
    await prisma.orderItem.create({
      data: {
        orderId: orden.id,
        productName: `Artículo ${i + 1}`,
        quantity: 1,
        unitPrice: new Prisma.Decimal(50),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(50),
      } as Prisma.OrderItemUncheckedCreateInput,
    })
  }
  const items = await prisma.orderItem.findMany({ where: { orderId: orden.id }, select: { id: true }, orderBy: { id: 'asc' } })
  return { ...orden, itemIds: items.map(i => i.id) }
}

/** Espera a que Postgres muestre una sesión ESPERANDO un lock sobre "Order": así la prueba no depende del reloj. */
async function esperarBloqueoEnOrder() {
  for (let i = 0; i < 200; i++) {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%"Order"%'`
    if (n > 0) return
    await esperar(25)
  }
  throw new Error('Nadie quedó esperando el lock de la orden')
}

/** Una transacción que TOMA el lock de la orden y sólo termina su trabajo cuando se le suelta. */
function retenerOrden(id: string, dentro: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let soltar!: () => void
  const liberar = new Promise<void>(r => (soltar = r))
  let avisarTomado!: () => void
  const lockTomado = new Promise<void>(r => (avisarTomado = r))
  const tx = prisma.$transaction(
    async t => {
      await t.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`
      avisarTomado()
      await liberar
      await dentro(t)
    },
    { timeout: 20_000, maxWait: 10_000 },
  )
  return { lockTomado, soltar: () => soltar(), tx }
}

/** Una admisión de cobro a medio camino: crea la fila viva de la terminal cuando se le suelta. */
const admisionQueRetiene = (orderId: string) =>
  retenerOrden(orderId, t =>
    t.terminalPaymentRequest.create({
      data: {
        requestId: nextRequest(),
        venueId,
        terminalId: `${fixture}-adm-${randomUUID().slice(0, 8)}`,
        orderId,
        amountCents: 10000,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
        deliveryProvenance: { deliveries: [] },
      },
    }),
  )

/** Un registro de dinero a medio camino: pone PAID SIN subir la versión (así registra hoy un cobro con tarjeta). */
const registroQueRetiene = (orderId: string) =>
  retenerOrden(orderId, t => t.order.update({ where: { id: orderId }, data: { paymentStatus: 'PAID' } }))

function conPlazo<T>(p: Promise<T>, ms: number, mensaje: string): Promise<T> {
  return Promise.race([p, esperar(ms).then(() => Promise.reject(new Error(mensaje)))])
}

/**
 * Detiene a la RUTA dentro de su transacción, en la consulta del cobro vivo (que ya corre con el candado de la orden
 * tomado), hasta que la prueba la suelte. Si la ruta nunca consulta el cobro bajo el candado, `tomado` vence.
 */
function retenerRutaEnLaConsultaDelCobro() {
  const original = terminalPaymentService.findChargeBlockingOrderCancel.bind(terminalPaymentService)
  let soltar!: () => void
  const liberar = new Promise<void>(r => (soltar = r))
  let avisar!: () => void
  const tomado = new Promise<void>(r => (avisar = r))
  jest.spyOn(terminalPaymentService, 'findChargeBlockingOrderCancel').mockImplementationOnce(async (...args) => {
    avisar()
    await liberar
    return original(...args)
  })
  return { tomado: conPlazo(tomado, 5_000, 'La ruta nunca consultó el cobro vivo bajo el candado de la orden'), soltar: () => soltar() }
}

const resultadoDe = (p: Promise<unknown>) =>
  p.then(
    v => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  )

/** (a): la ruta espera a la admisión y después rechaza con el 409 del contrato. Devuelve el requestId bloqueador. */
async function escenarioAdmisionRetiene(orderId: string, ejecutar: () => Promise<unknown>) {
  const admision = admisionQueRetiene(orderId)
  try {
    await admision.lockTomado
    let resuelta = false
    const r = resultadoDe(ejecutar()).finally(() => (resuelta = true))
    await esperarBloqueoEnOrder()
    expect(resuelta).toBe(false) // la ruta está esperando el lock de la orden
    admision.soltar()
    await admision.tx
    const bloqueador = await prisma.terminalPaymentRequest.findFirstOrThrow({ where: { venueId, orderId }, select: { requestId: true } })
    const res = await r
    expect(res.ok).toBe(false)
    expect((res as { e: unknown }).e).toMatchObject({
      statusCode: 409,
      code: 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE',
      details: expect.objectContaining({ requestId: bloqueador.requestId }),
    })
    return bloqueador.requestId
  } finally {
    admision.soltar()
    await admision.tx.catch(() => undefined)
  }
}

/** (b): la ruta espera al registro que pone PAID y después rechaza con 400; la orden sigue PAID. */
async function escenarioRegistroRetiene(orderId: string, ejecutar: () => Promise<unknown>) {
  const registro = registroQueRetiene(orderId)
  try {
    await registro.lockTomado
    let resuelta = false
    const r = resultadoDe(ejecutar()).finally(() => (resuelta = true))
    await esperarBloqueoEnOrder()
    expect(resuelta).toBe(false)
    registro.soltar()
    await registro.tx
    const res = await r
    expect(res.ok).toBe(false)
    expect((res as { e: unknown }).e).toMatchObject({ statusCode: 400 })
    const final = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(['CANCELLED', 'DELETED']).not.toContain(final.status)
    expect(final.paymentStatus).toBe('PAID')
  } finally {
    registro.soltar()
    await registro.tx.catch(() => undefined)
  }
}

/** (c): la RUTA retiene el candado; una admisión que llega espera y después sale con 400 sin crear el cobro (sólo su lápida) ni emitir. */
async function escenarioRutaRetiene(orderId: string, ejecutar: () => Promise<unknown>) {
  const ruta = retenerRutaEnLaConsultaDelCobro()
  const r = resultadoDe(ejecutar())
  try {
    await ruta.tomado
    const requestId = nextRequest()
    let resuelta = false
    const admision = resultadoDe(
      terminalPaymentService.sendPaymentToTerminal({
        requestId,
        venueId,
        terminalId: `${fixture}-inv-${randomUUID().slice(0, 8)}`,
        amountCents: 10000,
        requestedBy: fixture,
        orderId,
      }),
    ).finally(() => (resuelta = true))
    await esperarBloqueoEnOrder()
    expect(resuelta).toBe(false) // la admisión espera el lock de la orden que tiene la ruta
    ruta.soltar()
    const resRuta = await r
    expect(resRuta.ok).toBe(true)
    const resAdm = await admision
    expect(resAdm.ok).toBe(false)
    expect((resAdm as { e: unknown }).e).toMatchObject({ statusCode: 400, code: 'ORDER_CANCELLED_NO_NEW_CHARGE', details: { requestId } })
    // Ningún cobro admitido: la única fila es la LÁPIDA del rechazo (H.5), FAILED y fuera de la ranura y del bloqueo.
    const filas = await prisma.terminalPaymentRequest.findMany({ where: { venueId, requestId } })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ status: 'FAILED', failureCode: 'REJECTED_ORDER_CANCELLED' })
    expect(directEmit).not.toHaveBeenCalled()
  } finally {
    ruta.soltar()
    await r
  }
}

const estado = async (id: string) =>
  prisma.order.findUniqueOrThrow({ where: { id }, select: { status: true, paymentStatus: true, version: true } })

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('DELETE del dashboard (deleteOrder)', () => {
  it('(a) espera a una admisión en curso y rechaza con el 409 del contrato: la orden no queda cancelada', async () => {
    const orden = await nuevaOrden()
    await escenarioAdmisionRetiene(orden.id, () => deleteOrder(venueId, orden.id))
    expect((await estado(orden.id)).status).not.toBe('CANCELLED')
  })

  it('(b) espera a un registro que pone PAID y rechaza con 400', async () => {
    const orden = await nuevaOrden()
    await escenarioRegistroRetiene(orden.id, () => deleteOrder(venueId, orden.id))
  })

  it('(c) una admisión que llega mientras el DELETE tiene el candado espera y sale con 400 sin crear fila', async () => {
    const orden = await nuevaOrden()
    await escenarioRutaRetiene(orden.id, () => deleteOrder(venueId, orden.id))
    expect((await estado(orden.id)).status).toBe('CANCELLED')
  })

  it('(d) control: sin bloqueador cancela y sube la versión (los escritores con CAS se enteran)', async () => {
    const orden = await nuevaOrden()
    await deleteOrder(venueId, orden.id)
    const final = await estado(orden.id)
    expect(final.status).toBe('CANCELLED')
    expect(final.version).toBe(orden.version + 1)
  })

  it('un pago COMPLETED con `type` nulo (legacy) cuenta como dinero: 400 y la orden no se cancela', async () => {
    const orden = await nuevaOrden()
    await prisma.payment.create({
      data: {
        venueId,
        orderId: orden.id,
        amount: new Prisma.Decimal(100),
        method: 'CASH',
        status: 'COMPLETED',
        type: null,
        feePercentage: new Prisma.Decimal(0),
        feeAmount: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(100),
      } as Prisma.PaymentUncheckedCreateInput,
    })
    await expect(deleteOrder(venueId, orden.id)).rejects.toMatchObject({ statusCode: 400 })
    expect((await estado(orden.id)).status).not.toBe('CANCELLED')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('PUT del dashboard con status CANCELLED / DELETED (updateOrder)', () => {
  it('(a) CANCELLED: espera a una admisión en curso y rechaza con el 409 del contrato', async () => {
    const orden = await nuevaOrden()
    await escenarioAdmisionRetiene(orden.id, () => updateOrder(venueId, orden.id, { status: 'CANCELLED' } as any))
    expect((await estado(orden.id)).status).not.toBe('CANCELLED')
  })

  it('(a) DELETED: la misma cancelación protegida', async () => {
    const orden = await nuevaOrden()
    await escenarioAdmisionRetiene(orden.id, () => updateOrder(venueId, orden.id, { status: 'DELETED' } as any))
    expect((await estado(orden.id)).status).not.toBe('DELETED')
  })

  it('(b) espera a un registro que pone PAID y rechaza con 400', async () => {
    const orden = await nuevaOrden()
    await escenarioRegistroRetiene(orden.id, () => updateOrder(venueId, orden.id, { status: 'CANCELLED' } as any))
  })

  it('(c) una admisión que llega mientras el PUT tiene el candado espera y sale con 400 sin crear fila', async () => {
    const orden = await nuevaOrden()
    await escenarioRutaRetiene(orden.id, () => updateOrder(venueId, orden.id, { status: 'CANCELLED' } as any))
    expect((await estado(orden.id)).status).toBe('CANCELLED')
  })

  it('(d) control: sin bloqueador cancela, sube la versión y avisa a los referidos después del commit', async () => {
    const orden = await nuevaOrden()
    const referidos = jest.spyOn(referralRefund, 'onOrderCancelled')
    await updateOrder(venueId, orden.id, { status: 'CANCELLED' } as any)
    const final = await estado(orden.id)
    expect(final.status).toBe('CANCELLED')
    expect(final.version).toBe(orden.version + 1)
    expect(referidos).toHaveBeenCalledWith({ orderId: orden.id, venueId })
  })

  it('si el status NO cambia la guarda no se activa: editar el nombre de una orden ya cancelada con un cobro vivo funciona', async () => {
    const orden = await nuevaOrden({ status: 'CANCELLED' })
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId: nextRequest(),
        venueId,
        terminalId: `${fixture}-vivo-${randomUUID().slice(0, 8)}`,
        orderId: orden.id,
        amountCents: 10000,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    const res = await updateOrder(venueId, orden.id, { status: 'CANCELLED', customerName: 'Ana' } as any)
    expect(res.customerName).toBe('Ana')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('Anular artículos en la TPV (voidItems)', () => {
  const anularTodo = (orden: { id: string; version: number; itemIds: string[] }) => () =>
    voidItems(venueId, orden.id, { itemIds: orden.itemIds, reason: 'prueba', staffId, expectedVersion: orden.version })

  it('(a) anular todo espera a una admisión en curso y rechaza con el 409 del contrato: los renglones siguen ahí', async () => {
    const orden = await nuevaOrdenConArticulos()
    await escenarioAdmisionRetiene(orden.id, anularTodo(orden))
    expect((await estado(orden.id)).status).not.toBe('CANCELLED')
    expect(await prisma.orderItem.count({ where: { orderId: orden.id } })).toBe(2)
  })

  it('(a) G2: una anulación PARCIAL con un cobro vivo también se rechaza (bajaría el total bajo el cobro)', async () => {
    const orden = await nuevaOrdenConArticulos()
    await escenarioAdmisionRetiene(orden.id, () =>
      voidItems(venueId, orden.id, { itemIds: [orden.itemIds[0]], reason: 'prueba', staffId, expectedVersion: orden.version }),
    )
    expect(await prisma.orderItem.count({ where: { orderId: orden.id } })).toBe(2)
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })).total)).toBe(100)
  })

  it('(b)/(f) anular todo mientras aterriza un pago con tarjeta que NO sube la versión: rechazo y la orden conserva PAID', async () => {
    const orden = await nuevaOrdenConArticulos()
    await escenarioRegistroRetiene(orden.id, anularTodo(orden))
    expect(await prisma.orderItem.count({ where: { orderId: orden.id } })).toBe(2)
  })

  it('(c) una admisión que llega mientras la anulación tiene el candado espera y sale con 400 sin crear fila', async () => {
    const orden = await nuevaOrdenConArticulos()
    await escenarioRutaRetiene(orden.id, anularTodo(orden))
    expect((await estado(orden.id)).status).toBe('CANCELLED')
  })

  it('(d) control: anular todo sin bloqueador cancela la orden', async () => {
    const orden = await nuevaOrdenConArticulos()
    await anularTodo(orden)()
    const final = await estado(orden.id)
    expect(final.status).toBe('CANCELLED')
    expect(final.paymentStatus).toBe('PENDING')
    expect(await prisma.orderItem.count({ where: { orderId: orden.id } })).toBe(0)
  })

  it('anular todo en una orden PARTIAL se rechaza como en cancelOrder: el dinero cobrado no se lleva a una orden cancelada', async () => {
    const orden = await nuevaOrdenConArticulos(2, { paymentStatus: 'PARTIAL', paidAmount: new Prisma.Decimal(40) })
    await expect(anularTodo(orden)()).rejects.toMatchObject({ statusCode: 400 })
    const final = await estado(orden.id)
    expect(final.status).not.toBe('CANCELLED')
    expect(final.paymentStatus).toBe('PARTIAL')
    expect(await prisma.orderItem.count({ where: { orderId: orden.id } })).toBe(2)
  })

  it('PARTIAL con lo cobrado desfasado a $0: anular todo también se rechaza (la regla PARTIAL no depende del monto)', async () => {
    const orden = await nuevaOrdenConArticulos(2, { paymentStatus: 'PARTIAL', paidAmount: new Prisma.Decimal(0) })
    await expect(anularTodo(orden)()).rejects.toMatchObject({ statusCode: 400 })
    const final = await estado(orden.id)
    expect(final.status).not.toBe('CANCELLED')
    expect(await prisma.orderItem.count({ where: { orderId: orden.id } })).toBe(2)
  })

  it('control: anular UNA parte de una orden PARTIAL sin cobro vivo sigue permitido', async () => {
    const orden = await nuevaOrdenConArticulos(2, { paymentStatus: 'PARTIAL', paidAmount: new Prisma.Decimal(40) })
    await voidItems(venueId, orden.id, { itemIds: [orden.itemIds[0]], reason: 'prueba', staffId, expectedVersion: orden.version })
    expect(await prisma.orderItem.count({ where: { orderId: orden.id } })).toBe(1)
    expect((await estado(orden.id)).paymentStatus).toBe('PARTIAL')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('Fusión de cuentas (mergeOrders)', () => {
  it('(a) espera a una admisión en curso sobre el ORIGEN y rechaza con el 409 (details con requestId y orderId del origen)', async () => {
    const destino = await nuevaOrdenConArticulos(1)
    const origen = await nuevaOrdenConArticulos(1)
    const requestId = await escenarioAdmisionRetiene(origen.id, () => mergeOrders(venueId, destino.id, origen.id))
    expect(requestId).toBeTruthy()
    expect((await estado(origen.id)).status).not.toBe('CANCELLED')
    expect(await prisma.orderItem.count({ where: { orderId: origen.id } })).toBe(1)
  })

  it('(a) el 409 de la fusión dice cuál orden tiene el cobro vivo', async () => {
    const destino = await nuevaOrdenConArticulos(1)
    const origen = await nuevaOrdenConArticulos(1)
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId: nextRequest(),
        venueId,
        terminalId: `${fixture}-vivo-${randomUUID().slice(0, 8)}`,
        orderId: origen.id,
        amountCents: 5000,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    await expect(mergeOrders(venueId, destino.id, origen.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE',
      details: expect.objectContaining({ orderId: origen.id }),
    })
  })

  it('(b) espera a un registro que pone PAID sobre el ORIGEN y rechaza con 400', async () => {
    const destino = await nuevaOrdenConArticulos(1)
    const origen = await nuevaOrdenConArticulos(1)
    await escenarioRegistroRetiene(origen.id, () => mergeOrders(venueId, destino.id, origen.id))
    expect(await prisma.orderItem.count({ where: { orderId: origen.id } })).toBe(1)
  })

  it('(c) una admisión sobre el ORIGEN que llega mientras la fusión tiene el candado espera y sale con 400', async () => {
    const destino = await nuevaOrdenConArticulos(1)
    const origen = await nuevaOrdenConArticulos(1)
    await escenarioRutaRetiene(origen.id, () => mergeOrders(venueId, destino.id, origen.id))
    expect((await estado(origen.id)).status).toBe('CANCELLED')
  })

  it('(d) control: fusiona, sube la versión del origen y avisa a los referidos del origen después del commit', async () => {
    const destino = await nuevaOrdenConArticulos(1)
    const origen = await nuevaOrdenConArticulos(1)
    const referidos = jest.spyOn(referralRefund, 'onOrderCancelled')
    await mergeOrders(venueId, destino.id, origen.id)
    const final = await estado(origen.id)
    expect(final.status).toBe('CANCELLED')
    expect(final.version).toBe(origen.version + 1)
    expect(await prisma.orderItem.count({ where: { orderId: destino.id } })).toBe(2)
    expect(referidos).toHaveBeenCalledWith({ orderId: origen.id, venueId })
  })

  it('G3: un cobro vivo en el DESTINO no bloquea la fusión (sumar a una cuenta no crea sobrepago)', async () => {
    const destino = await nuevaOrdenConArticulos(1)
    const origen = await nuevaOrdenConArticulos(1)
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId: nextRequest(),
        venueId,
        terminalId: `${fixture}-vivo-${randomUUID().slice(0, 8)}`,
        orderId: destino.id,
        amountCents: 5000,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    await mergeOrders(venueId, destino.id, origen.id)
    expect((await estado(origen.id)).status).toBe('CANCELLED')
  })

  it('(e) fusiones cruzadas A→B y B→A concurrentes: una gana, la otra sale con 400 y ninguna con interbloqueo', async () => {
    const a = await nuevaOrdenConArticulos(1)
    const b = await nuevaOrdenConArticulos(1)
    const [r1, r2] = await Promise.allSettled([mergeOrders(venueId, b.id, a.id), mergeOrders(venueId, a.id, b.id)])
    const ganadas = [r1, r2].filter(r => r.status === 'fulfilled')
    const perdidas = [r1, r2].filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(ganadas).toHaveLength(1)
    expect(perdidas).toHaveLength(1)
    const err = perdidas[0].reason as { statusCode?: number; code?: string; message?: string }
    expect(err.statusCode).toBe(400)
    expect(err.code).not.toBe('P2034')
    expect(String(err.message)).not.toMatch(/40P01|deadlock|P2034/i)
    // Nunca las dos canceladas con los renglones varados.
    const estados = await Promise.all([estado(a.id), estado(b.id)])
    expect(estados.filter(e => e.status === 'CANCELLED')).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('Checkout de vales (cancelAreaTicketCheckout)', () => {
  async function sesionDeVales() {
    const deviceUid = `${fixture}-uid-${randomUUID().slice(0, 8)}`
    const terminal = await prisma.terminal.create({
      data: {
        venueId,
        name: 'caja de vales',
        serialNumber: `${fixture}-ser-${randomUUID().slice(0, 8)}`,
        type: 'TPV_ANDROID',
        deviceUid,
        canCheckoutAreaTickets: true,
      } as Prisma.TerminalUncheckedCreateInput,
    })
    const orden = await nuevaOrden()
    const sesion = await prisma.areaTicketCheckoutSession.create({
      data: {
        venueId,
        terminalId: terminal.id,
        idempotencyKey: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        orderId: orden.id,
        status: 'MATERIALIZED',
      } as Prisma.AreaTicketCheckoutSessionUncheckedCreateInput,
    })
    const cancelar = () => cancelAreaTicketCheckout(venueId, sesion.id, { idempotencyKey: randomUUID(), deviceUid } as any)
    return { orden, sesion, cancelar }
  }

  it('(a) espera a una admisión en curso sobre la orden de la venta y rechaza con el 409: ni la venta ni la orden se cancelan', async () => {
    const { orden, sesion, cancelar } = await sesionDeVales()
    await escenarioAdmisionRetiene(orden.id, cancelar)
    expect((await estado(orden.id)).status).not.toBe('CANCELLED')
    expect((await prisma.areaTicketCheckoutSession.findUniqueOrThrow({ where: { id: sesion.id } })).status).not.toBe('CANCELLED')
  })

  it('(c) una admisión que llega mientras la cancelación de la venta tiene el candado espera y sale con 400', async () => {
    const { orden, cancelar } = await sesionDeVales()
    await escenarioRutaRetiene(orden.id, cancelar)
    expect((await estado(orden.id)).status).toBe('CANCELLED')
  })

  it('(d) control: sin bloqueador cancela la venta y su orden', async () => {
    const { orden, sesion, cancelar } = await sesionDeVales()
    await cancelar()
    expect((await estado(orden.id)).status).toBe('CANCELLED')
    expect((await prisma.areaTicketCheckoutSession.findUniqueOrThrow({ where: { id: sesion.id } })).status).toBe('CANCELLED')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('DELETE de POS-sync (processPosOrderDeleteEvent): verdad externa, no se rechaza', () => {
  const eventoDeBorrado = (externalId: string) => processPosOrderDeleteEvent({ venueId, orderData: { externalId } } as any)

  it('con un cobro vivo marca DELETED igual, pero grita 🚨 y deja ActivityLog para conciliar', async () => {
    const externalId = `sr:1:${randomUUID().slice(0, 8)}`
    const orden = await nuevaOrden({ externalId })
    const vivo = await prisma.terminalPaymentRequest.create({
      data: {
        requestId: nextRequest(),
        venueId,
        terminalId: `${fixture}-vivo-${randomUUID().slice(0, 8)}`,
        orderId: orden.id,
        amountCents: 10000,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    await eventoDeBorrado(externalId)
    expect((await estado(orden.id)).status).toBe('DELETED')
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('🚨'),
      expect.objectContaining({ orderId: orden.id, requestId: vivo.requestId }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId,
        entity: 'Order',
        entityId: orden.id,
        action: 'ORDER_DELETED_WITH_LIVE_TERMINAL_CHARGE',
        data: expect.objectContaining({ requestId: vivo.requestId }),
      }),
    )
  })

  it('(c) una admisión que llega mientras el borrado de POS-sync tiene el candado espera y sale con 400', async () => {
    const externalId = `sr:1:${randomUUID().slice(0, 8)}`
    const orden = await nuevaOrden({ externalId })
    await escenarioRutaRetiene(orden.id, () => eventoDeBorrado(externalId))
    expect((await estado(orden.id)).status).toBe('DELETED')
  })

  it('control: sin cobro vivo marca DELETED sin alarma', async () => {
    const externalId = `sr:1:${randomUUID().slice(0, 8)}`
    const orden = await nuevaOrden({ externalId })
    await eventoDeBorrado(externalId)
    expect((await estado(orden.id)).status).toBe('DELETED')
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('🚨'), expect.anything())
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Auditoría Fable 11-sep (P2-7): la cancelación de un pedido de delivery es verdad EXTERNA, igual que el borrado de
// POS-sync: no se rechaza, pero se marca bajo el candado de la orden y, si quedaba un cobro de terminal vivo, grita.
describe('Cancelación de delivery (cancelDeliveryOrder): verdad externa, no se rechaza', () => {
  const pedido = async () => {
    const externo = randomUUID().slice(0, 8)
    const orden = await nuevaOrden({ externalId: `RAPPI:${externo}`, status: 'CONFIRMED' })
    return { orden, cancelar: () => cancelDeliveryOrder(externo, 'RAPPI', 'prueba') }
  }

  it('con un cobro vivo cancela igual, pero grita 🚨 y deja ActivityLog para conciliar', async () => {
    const { orden, cancelar } = await pedido()
    const vivo = await prisma.terminalPaymentRequest.create({
      data: {
        requestId: nextRequest(),
        venueId,
        terminalId: `${fixture}-vivo-${randomUUID().slice(0, 8)}`,
        orderId: orden.id,
        amountCents: 10000,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    await expect(cancelar()).resolves.toMatchObject({ outcome: 'CANCELLED', orderId: orden.id })
    expect((await estado(orden.id)).status).toBe('CANCELLED')
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('cobro de terminal'),
      expect.objectContaining({ orderId: orden.id, requestId: vivo.requestId }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId,
        entity: 'Order',
        entityId: orden.id,
        action: 'ORDER_CANCELLED_WITH_LIVE_TERMINAL_CHARGE',
        data: expect.objectContaining({ requestId: vivo.requestId, source: 'DELIVERY', provider: 'RAPPI' }),
      }),
    )
  })

  it('(c) una admisión que llega mientras la cancelación de delivery tiene el candado espera y sale con 400', async () => {
    const { orden, cancelar } = await pedido()
    await escenarioRutaRetiene(orden.id, cancelar)
    expect((await estado(orden.id)).status).toBe('CANCELLED')
  })

  it('control: sin cobro vivo cancela sin alarma de cobro', async () => {
    const { orden, cancelar } = await pedido()
    await cancelar()
    expect((await estado(orden.id)).status).toBe('CANCELLED')
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('cobro de terminal'), expect.anything())
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Auditoría Fable 11-sep (P2-8): con dinero YA registrado, una anulación parcial no puede dejar el total por debajo de
// lo cobrado. Antes quedaba `remainingBalance = max(0, total − pagado)` sin reembolso ni alerta: un sobrepago mudo.
describe('Anular artículos por debajo de lo ya cobrado (voidItems)', () => {
  const anularUno = (orden: { id: string; version: number; itemIds: string[] }) => () =>
    voidItems(venueId, orden.id, { itemIds: [orden.itemIds[0]], reason: 'prueba', staffId, expectedVersion: orden.version })

  it('PARTIAL con $80 cobrados: anular $50 de $100 dejaría $50 < $80 ⇒ 400 ORDER_VOID_BELOW_PAID y nada cambia', async () => {
    const orden = await nuevaOrdenConArticulos(2, { paymentStatus: 'PARTIAL', paidAmount: new Prisma.Decimal(80) })
    await expect(anularUno(orden)()).rejects.toMatchObject({ statusCode: 400, code: 'ORDER_VOID_BELOW_PAID' })
    expect(await prisma.orderItem.count({ where: { orderId: orden.id } })).toBe(2)
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })).total)).toBe(100)
  })

  it('los Payment registrados cuentan aunque `Order.paidAmount` esté desfasado (estado histórico inconsistente)', async () => {
    const orden = await nuevaOrdenConArticulos(2)
    await prisma.payment.create({
      data: {
        venueId,
        orderId: orden.id,
        amount: new Prisma.Decimal(80),
        method: 'CASH',
        status: 'COMPLETED',
        feePercentage: new Prisma.Decimal(0),
        feeAmount: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(80),
      } as Prisma.PaymentUncheckedCreateInput,
    })
    await expect(anularUno(orden)()).rejects.toMatchObject({ statusCode: 400, code: 'ORDER_VOID_BELOW_PAID' })
    expect(await prisma.orderItem.count({ where: { orderId: orden.id } })).toBe(2)
  })

  it('una propina que aterriza MIENTRAS la anulación espera entra al total nuevo (la propina se relee bajo el candado)', async () => {
    // Un cobro con propina NO sube `Order.version`: el CAS no lo ve. Si el total nuevo se armara con la propina de la
    // prelectura, la cuenta perdería la propina ya cobrada y el saldo por cobrar saldría corto.
    const orden = await nuevaOrdenConArticulos(2)
    const registro = retenerOrden(orden.id, t =>
      t.order.update({
        where: { id: orden.id },
        data: {
          paymentStatus: 'PARTIAL',
          paidAmount: new Prisma.Decimal(35),
          tipAmount: new Prisma.Decimal(5),
          total: new Prisma.Decimal(105),
        },
      }),
    )
    try {
      await registro.lockTomado
      const r = resultadoDe(anularUno(orden)())
      await esperarBloqueoEnOrder()
      registro.soltar()
      await registro.tx
      const res = await r
      expect(res.ok).toBe(true)
      const final = await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })
      expect(Number(final.total)).toBe(55) // $50 que quedan + $5 de propina ya cobrada
      expect(Number(final.remainingBalance)).toBe(20) // 55 − 35
    } finally {
      registro.soltar()
      await registro.tx.catch(() => undefined)
    }
  })

  it('un registro que sube lo cobrado MIENTRAS la anulación espera el candado también la frena (relectura bajo el candado)', async () => {
    const orden = await nuevaOrdenConArticulos(2)
    const registro = retenerOrden(orden.id, t =>
      t.order.update({ where: { id: orden.id }, data: { paymentStatus: 'PARTIAL', paidAmount: new Prisma.Decimal(80) } }),
    )
    try {
      await registro.lockTomado
      const r = resultadoDe(anularUno(orden)())
      await esperarBloqueoEnOrder()
      registro.soltar()
      await registro.tx
      const res = await r
      expect(res.ok).toBe(false)
      expect((res as { e: unknown }).e).toMatchObject({ statusCode: 400, code: 'ORDER_VOID_BELOW_PAID' })
      expect(await prisma.orderItem.count({ where: { orderId: orden.id } })).toBe(2)
    } finally {
      registro.soltar()
      await registro.tx.catch(() => undefined)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Auditoría Fable 11-sep (P3-7): después del commit, las rutas que cancelan avisan ORDER_UPDATED como `cancelOrder`, para
// que las pantallas abiertas (POS, TPV, dashboard) no sigan mostrando una cuenta viva que ya no existe.
describe('Aviso en tiempo real ORDER_UPDATED después del commit', () => {
  const conAviso = () => {
    const broadcastToVenue = jest.fn()
    ;(socketManager.getBroadcastingService as jest.Mock).mockReturnValue({ broadcastToVenue })
    return broadcastToVenue
  }
  const avisoDe = (orderId: string, status: string) =>
    expect.arrayContaining([[venueId, 'order_updated', expect.objectContaining({ orderId, status })]])

  it('DELETE del dashboard', async () => {
    const orden = await nuevaOrden()
    const aviso = conAviso()
    await deleteOrder(venueId, orden.id)
    expect(aviso.mock.calls).toEqual(avisoDe(orden.id, 'CANCELLED'))
  })

  it('PUT del dashboard a DELETED', async () => {
    const orden = await nuevaOrden()
    const aviso = conAviso()
    await updateOrder(venueId, orden.id, { status: 'DELETED' } as any)
    expect(aviso.mock.calls).toEqual(avisoDe(orden.id, 'DELETED'))
  })

  it('fusión: el ORIGEN se avisa cancelado', async () => {
    const destino = await nuevaOrdenConArticulos(1)
    const origen = await nuevaOrdenConArticulos(1)
    const aviso = conAviso()
    await mergeOrders(venueId, destino.id, origen.id)
    expect(aviso.mock.calls).toEqual(avisoDe(origen.id, 'CANCELLED'))
  })

  it('checkout de vales: la orden de la venta se avisa cancelada', async () => {
    const deviceUid = `${fixture}-uid-${randomUUID().slice(0, 8)}`
    const terminal = await prisma.terminal.create({
      data: {
        venueId,
        name: 'caja de vales',
        serialNumber: `${fixture}-ser-${randomUUID().slice(0, 8)}`,
        type: 'TPV_ANDROID',
        deviceUid,
        canCheckoutAreaTickets: true,
      } as Prisma.TerminalUncheckedCreateInput,
    })
    const orden = await nuevaOrden()
    const sesion = await prisma.areaTicketCheckoutSession.create({
      data: {
        venueId,
        terminalId: terminal.id,
        idempotencyKey: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        orderId: orden.id,
        status: 'MATERIALIZED',
      } as Prisma.AreaTicketCheckoutSessionUncheckedCreateInput,
    })
    const aviso = conAviso()
    await cancelAreaTicketCheckout(venueId, sesion.id, { idempotencyKey: randomUUID(), deviceUid } as any)
    expect(aviso.mock.calls).toEqual(avisoDe(orden.id, 'CANCELLED'))
  })

  it('un rechazo NO avisa nada (el aviso va después del commit, nunca antes)', async () => {
    const orden = await nuevaOrden({ paymentStatus: 'PAID' })
    const aviso = conAviso()
    await expect(deleteOrder(venueId, orden.id)).rejects.toMatchObject({ statusCode: 400 })
    expect(aviso).not.toHaveBeenCalled()
  })
})
