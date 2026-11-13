/**
 * D12 (cuenta abierta sin red) · lo que el plan da por hecho del SERVIDOR, contra Postgres REAL. Pruebas de CARACTERIZACIÓN:
 * (b)–(f) fijan lo que el servidor YA hace (no hay código nuevo); (a) usa los campos de la Tarea 1.
 *   a · paridad: el saldo de la fila de `listOrders` == `getOrder().preBillBalance`
 *   b · copia vieja: el primer envío de $100 sobre una cuenta que ya vale $300 ⇒ PARTIAL, saldo $200, sin 🚨
 *   c · cancelada: el efectivo capturado la REABRE (se documenta, no se cambia)
 *   d · D19 heredado (AJENO): un abono devuelto no vuelve a deberse
 *   e · juntar: el efectivo de la cuenta absorbida no se pierde
 *   f · el primer envío con su caja ya cerrada queda APARTE (regla S3), no en la caja nueva
 */
import { randomUUID } from 'crypto'
import type { NextFunction, Request, Response } from 'express'
import { Prisma, StaffRole } from '@prisma/client'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
  broadcastTpvStatusUpdate: jest.fn(),
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkFeatureAccess.middleware'),
  hasFeatureAccess: jest.fn().mockResolvedValue({ hasAccess: true }),
}))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))
// Las rutas reales; sólo la identidad viene de una cabecera de prueba (permiso, validador y servicio, reales).
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
import { addItemsToOrder } from '@/services/tpv/order.tpv.service'
import { cancelOrder, getOrder, listOrders, mergeOrders, payCashOrder } from '@/services/mobile/order.mobile.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'

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

/** Un negocio por prueba, con turnos y caja, y un producto de $50. Sin limpieza: la base se borra al terminar. */
async function negocio() {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const organizationId = (
    await prisma.organization.create({ data: { name: `Tardia ${s}`, email: `tardia-${s}@example.com`, phone: '5555555555' } })
  ).id
  const venueId = (await prisma.venue.create({ data: { organizationId, name: `Tardia ${s}`, slug: `tardia-${s}`, seatCapExempt: true } }))
    .id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: true, requirePinLogin: false } })
  const staffId = (
    await prisma.staff.create({ data: { email: `tardia-${s}@staff.test`, firstName: 'Caja', lastName: 'Tardia', active: true } })
  ).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: StaffRole.OWNER } })
  const categoryId = (await prisma.menuCategory.create({ data: { venueId, name: `Cat ${s}`, slug: `cat-${s}` } })).id
  const productId = (
    await prisma.product.create({
      data: { venueId, categoryId, sku: `SKU-${randomUUID()}`, name: `Café ${s}`, price: new Prisma.Decimal(50) },
    })
  ).id
  return { venueId, staffId, productId, como: { 'x-test-actor': staffId } }
}

type Negocio = Awaited<ReturnType<typeof negocio>>

const abrirCaja = async (n: Negocio, fondo: number) => {
  const r = await request(app)
    .post(`/api/v1/mobile/venues/${n.venueId}/cash-drawer/open`)
    .set(n.como)
    .send({ startingAmount: fondo, deviceName: 'Aparato 2', localId: randomUUID() })
  expect([200, 201]).toContain(r.status)
  const caja = await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: r.body.data.id } })
  expect(caja.shiftId).not.toBeNull()
  return { cajaId: caja.id, turnoId: caja.shiftId as string }
}

const cerrarCaja = async (n: Negocio, cajaId: string, contado: number) => {
  const r = await request(app)
    .post(`/api/v1/mobile/venues/${n.venueId}/cash-drawer/close`)
    .set(n.como)
    .send({ actualAmount: contado, sessionId: cajaId })
  expect(r.status).toBe(200)
}

const rutaPay = (n: Negocio, orderId: string) => `/api/v1/mobile/venues/${n.venueId}/orders/${orderId}/pay`

/** Una cuenta de Mostrador de $100 sin mesa (dos cafés de $50), como la abre el POS. */
async function cuentaDe100(n: Negocio): Promise<string> {
  const creada = await request(app)
    .post(`/api/v1/mobile/venues/${n.venueId}/orders`)
    .set(n.como)
    .send({ staffId: n.staffId, orderType: 'TAKEOUT', items: [{ productId: n.productId, quantity: 2 }] })
  expect(creada.status).toBe(201)
  const orderId = creada.body.order.id as string
  expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).total)).toBe(100)
  return orderId
}

const abono = (n: Negocio, orderId: string, centavos: number, extra: Record<string, unknown> = {}) =>
  payCashOrder(n.venueId, orderId, { amount: centavos, tip: 0, staffId: n.staffId, idempotencyKey: `abono-${randomUUID()}`, ...extra })

const filaDeLista = async (n: Negocio, orderId: string) => {
  const { data } = await listOrders(n.venueId, { page: 1, pageSize: 50 })
  return data.find(o => o.id === orderId)
}

const rastro = (n: Negocio, orderId: string, action: string) =>
  prisma.activityLog.findMany({ where: { venueId: n.venueId, entityId: orderId, action }, take: 5 })

describe('D12 · lo que el servidor da por hecho', () => {
  it('(a) paridad: abono de $40 ⇒ la fila de la lista trae saldo 6000 y es igual a preBillBalance', async () => {
    const n = await negocio()
    const orderId = await cuentaDe100(n)
    await abono(n, orderId, 4000)

    const fila = await filaDeLista(n, orderId)
    const detalle = await getOrder(n.venueId, orderId)

    expect(fila?.saldoPendienteCents).toBe(6000)
    expect(fila?.saldoPendienteCents).toBe(detalle.preBillBalance?.remainingBalanceCents)
    expect(fila?.pagosCompletados).toBe(1)
    expect(fila?.esDeVales).toBe(false)
  })

  it('(b) copia vieja: la cuenta ya vale $300 y llega el primer envío de $100 ⇒ PARTIAL, saldo $200, sin 🚨', async () => {
    const n = await negocio()
    const caja = await abrirCaja(n, 0)
    const orderId = await cuentaDe100(n)
    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })
    await addItemsToOrder(n.venueId, orderId, [{ productId: n.productId, quantity: 4 }], version, true)
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).total)).toBe(300)

    const res = await request(app)
      .post(rutaPay(n, orderId))
      .set(n.como)
      .send({ amount: 10000, tip: 0, idempotencyKey: randomUUID(), isOfflineReplay: true, cashDrawerSessionId: caja.cajaId })

    expect(res.status).toBe(200)
    expect(res.body.payment).toMatchObject({
      remainingBalanceCents: 20000,
      orderPaymentStatus: 'PARTIAL',
      orderTotalCents: 30000,
      totalPaidCents: 10000,
    })
    expect(await rastro(n, orderId, 'SOBREPAGO_DETECTADO')).toHaveLength(0)
  })

  it('(c) cancelada: el efectivo de $100 capturado la REABRE, con su rastro (se documenta, no se cambia)', async () => {
    const n = await negocio()
    const orderId = await cuentaDe100(n)
    await cancelOrder(n.venueId, orderId, 'prueba', n.staffId)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')

    const res = await request(app)
      .post(rutaPay(n, orderId))
      .set(n.como)
      .send({ amount: 10000, tip: 0, idempotencyKey: randomUUID(), isOfflineReplay: true })

    expect(res.status).toBe(200)
    expect(await prisma.payment.count({ where: { venueId: n.venueId, orderId } })).toBe(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).not.toBe('CANCELLED')
    expect(await rastro(n, orderId, 'ORDER_REOPENED_BY_CAPTURED_PAYMENT')).toHaveLength(1)
  })

  it('(d) D19 (12-nov): un abono de $40 devuelto completo vuelve a deberse: la lista dice que faltan los $100', async () => {
    const n = await negocio()
    const orderId = await cuentaDe100(n)
    const cobro = await abono(n, orderId, 4000)
    await issueRefund({
      venueId: n.venueId,
      paymentId: cobro.paymentId,
      amount: 4000,
      tipRefundCents: 0,
      reason: 'CUSTOMER_REQUEST' as never,
      staffId: n.staffId,
    })

    // Antes de D19 decía 6000: el abono devuelto seguía contando como cobrado.
    expect((await filaDeLista(n, orderId))?.saldoPendienteCents).toBe(10000)
  })

  it('(e) juntar: el efectivo sobre la cuenta ABSORBIDA se acepta y deja rastro (el dinero no se pierde)', async () => {
    const n = await negocio()
    const destino = await cuentaDe100(n)
    const origen = await cuentaDe100(n)
    await mergeOrders(n.venueId, destino, origen, n.staffId)

    const res = await request(app)
      .post(rutaPay(n, origen))
      .set(n.como)
      .send({ amount: 10000, tip: 0, idempotencyKey: randomUUID(), isOfflineReplay: true })

    expect(res.status).toBe(200)
    expect(await prisma.payment.count({ where: { venueId: n.venueId, orderId: origen, status: 'COMPLETED' } })).toBe(1)
    const avisos =
      (await rastro(n, origen, 'SOBREPAGO_DETECTADO')).length + (await rastro(n, origen, 'ORDER_REOPENED_BY_CAPTURED_PAYMENT')).length
    expect(avisos).toBeGreaterThan(0)
  })

  it('(f) el primer envío con su caja C1 ya cerrada contada y C2 abierta ⇒ 200, queda APARTE (sin turno), C2 intacta', async () => {
    const n = await negocio()
    const c1 = await abrirCaja(n, 1000)
    const orderId = await cuentaDe100(n)
    await cerrarCaja(n, c1.cajaId, 1000)
    const c2 = await abrirCaja(n, 500)

    const res = await request(app)
      .post(rutaPay(n, orderId))
      .set(n.como)
      .send({ amount: 10000, tip: 0, idempotencyKey: randomUUID(), isOfflineReplay: true, cashDrawerSessionId: c1.cajaId })

    expect(res.status).toBe(200)
    const pago = await prisma.payment.findUniqueOrThrow({ where: { id: res.body.payment.paymentId } })
    expect(pago.shiftId).toBeNull()
    expect(pago.shiftId).not.toBe(c2.turnoId)
    expect(await prisma.cashDrawerEvent.count({ where: { sessionId: c2.cajaId, type: 'CASH_SALE' } })).toBe(0)
    expect(Number((await prisma.shift.findUniqueOrThrow({ where: { id: c2.turnoId } })).totalSales)).toBe(0)
  })
})

afterAll(async () => {
  await prisma.$disconnect()
})
