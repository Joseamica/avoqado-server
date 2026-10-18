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
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))
// I3: la ruta real; sólo la identidad viene de una cabecera de prueba (permiso, propiedad de mesa y servicio, reales).
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const actorId = req.get('x-test-actor')
    if (!actorId) return res.status(401).json({ success: false, message: 'Autenticación requerida' })
    Object.assign(req, { authContext: { userId: actorId, venueId: req.params.venueId, orgId: req.params.venueId, role: 'OWNER' } })
    next()
  },
}))
jest.mock('@/middlewares/registerDevice.middleware', () => ({
  registerDeviceMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  capturarVenueDeLaRuta: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

import prisma from '@/utils/prismaClient'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
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

const params = (intents: any[]) => ({ venueId, staffId: staffA, deviceId: deviceA, intents, authorizeIntent: () => true })
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
