/**
 * 🔴 S1 y S2 del efectivo cobrado SIN RED, contra Postgres REAL (I1–I4 del diseño, 18-oct-2026).
 *
 *   I1 · A cobra $100 sin red y lo encola; B cobra $100 en vivo y cierra; A sincroniza (PAY_CASH) ⇒ 2 Payments, $200 pagados, la
 *        venta sigue PAID con saldo 0, 1 vale de inventario (stock 10 → 9 una vez), 1 lealtad, 1 SOBREPAGO_DETECTADO y 2 movimientos
 *        de cajón. Re-mandar el lote no cambia nada. Antes: 400 «Order is already paid» y $100 fuera del sistema.
 *   I2 · Lo mismo con la venta ya REFUNDED. Antes: 409 tras 3 intentos.
 *   I3 · S2 por la ruta HTTP de la cola de las apps: B abona $50, la cola de A manda los $100 que aplicó ⇒ Payment de $100, PAID,
 *        cambio 0 y 🚨 sobrepago $50. Antes: Payment de $50 y $50 de «cambio» que nadie entregó.
 *   I4 · A y B al mismo tiempo: el dinero capturado de A nunca se pierde; el de B, o entra o se rechaza antes de tomarlo.
 */
import { randomUUID } from 'crypto'
import type { NextFunction, Request, Response } from 'express'
import { InventoryMethod, Prisma, StaffRole, Unit } from '@prisma/client'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))
// R2-6: el rastro de la mesa ajena (ActivityLog) se escribe de verdad; la configuración de integración lo deja en `jest.fn()`.
jest.mock('@/services/dashboard/activity-log.service', () => jest.requireActual('@/services/dashboard/activity-log.service'))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))
// I3: la ruta real; sólo la identidad viene de una cabecera de prueba (permiso, propiedad de mesa y servicio, reales).
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const actorId = req.get('x-test-actor')
    if (!actorId) return res.status(401).json({ success: false, message: 'Autenticación requerida' })
    const role = req.get('x-test-role') ?? 'OWNER'
    Object.assign(req, { authContext: { userId: actorId, venueId: req.params.venueId, orgId: req.params.venueId, role } })
    next()
  },
}))
jest.mock('@/middlewares/registerDevice.middleware', () => ({
  registerDeviceMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  capturarVenueDeLaRuta: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

import prisma from '@/utils/prismaClient'
import { cancelOrder, payCashOrder } from '@/services/mobile/order.mobile.service'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'

const express = require('express') as typeof import('express')
const request = require('supertest') as typeof import('supertest')
const mobileRouter = (require('@/routes/mobile.routes') as typeof import('@/routes/mobile.routes')).default
const app = express()
app.use(express.json())
app.use('/api/v1/mobile', mobileRouter)
app.use((error: { statusCode?: number; message?: string; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(error.statusCode ?? 500).json({ success: false, message: error.message, code: error.code })
})

jest.setTimeout(90_000)

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(database.pathname)) {
  throw new Error('Esta suite exige una base local DESECHABLE (avoqado_<tarea>_test_…), nunca av-db-25.')
}

const fixture = `s1s2-${randomUUID().slice(0, 8)}`
let venueId: string
let organizationId: string
let staffA: string
let staffB: string
let productId: string
let inventoryId: string
let customerId: string
let seq = 0
const deviceA = `device-A-${fixture}`

beforeAll(async () => {
  organizationId = (await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '' } })).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId, name: fixture, slug: fixture, type: 'RESTAURANT', status: 'TRIAL', timezone: 'America/Mexico_City' },
    })
  ).id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: false, requirePinLogin: false } })
  // El café va al 0 %: el negocio tiene IVA por producto encendido (como la suite de vales).
  await encenderIvaPorProducto(venueId)
  staffA = (await prisma.staff.create({ data: { email: `a-${fixture}@staff.test`, firstName: 'Caja', lastName: 'A', active: true } })).id
  staffB = (await prisma.staff.create({ data: { email: `b-${fixture}@staff.test`, firstName: 'Caja', lastName: 'B', active: true } })).id
  await prisma.staffVenue.createMany({
    data: [
      { venueId, staffId: staffA, role: StaffRole.OWNER },
      { venueId, staffId: staffB, role: StaffRole.OWNER },
    ],
  })
  await prisma.loyaltyConfig.create({ data: { venueId, active: true, pointsPerDollar: 1 } })
  customerId = (await prisma.customer.create({ data: { venueId, firstName: 'Cliente', phone: `+52557${Date.now() % 10_000_000}` } })).id
  const categoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'Barra', slug: `barra-${fixture}` } })).id
  productId = (
    await prisma.product.create({
      data: {
        venueId,
        categoryId,
        name: 'Café',
        sku: `CAFE-${fixture}`,
        price: new Prisma.Decimal(100),
        taxRate: new Prisma.Decimal(0),
        trackInventory: true,
        inventoryMethod: InventoryMethod.QUANTITY,
        unit: Unit.PIECE,
      },
    })
  ).id
  inventoryId = (await prisma.inventory.create({ data: { venueId, productId, currentStock: new Prisma.Decimal(100) } })).id
  // La caja abierta: cada cobro en efectivo deja su CASH_SALE.
  await prisma.cashDrawerSession.create({
    data: {
      venueId,
      openedByStaffId: staffA,
      openedByName: 'Caja A',
      startingAmount: new Prisma.Decimal(0),
      openedAt: new Date(Date.now() - 60_000),
    },
  })
})

afterAll(async () => {
  await prisma.$disconnect()
}) // La base es desechable: la corrida la borra entera.

const params = (intents: any[], staffId = staffA) => ({ venueId, staffId, deviceId: deviceA, intents, authorizeIntent: () => true })
const pausa = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A abre la mesa y pide UN café de $100 (con su cliente, para la lealtad). Devuelve la orden y su id local. */
async function cuentaDeA(): Promise<{ orderId: string; localOrderId: string }> {
  const table = await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 2, qrCode: randomUUID() } })
  const localOrderId = randomUUID()
  const [abierta, pedido] = await processIntents(
    params([
      { id: randomUUID(), seq: ++seq, type: 'OPEN_TABLE', payload: { tableId: table.id, covers: 1, localOrderId } },
      { id: randomUUID(), seq: ++seq, type: 'ADD_ITEMS', payload: { localOrderId, items: [{ productId, quantity: 1 }] } },
    ]),
  )
  expect([abierta.status, pedido.status]).toEqual(['ACKED', 'ACKED'])
  const orderId = String(abierta.result!.orderId)
  await prisma.order.update({ where: { id: orderId }, data: { customerId } })
  const orden = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true } })
  expect(Number(orden.total)).toBe(100)
  return { orderId, localOrderId }
}

/** El PAY_CASH que A encoló sin red: lo que su aparato aplicó (total − propina), sin el cambio. */
const payCashDeA = (localOrderId: string, amountCents: number) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'PAY_CASH' as const,
  payload: { localOrderId, amountCents, tipCents: 0, method: 'CASH' },
})

async function foto(orderId: string) {
  const [orden, pagos, vales, stock, lealtad, cajon, avisos] = await Promise.all([
    prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { paymentStatus: true, status: true, paidAmount: true, remainingBalance: true },
    }),
    prisma.payment.findMany({
      where: { venueId, orderId, status: 'COMPLETED' },
      select: { id: true, amount: true, type: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    }),
    prisma.inventoryPosting.count({ where: { venueId, sourceKind: 'ORDER', sourceId: orderId, effectKind: 'SALE' } }),
    prisma.inventory.findUniqueOrThrow({ where: { id: inventoryId }, select: { currentStock: true } }),
    prisma.loyaltyTransaction.count({ where: { orderId, type: 'EARN' } }),
    prisma.cashDrawerEvent.count({ where: { venueId, orderId, type: 'CASH_SALE' } }),
    prisma.activityLog.count({ where: { venueId, entityId: orderId, action: 'SOBREPAGO_DETECTADO' } }),
  ])
  return {
    paymentStatus: orden.paymentStatus,
    status: orden.status,
    paidAmount: Number(orden.paidAmount),
    remainingBalance: Number(orden.remainingBalance),
    cobros: pagos.filter(p => p.type !== 'REFUND').map(p => Number(p.amount)),
    vales,
    stock: Number(stock.currentStock),
    lealtad,
    cajon,
    avisos,
  }
}

/** El aviso y el cajón se escriben DESPUÉS del commit: se espera a que aparezcan (o a que pase el tiempo, si no deben). */
async function fotoAsentada(orderId: string, listo: (f: Awaited<ReturnType<typeof foto>>) => boolean) {
  for (let i = 0; i < 40; i++) {
    const f = await foto(orderId)
    if (listo(f)) break
    await pausa(50)
  }
  await pausa(200)
  return foto(orderId)
}

describe('S1 · el reenvío del efectivo sobre una venta que otra caja YA cerró', () => {
  it('🔴 I1 PAID: A encola $100, B cobra $100 en vivo, A sincroniza ⇒ $200 registrados, PAID/0, vale/lealtad UNA vez, 🚨 una vez, cajón ×2; el lote repetido no cambia nada', async () => {
    const { orderId, localOrderId } = await cuentaDeA()
    const stockInicial = (await foto(orderId)).stock
    const intentA = payCashDeA(localOrderId, 10000) // sin red: se queda en la cola de A

    await payCashOrder(venueId, orderId, { amount: 10000, tip: 0, staffId: staffB, idempotencyKey: `vivo-B-${orderId}` })
    const trasB = await fotoAsentada(orderId, f => f.cajon === 1 && f.lealtad === 1)
    expect(trasB).toMatchObject({
      paymentStatus: 'PAID',
      cobros: [100],
      vales: 1,
      stock: stockInicial - 1,
      lealtad: 1,
      cajon: 1,
      avisos: 0,
    })

    const [ack] = await processIntents(params([intentA]))

    expect(ack).toMatchObject({
      status: 'ACKED',
      result: expect.objectContaining({ amount: 10000, changeCents: 0, orderPaymentStatus: 'PAID', remainingBalanceCents: 0 }),
    })
    const trasA = await fotoAsentada(orderId, f => f.avisos === 1 && f.cajon === 2)
    expect(trasA).toEqual({
      paymentStatus: 'PAID',
      status: 'COMPLETED',
      paidAmount: 200,
      remainingBalance: 0,
      cobros: [100, 100],
      vales: 1,
      stock: stockInicial - 1,
      lealtad: 1,
      cajon: 2,
      avisos: 1,
    })

    // La cola reenvía el MISMO lote (la respuesta se perdió): nada cambia.
    const [repetido] = await processIntents(params([intentA]))
    expect([repetido.status, repetido.result?.paymentId]).toEqual(['ACKED', ack.result?.paymentId])
    expect(await fotoAsentada(orderId, () => false)).toEqual(trasA)
  })

  it('🔴 I2 REFUNDED: B cobra $100 y lo devuelve; A sincroniza sus $100 ⇒ se registran y la venta SIGUE REFUNDED con saldo 0, sin volver a descontar', async () => {
    const { orderId, localOrderId } = await cuentaDeA()
    const intentA = payCashDeA(localOrderId, 10000)
    const cobroB = await payCashOrder(venueId, orderId, { amount: 10000, tip: 0, staffId: staffB, idempotencyKey: `vivo-B-${orderId}` })
    await issueRefund({
      venueId,
      paymentId: cobroB.paymentId,
      amount: 10000,
      tipRefundCents: 0,
      reason: 'CUSTOMER_REQUEST' as never,
      staffId: staffB,
    })
    // Hoy un reembolso deja la venta PAID (no reabre); REFUNDED es como la dejaba el código viejo (R13-4) y la que el diseño cubre.
    await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'REFUNDED' } })
    const devuelta = await fotoAsentada(orderId, f => f.cajon === 1)
    expect(devuelta.paymentStatus).toBe('REFUNDED')

    const [ack] = await processIntents(params([intentA]))

    expect(ack).toMatchObject({
      status: 'ACKED',
      result: expect.objectContaining({ amount: 10000, changeCents: 0, orderPaymentStatus: 'PAID' }),
    })
    const trasA = await fotoAsentada(orderId, f => f.avisos === 1)
    expect(trasA).toMatchObject({
      paymentStatus: 'REFUNDED',
      remainingBalance: 0,
      cobros: [100, 100],
      vales: devuelta.vales,
      stock: devuelta.stock,
      lealtad: devuelta.lealtad,
      cajon: devuelta.cajon + 1,
      avisos: 1,
    })
  })
})

describe('S2 · el reenvío registra lo que el aparato aplicó', () => {
  it('🔴 I3 por la ruta HTTP de la cola: B abona $50, la cola de A manda sus $100 ⇒ Payment de $100, PAID, cambio 0, 🚨 $50; el reintento devuelve el mismo pago', async () => {
    const { orderId } = await cuentaDeA()
    await payCashOrder(venueId, orderId, { amount: 5000, tip: 0, staffId: staffB, idempotencyKey: `abono-B-${orderId}` })
    const llave = randomUUID()
    const cuerpo = { amount: 10000, tip: 0, idempotencyKey: llave, isOfflineReplay: true }

    const res = await request(app).post(`/api/v1/mobile/venues/${venueId}/orders/${orderId}/pay`).set('x-test-actor', staffA).send(cuerpo)

    expect(res.status).toBe(200)
    expect(res.body.payment).toMatchObject({ amount: 10000, changeCents: 0, orderPaymentStatus: 'PAID', remainingBalanceCents: 0 })
    const tras = await fotoAsentada(orderId, f => f.avisos === 1)
    expect(tras).toMatchObject({ paymentStatus: 'PAID', paidAmount: 150, cobros: [50, 100], vales: 1, lealtad: 1, avisos: 1 })
    const aviso = await prisma.activityLog.findFirstOrThrow({ where: { venueId, entityId: orderId, action: 'SOBREPAGO_DETECTADO' } })
    expect(aviso.data).toMatchObject({ overpaidBy: 50, wasAlreadyPaid: false })

    const reintento = await request(app)
      .post(`/api/v1/mobile/venues/${venueId}/orders/${orderId}/pay`)
      .set('x-test-actor', staffA)
      .send(cuerpo)
    expect([reintento.status, reintento.body.payment.paymentId, reintento.body.payment.changeCents]).toEqual([
      200,
      res.body.payment.paymentId,
      0,
    ])
    expect(await fotoAsentada(orderId, () => false)).toEqual(tras)
  })

  it('control: el efectivo EN VIVO de $100 sobre $50 abonados sigue registrando $50 y devolviendo $50 de cambio, sin aviso', async () => {
    const { orderId } = await cuentaDeA()
    await payCashOrder(venueId, orderId, { amount: 5000, tip: 0, staffId: staffB, idempotencyKey: `abono-B-${orderId}` })
    const r = await payCashOrder(venueId, orderId, { amount: 10000, tip: 0, staffId: staffA, idempotencyKey: `vivo-A-${orderId}` })
    expect([r.amount, r.changeCents, r.orderPaymentStatus]).toEqual([5000, 5000, 'PAID'])
    expect(await fotoAsentada(orderId, () => false)).toMatchObject({ cobros: [50, 50], avisos: 0 })
  })
})

describe('I4 · A y B al mismo tiempo', () => {
  it('🔴 el reenvío de A y el cobro en vivo de B simultáneos ⇒ los $100 de A siempre quedan; B entra o se rechaza antes de tomar el dinero; efectos UNA vez', async () => {
    const { orderId, localOrderId } = await cuentaDeA()
    const stockInicial = (await foto(orderId)).stock
    const intentA = payCashDeA(localOrderId, 10000)

    const [deA, deB] = await Promise.allSettled([
      processIntents(params([intentA])),
      payCashOrder(venueId, orderId, { amount: 10000, tip: 0, staffId: staffB, idempotencyKey: `vivo-B-${orderId}` }),
    ])

    expect(deA.status).toBe('fulfilled')
    expect((deA as PromiseFulfilledResult<any>).value[0].status).toBe('ACKED')
    const entroB = deB.status === 'fulfilled'
    if (!entroB) expect((deB as PromiseRejectedResult).reason.message).toBe('Order is already paid')
    const tras = await fotoAsentada(orderId, f => f.cajon === (entroB ? 2 : 1) && f.lealtad === 1)
    expect(tras).toMatchObject({
      paymentStatus: 'PAID',
      remainingBalance: 0,
      cobros: entroB ? [100, 100] : [100],
      paidAmount: entroB ? 200 : 100,
      vales: 1,
      stock: stockInicial - 1,
      lealtad: 1,
      cajon: entroB ? 2 : 1,
      avisos: entroB ? 1 : 0,
    })
  })
})

/**
 * 🔴 Ronda 2 de S1/S2 contra Postgres REAL (revisiones de ceba0df1f).
 *   I5 · R2-1: la cola HTTP de Android/Windows ≤ 2.23 (H1: manda el TOTAL de la cuenta, no su parte) se porta como antes de S1/S2.
 *   I6 · R2-2: una venta REFUNDED que después se canceló recibe el reenvío y NO se reabre.
 *   I7 · R2-6: Ana cobró sin red, un encargado pasó la mesa a Beto: el dinero se registra a nombre de Ana con rastro de la mesa ajena.
 */
const llaveHttp = () => randomUUID()
const pagar = (orderId: string, actor: string, cuerpo: Record<string, unknown>, cabeceras: Record<string, string> = {}) => {
  const r = request(app).post(`/api/v1/mobile/venues/${venueId}/orders/${orderId}/pay`).set('x-test-actor', actor)
  for (const [k, v] of Object.entries(cabeceras)) r.set(k, v)
  return r.send(cuerpo)
}

describe('I5 · R2-1: la cola HTTP de Android/Windows ≤ 2.23 (H1)', () => {
  const android223 = { 'x-device-platform': 'ANDROID', 'x-app-version': '2.23.0' }

  it('🔴 cuenta $100 en 2×$50: B abona $50 y la cola 2.23 de A manda el TOTAL ($100) ⇒ $50 registrados y $50 de cambio, PAID, sin aviso (S2 registraba $100: faltante falso de $50)', async () => {
    const { orderId } = await cuentaDeA()
    await payCashOrder(venueId, orderId, { amount: 5000, tip: 0, staffId: staffB, idempotencyKey: `abono-B-${orderId}` })

    const res = await pagar(orderId, staffA, { amount: 10000, tip: 0, idempotencyKey: llaveHttp(), isOfflineReplay: true }, android223)

    expect(res.status).toBe(200)
    expect(res.body.payment).toMatchObject({ amount: 5000, changeCents: 5000, orderPaymentStatus: 'PAID', remainingBalanceCents: 0 })
    expect(await fotoAsentada(orderId, f => f.cajon === 2)).toMatchObject({
      paymentStatus: 'PAID',
      paidAmount: 100,
      cobros: [50, 50],
      cajon: 2,
      avisos: 0,
    })
  })

  it('🔴 Windows 2.23.0-escritorio sobre una venta YA PAID ⇒ 400 como antes y nada se escribe (S1 registraba $100 de más)', async () => {
    const { orderId } = await cuentaDeA()
    await payCashOrder(venueId, orderId, { amount: 10000, tip: 0, staffId: staffB, idempotencyKey: `vivo-B-${orderId}` })
    const antes = await fotoAsentada(orderId, f => f.cajon === 1 && f.lealtad === 1)

    const res = await pagar(
      orderId,
      staffA,
      { amount: 10000, tip: 0, idempotencyKey: llaveHttp(), isOfflineReplay: true },
      { 'x-device-platform': 'ANDROID', 'x-app-version': '2.23.0-escritorio' },
    )

    expect([res.status, res.body.message]).toEqual([400, 'Order is already paid'])
    expect(await fotoAsentada(orderId, () => false)).toEqual(antes)
  })

  it('control: la MISMA cola desde Android 2.24.0 sigue con S2 ($100 registrados y 🚨 $50)', async () => {
    const { orderId } = await cuentaDeA()
    await payCashOrder(venueId, orderId, { amount: 5000, tip: 0, staffId: staffB, idempotencyKey: `abono-B-${orderId}` })

    const res = await pagar(
      orderId,
      staffA,
      { amount: 10000, tip: 0, idempotencyKey: llaveHttp(), isOfflineReplay: true },
      { 'x-device-platform': 'ANDROID', 'x-app-version': '2.24.0' },
    )

    expect([res.status, res.body.payment.amount, res.body.payment.changeCents]).toEqual([200, 10000, 0])
    expect(await fotoAsentada(orderId, f => f.avisos === 1)).toMatchObject({ cobros: [50, 100], avisos: 1 })
  })
})

describe('I6 · R2-2: recibir dinero nunca reabre una venta cerrada', () => {
  it('🔴 B cobra $100, lo devuelve y cancela la cuenta; A sincroniza sus $100 ⇒ se registran, sigue CANCELLED/REFUNDED con saldo 0, 🚨, sin reabrirse (antes: PENDING + ORDER_REOPENED_BY_CAPTURED_PAYMENT)', async () => {
    const { orderId, localOrderId } = await cuentaDeA()
    const intentA = payCashDeA(localOrderId, 10000)
    const cobroB = await payCashOrder(venueId, orderId, { amount: 10000, tip: 0, staffId: staffB, idempotencyKey: `vivo-B-${orderId}` })
    await issueRefund({
      venueId,
      paymentId: cobroB.paymentId,
      amount: 10000,
      tipRefundCents: 0,
      reason: 'CUSTOMER_REQUEST' as never,
      staffId: staffB,
    })
    // Como la dejaba el código viejo (R13-4); el guard de cancelación deja cancelar una REFUNDED.
    await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'REFUNDED' } })
    await cancelOrder(venueId, orderId, 'cancelada después del reembolso', staffB)
    const cancelada = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, paymentStatus: true } })
    expect(cancelada).toEqual({ status: 'CANCELLED', paymentStatus: 'REFUNDED' })

    const [ack] = await processIntents(params([intentA]))

    expect(ack).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ amount: 10000, orderPaymentStatus: 'PAID' }) })
    const tras = await fotoAsentada(orderId, f => f.avisos === 1)
    expect(tras).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', remainingBalance: 0, cobros: [100, 100], avisos: 1 })
    expect(await prisma.activityLog.count({ where: { venueId, entityId: orderId, action: 'ORDER_REOPENED_BY_CAPTURED_PAYMENT' } })).toBe(0)
  })
})

/**
 * 🔴 Ronda 4 contra Postgres real:
 *   · R4-3: la propina SOLA ($0 + $50) de la cola sin red es dinero: el reducer la registra (antes: INVALID_PAYLOAD en cuarentena).
 *   · R4-2: una venta de $100 + $16 de IVA aparte, devuelta y cancelada, que recibe dinero capturado sigue CANCELLED/REFUNDED, pero
 *     guarda el total de cuando se cobró (base + IVA): $166 con la propina de $50 (antes $150 y 🚨 sobrepago falso de $16), y con $10
 *     de más guarda $116 y el aviso mide sobre esos MISMOS $116.
 */
describe('R4 · la cancelada ya cobrada con IVA aparte y la propina sola', () => {
  async function devueltaYCanceladaConIvaAparte() {
    const { orderId, localOrderId } = await cuentaDeA()
    await prisma.order.update({
      where: { id: orderId },
      data: { contratoDePrecio: 'IVA_APARTE', taxAmount: 16, total: 116, remainingBalance: 116 },
    })
    const cobroB = await payCashOrder(venueId, orderId, { amount: 11600, tip: 0, staffId: staffB, idempotencyKey: `vivo-B-${orderId}` })
    await issueRefund({
      venueId,
      paymentId: cobroB.paymentId,
      amount: 11600,
      tipRefundCents: 0,
      reason: 'CUSTOMER_REQUEST' as never,
      staffId: staffB,
    })
    await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'REFUNDED' } })
    await cancelOrder(venueId, orderId, 'cancelada después del reembolso', staffB)
    const cancelada = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, paymentStatus: true, total: true },
    })
    expect([cancelada.status, cancelada.paymentStatus, Number(cancelada.total)]).toEqual(['CANCELLED', 'REFUNDED', 116])
    return { orderId, localOrderId }
  }
  const totalGuardado = async (orderId: string) =>
    Number((await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true } })).total)
  const avisosDe = (orderId: string) =>
    prisma.activityLog.findMany({ where: { venueId, entityId: orderId, action: 'SOBREPAGO_DETECTADO' }, select: { data: true }, take: 5 })

  it('🔴 R4-3 + R4-2: la propina sola de la cola ⇒ ACKED; sigue CANCELLED/REFUNDED con total $166 y sin sobrepago falso', async () => {
    const { orderId, localOrderId } = await devueltaYCanceladaConIvaAparte()

    const [ack] = await processIntents(
      params([
        { id: randomUUID(), seq: ++seq, type: 'PAY_CASH', payload: { localOrderId, amountCents: 0, tipCents: 5000, method: 'CASH' } },
      ]),
    )

    expect(ack).toMatchObject({ status: 'ACKED' })
    const tras = await fotoAsentada(orderId, () => false)
    expect(tras).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', remainingBalance: 0, avisos: 0 })
    expect(await totalGuardado(orderId)).toBe(166)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: orderId, action: 'ORDER_REOPENED_BY_CAPTURED_PAYMENT' } })).toBe(0)
  })

  it('🔴 R4-2: $10 de más ⇒ total $116 guardado y el aviso mide sobre los MISMOS $116 (sobrepago real de $10)', async () => {
    const { orderId, localOrderId } = await devueltaYCanceladaConIvaAparte()

    const [ack] = await processIntents(params([payCashDeA(localOrderId, 1000)]))

    expect(ack).toMatchObject({ status: 'ACKED' })
    await fotoAsentada(orderId, f => f.avisos === 1)
    expect(await totalGuardado(orderId)).toBe(116)
    expect((await avisosDe(orderId)).map(a => a.data)).toEqual([
      expect.objectContaining({ orderTotal: 116, totalPaid: 126, overpaidBy: 10 }),
    ])
  })
})

describe('I7 · R2-6: dinero capturado en una mesa que reasignaron', () => {
  let ana: string
  let beto: string
  beforeAll(async () => {
    ana = (await prisma.staff.create({ data: { email: `ana-${fixture}@staff.test`, firstName: 'Ana', lastName: 'Mesera', active: true } }))
      .id
    beto = (
      await prisma.staff.create({ data: { email: `beto-${fixture}@staff.test`, firstName: 'Beto', lastName: 'Mesero', active: true } })
    ).id
    await prisma.staffVenue.createMany({
      data: [
        { venueId, staffId: ana, role: StaffRole.WAITER },
        { venueId, staffId: beto, role: StaffRole.WAITER },
      ],
    })
  })
  /** La mesa de Ana, ya pasada a Beto por un encargado, con la propiedad de mesa encendida. */
  async function mesaPasadaABeto() {
    const { orderId } = await cuentaDeA()
    await prisma.order.update({ where: { id: orderId }, data: { servedById: beto } })
    return orderId
  }
  const marcas = (orderId: string) =>
    prisma.activityLog.findMany({
      where: { venueId, entityId: orderId, action: 'CAPTURED_PAYMENT_ON_FOREIGN_TABLE' },
      select: { staffId: true, data: true },
      take: 5,
    })
  async function marcasAsentadas(orderId: string, n: number) {
    for (let i = 0; i < 40 && (await marcas(orderId)).length < n; i++) await pausa(50)
    await pausa(200)
    return marcas(orderId)
  }
  const conPropiedad = async (prueba: () => Promise<void>) => {
    await prisma.venueSettings.update({ where: { venueId }, data: { enforceTableOwnership: true } })
    try {
      await prueba()
    } finally {
      await prisma.venueSettings.update({ where: { venueId }, data: { enforceTableOwnership: false } })
    }
  }

  it('🔴 PAY_CASH de Ana ⇒ ACKED, Payment de $100 a nombre de Ana, la mesa sigue de Beto y queda el rastro (antes: REJECTED TABLE_OWNED_BY_OTHER y $100 fuera)', async () => {
    await conPropiedad(async () => {
      const orderId = await mesaPasadaABeto()

      const [ack] = await processIntents(
        params(
          [{ id: randomUUID(), seq: ++seq, type: 'PAY_CASH', payload: { orderId, amountCents: 10000, tipCents: 0, method: 'CASH' } }],
          ana,
        ),
      )

      expect(ack).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ amount: 10000 }) })
      const pagos = await prisma.payment.findMany({ where: { venueId, orderId }, select: { processedById: true, amount: true }, take: 5 })
      expect(pagos.map(p => [p.processedById, Number(p.amount)])).toEqual([[ana, 100]])
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { servedById: true } })).servedById).toBe(beto)
      expect(await marcasAsentadas(orderId, 1)).toEqual([
        { staffId: ana, data: expect.objectContaining({ tableOwnerId: beto, tableOwnerName: 'Beto Mesero' }) },
      ])
    })
  })

  it('🔴 por la ruta HTTP: el cobro EN VIVO de Ana sigue con 403; su cola (isOfflineReplay) ⇒ 200 con el rastro (antes: 403 también)', async () => {
    await conPropiedad(async () => {
      const orderId = await mesaPasadaABeto()

      const vivo = await request(app)
        .post(`/api/v1/mobile/venues/${venueId}/orders/${orderId}/pay`)
        .set('x-test-actor', ana)
        .set('x-test-role', 'WAITER')
        .send({ amount: 10000, tip: 0, idempotencyKey: llaveHttp() })
      expect([vivo.status, vivo.body.code]).toEqual([403, 'TABLE_OWNED_BY_OTHER'])

      const enCola = await request(app)
        .post(`/api/v1/mobile/venues/${venueId}/orders/${orderId}/pay`)
        .set('x-test-actor', ana)
        .set('x-test-role', 'WAITER')
        .send({ amount: 10000, tip: 0, idempotencyKey: llaveHttp(), isOfflineReplay: true })
      expect([enCola.status, enCola.body.payment?.amount]).toEqual([200, 10000])
      const pagos = await prisma.payment.findMany({ where: { venueId, orderId }, select: { processedById: true }, take: 5 })
      expect(pagos.map(p => p.processedById)).toEqual([ana])
      expect(await marcasAsentadas(orderId, 1)).toEqual([{ staffId: ana, data: expect.objectContaining({ tableOwnerId: beto }) }])
    })
  })

  // 🔴 R3-1 (Codex r2, P2): $0 + $0 NO es dinero capturado. Cuenta de Beto de $100 con $100 de descuento (saldo $0): la llave nueva
  // de Ana con $0 cerraba la mesa ajena (PAID, inventario, mesa libre). Conserva el rechazo de antes; Beto sí la cierra.
  it('🔴 R3-1: cuenta ajena en $0 ⇒ el $0 + $0 de Ana se rechaza por HTTP (403) y por el reducer (TABLE_OWNED_BY_OTHER); Beto sí la cierra', async () => {
    await conPropiedad(async () => {
      const orderId = await mesaPasadaABeto()
      await prisma.order.update({ where: { id: orderId }, data: { discountAmount: 100, total: 0, remainingBalance: 0 } })

      const http = await request(app)
        .post(`/api/v1/mobile/venues/${venueId}/orders/${orderId}/pay`)
        .set('x-test-actor', ana)
        .set('x-test-role', 'WAITER')
        .send({ amount: 0, tip: 0, idempotencyKey: llaveHttp(), isOfflineReplay: true })
      expect([http.status, http.body.code]).toEqual([403, 'TABLE_OWNED_BY_OTHER'])

      const [ack] = await processIntents(
        params(
          [{ id: randomUUID(), seq: ++seq, type: 'PAY_CASH', payload: { orderId, amountCents: 0, tipCents: 0, method: 'CASH' } }],
          ana,
        ),
      )
      expect(ack).toMatchObject({ status: 'REJECTED', errorCode: 'TABLE_OWNED_BY_OTHER' })
      expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(0)
      expect(
        await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, paymentStatus: true } }),
      ).not.toMatchObject({
        paymentStatus: 'PAID',
      })

      const [deBeto] = await processIntents(
        params(
          [{ id: randomUUID(), seq: ++seq, type: 'PAY_CASH', payload: { orderId, amountCents: 0, tipCents: 0, method: 'CASH' } }],
          beto,
        ),
      )
      expect(deBeto).toMatchObject({ status: 'ACKED' })
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { paymentStatus: true } })).paymentStatus).toBe('PAID')
      expect(await marcas(orderId)).toEqual([])
    })
  })

  it('R3-1: la cola de Ana reenviada con la MISMA llave sobre la mesa ajena sigue idempotente: un Payment y una sola marca', async () => {
    await conPropiedad(async () => {
      const orderId = await mesaPasadaABeto()
      const idempotencyKey = llaveHttp()
      const enviar = () =>
        request(app)
          .post(`/api/v1/mobile/venues/${venueId}/orders/${orderId}/pay`)
          .set('x-test-actor', ana)
          .set('x-test-role', 'WAITER')
          .send({ amount: 10000, tip: 0, idempotencyKey, isOfflineReplay: true })

      const primero = await enviar()
      const segundo = await enviar()
      expect([primero.status, segundo.status]).toEqual([200, 200])
      expect(segundo.body.payment?.paymentId).toBe(primero.body.payment?.paymentId)
      expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(1)
      expect(await marcasAsentadas(orderId, 2)).toHaveLength(1)
    })
  })

  // 🔴 R4-1 (Codex r3, P2): Ana cerró su cuenta cortesiada de $0 con la llave K; la respuesta se perdió y un encargado pasó la mesa a
  // Beto. El reintento con K es la MISMA operación: con R3-1 recibía 403 antes de mirar la llave. Una llave nueva de $0 sigue en 403.
  it('🔴 R4-1: el reintento HTTP de $0 con una llave que YA tiene pago ⇒ 200 con el MISMO pago y sin rastro; una llave nueva de $0 sigue 403', async () => {
    await conPropiedad(async () => {
      const { orderId } = await cuentaDeA()
      await prisma.order.update({ where: { id: orderId }, data: { servedById: ana, discountAmount: 100, total: 0, remainingBalance: 0 } })
      const K = llaveHttp()
      const enviar = (idempotencyKey: string) =>
        request(app)
          .post(`/api/v1/mobile/venues/${venueId}/orders/${orderId}/pay`)
          .set('x-test-actor', ana)
          .set('x-test-role', 'WAITER')
          .send({ amount: 0, tip: 0, idempotencyKey })

      const primero = await enviar(K)
      expect(primero.status).toBe(200)
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { paymentStatus: true } })).paymentStatus).toBe('PAID')
      await prisma.order.update({ where: { id: orderId }, data: { servedById: beto } })

      const reintento = await enviar(K)
      expect(reintento.status).toBe(200)
      expect(reintento.body.payment?.paymentId).toBe(primero.body.payment?.paymentId)
      expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(1)

      const nueva = await enviar(llaveHttp())
      expect([nueva.status, nueva.body.code]).toEqual([403, 'TABLE_OWNED_BY_OTHER'])
      expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(1)
      expect(await marcas(orderId)).toEqual([])
    })
  })

  // 🔴 R4-4 (Codex r3, P2 E): una fracción de centavo se guarda como $0.00: no abre el pase de mesa ajena (HTTP ni reducer).
  it('🔴 R4-4: cuenta ajena en $0 ⇒ 0.001 ¢ de Ana se rechaza por HTTP (403) y por el reducer (TABLE_OWNED_BY_OTHER); nada se escribe', async () => {
    await conPropiedad(async () => {
      const orderId = await mesaPasadaABeto()
      await prisma.order.update({ where: { id: orderId }, data: { discountAmount: 100, total: 0, remainingBalance: 0 } })

      const http = await request(app)
        .post(`/api/v1/mobile/venues/${venueId}/orders/${orderId}/pay`)
        .set('x-test-actor', ana)
        .set('x-test-role', 'WAITER')
        .send({ amount: 0.001, tip: 0, idempotencyKey: llaveHttp(), isOfflineReplay: true })
      expect([http.status, http.body.code]).toEqual([403, 'TABLE_OWNED_BY_OTHER'])

      const [ack] = await processIntents(
        params(
          [{ id: randomUUID(), seq: ++seq, type: 'PAY_CASH', payload: { orderId, amountCents: 0.001, tipCents: 0, method: 'CASH' } }],
          ana,
        ),
      )
      expect(ack).toMatchObject({ status: 'REJECTED', errorCode: 'TABLE_OWNED_BY_OTHER' })
      expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(0)
    })
  })
})
