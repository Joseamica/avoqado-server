/**
 * 🔴 DINERO — «Cobrar sin red» (S5, D4): una venta tardía NUNCA se mezcla en silencio con el turno nuevo. Contra Postgres REAL y
 * por HTTP, con los validadores reales: el de `/tpv` reemplaza el cuerpo con lo que su esquema Zod declara, así que un campo sin
 * declarar se borraría y la prueba de servicio seguiría verde.
 *
 * El recorrido: la terminal vende sin red en el turno A; otro aparato cierra A y abre B; la terminal sube su cola con
 * `shiftIdDeLaVenta = A`. La orden y el pago quedan SIN turno, B no suma nada, y queda `PAYMENT_WITHOUT_SHIFT` con motivo
 * `SALE_SHIFT_CLOSED` (sólo si el negocio usa turnos). El cobro en línea, que no manda el campo, queda como hoy.
 *
 * Correr (base desechable, nunca av-db-25):
 *   node scripts/run-with-launch-campaigns-test-db.cjs npx jest --selectProjects integration --runInBand \
 *     --runTestsByPath tests/integration/payments/turnoDeLaVenta.integration.test.ts
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
import { CashDrawerReconcilerJob, defaults as barridoReal } from '@/jobs/cash-drawer-reconciler.job'
import { getShifts, readShiftPaymentsForClose } from '@/services/tpv/shift.tpv.service'

const express = require('express') as typeof import('express')
const request = require('supertest') as typeof import('supertest')
const mobileRouter = (require('@/routes/mobile.routes') as typeof import('@/routes/mobile.routes')).default
const tpvRouter = (require('@/routes/tpv.routes') as typeof import('@/routes/tpv.routes')).default
const app = express()
app.use(express.json())
app.use('/api/v1/mobile', mobileRouter)
app.use('/api/v1/tpv', tpvRouter)
app.use((error: { statusCode?: number; message?: string; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(error.statusCode ?? 500).json({ success: false, message: error.message, code: error.code })
})

jest.setTimeout(90_000)

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(database.pathname)) {
  throw new Error('Esta suite exige una base local DESECHABLE (avoqado_<tarea>_test_…), nunca av-db-25.')
}

/** Un negocio por prueba: el turno A ya lo cerró otro aparato y B es el vivo. Sin limpieza: la base se borra al terminar. */
async function negocio({ enableShifts = true } = {}) {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const organizationId = (
    await prisma.organization.create({ data: { name: `Turno ${s}`, email: `turno-${s}@example.com`, phone: '5555555555' } })
  ).id
  const venueId = (await prisma.venue.create({ data: { organizationId, name: `Turno ${s}`, slug: `turno-${s}`, seatCapExempt: true } })).id
  await prisma.venueSettings.create({ data: { venueId, enableShifts, requirePinLogin: false } })
  const staffId = (
    await prisma.staff.create({ data: { email: `turno-${s}@staff.test`, firstName: 'Caja', lastName: 'Turno', active: true } })
  ).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: StaffRole.OWNER } })
  const categoryId = (await prisma.menuCategory.create({ data: { venueId, name: `Cat ${s}`, slug: `cat-${s}` } })).id
  const productId = (
    await prisma.product.create({
      data: { venueId, categoryId, sku: `SKU-${randomUUID()}`, name: `Café ${s}`, price: new Prisma.Decimal(50) },
    })
  ).id
  const hace = (horas: number) => new Date(Date.now() - horas * 3_600_000)
  const turnoA = (
    await prisma.shift.create({ data: { venueId, staffId, startTime: hace(3), endTime: hace(1), status: 'CLOSED', closedById: staffId } })
  ).id
  const turnoB = (await prisma.shift.create({ data: { venueId, staffId, startTime: hace(1), status: 'OPEN' } })).id
  return { venueId, staffId, productId, turnoA, turnoB, hace, como: { 'x-test-actor': staffId } }
}

type Negocio = Awaited<ReturnType<typeof negocio>>

const crearOrden = (n: Negocio, extra: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/mobile/venues/${n.venueId}/orders`)
    .set(n.como)
    .send({
      staffId: n.staffId,
      source: 'TPV',
      orderType: 'TAKEOUT',
      externalId: `venta-${randomUUID()}`,
      isOfflineReplay: true,
      items: [{ productId: n.productId, quantity: 2 }],
      ...extra,
    })

const pagarEnMobile = (n: Negocio, orderId: string, extra: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/mobile/venues/${n.venueId}/orders/${orderId}/pay`)
    .set(n.como)
    .send({ amount: 10000, tip: 0, staffId: n.staffId, idempotencyKey: `cobro-${randomUUID()}`, isOfflineReplay: true, ...extra })

/** Cuerpo de efectivo de `/tpv` (centavos), como lo manda la terminal. */
const cobroDeTerminal = (n: Negocio, extra: Record<string, unknown>) => ({
  venueId: n.venueId,
  amount: 5000,
  tip: 0,
  status: 'COMPLETED',
  method: 'CASH',
  source: 'TPV',
  splitType: 'FULLPAYMENT',
  staffId: n.staffId,
  paidProductsId: [],
  currency: 'MXN',
  idempotencyKey: `cobro-${randomUUID()}`,
  ...extra,
})

const conciliaciones = (venueId: string) =>
  prisma.activityLog.findMany({ where: { venueId, action: 'PAYMENT_WITHOUT_SHIFT' }, orderBy: { createdAt: 'asc' }, take: 10 })

const totalesDe = async (shiftId: string) => {
  const t = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
  return { totalSales: Number(t.totalSales), totalOrders: t.totalOrders }
}

afterAll(async () => {
  await prisma.$disconnect()
})

describe('turno de la venta (shiftIdDeLaVenta) — por HTTP y contra Postgres', () => {
  it('1. mobile: orden y pago con el turno A cerrado ⇒ los dos sin turno, B intacto y PAYMENT_WITHOUT_SHIFT SALE_SHIFT_CLOSED', async () => {
    const n = await negocio()

    const creada = await crearOrden(n, { shiftIdDeLaVenta: n.turnoA })
    expect(creada.status).toBe(201)
    const orderId = creada.body.order.id
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).shiftId).toBeNull()

    const pagada = await pagarEnMobile(n, orderId, { shiftIdDeLaVenta: n.turnoA })
    expect(pagada.status).toBe(200)
    const pago = await prisma.payment.findUniqueOrThrow({ where: { id: pagada.body.payment.paymentId } })
    expect(pago.shiftId).toBeNull()
    expect(await totalesDe(n.turnoB)).toEqual({ totalSales: 0, totalOrders: 0 })

    const filas = await conciliaciones(n.venueId)
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ entity: 'Payment', entityId: pago.id })
    expect(filas[0].data).toMatchObject({
      status: 'PENDING',
      reason: 'SALE_SHIFT_CLOSED',
      saleShiftId: n.turnoA,
      candidateShiftId: n.turnoB,
      channel: 'payCashOrder',
      orderId,
      totalPesos: '100.00',
    })
  })

  it('2. mobile: con el turno de la venta = el vivo ⇒ como hoy (orden y pago en B, B suma, sin conciliación)', async () => {
    const n = await negocio()

    const creada = await crearOrden(n, { shiftIdDeLaVenta: n.turnoB })
    expect(creada.status).toBe(201)
    const orderId = creada.body.order.id
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).shiftId).toBe(n.turnoB)

    const pagada = await pagarEnMobile(n, orderId, { shiftIdDeLaVenta: n.turnoB })
    expect(pagada.status).toBe(200)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pagada.body.payment.paymentId } })).shiftId).toBe(n.turnoB)
    expect(await totalesDe(n.turnoB)).toEqual({ totalSales: 100, totalOrders: 1 })
    expect(await conciliaciones(n.venueId)).toHaveLength(0)
  })

  it('3. /tpv/fast: la cola con el turno A ⇒ orden y pago sin turno + conciliación; en línea con el `shiftId` viejo ⇒ como hoy (B)', async () => {
    const n = await negocio()

    const deLaCola = cobroDeTerminal(n, { isOfflineReplay: true, shiftIdDeLaVenta: n.turnoA })
    const subida = await request(app).post(`/api/v1/tpv/venues/${n.venueId}/fast`).set(n.como).send(deLaCola)
    expect(subida.status).toBe(201)
    const pagoDeLaCola = await prisma.payment.findUniqueOrThrow({
      where: { venueId_idempotencyKey: { venueId: n.venueId, idempotencyKey: deLaCola.idempotencyKey } },
      include: { order: { select: { shiftId: true } } },
    })
    expect(pagoDeLaCola.shiftId).toBeNull()
    expect(pagoDeLaCola.order?.shiftId).toBeNull()
    expect(await totalesDe(n.turnoB)).toEqual({ totalSales: 0, totalOrders: 0 })
    const filas = await conciliaciones(n.venueId)
    expect(filas).toHaveLength(1)
    expect(filas[0].data).toMatchObject({ reason: 'SALE_SHIFT_CLOSED', saleShiftId: n.turnoA, channel: 'recordFastPayment' })

    // El cobro EN LÍNEA no manda `shiftIdDeLaVenta`; el `shiftId` que la terminal ya manda no se reinterpreta.
    const enLinea = cobroDeTerminal(n, { shiftId: n.turnoA })
    expect((await request(app).post(`/api/v1/tpv/venues/${n.venueId}/fast`).set(n.como).send(enLinea)).status).toBe(201)
    const pagoEnLinea = await prisma.payment.findUniqueOrThrow({
      where: { venueId_idempotencyKey: { venueId: n.venueId, idempotencyKey: enLinea.idempotencyKey } },
      include: { order: { select: { shiftId: true } } },
    })
    expect(pagoEnLinea.shiftId).toBe(n.turnoB)
    expect(pagoEnLinea.order?.shiftId).toBe(n.turnoB)
    expect(await totalesDe(n.turnoB)).toEqual({ totalSales: 50, totalOrders: 1 })
    expect(await conciliaciones(n.venueId)).toHaveLength(1)
  })

  it('4. /tpv/orders/:orderId: la cola con el turno A ⇒ pago sin turno + conciliación, B intacto', async () => {
    const n = await negocio()
    const creada = await crearOrden(n, { shiftIdDeLaVenta: n.turnoA })
    expect(creada.status).toBe(201)
    const orderId = creada.body.order.id

    const deLaCola = cobroDeTerminal(n, { amount: 10000, isOfflineReplay: true, shiftIdDeLaVenta: n.turnoA })
    const subida = await request(app).post(`/api/v1/tpv/venues/${n.venueId}/orders/${orderId}`).set(n.como).send(deLaCola)
    expect(subida.status).toBe(201)

    const pago = await prisma.payment.findUniqueOrThrow({
      where: { venueId_idempotencyKey: { venueId: n.venueId, idempotencyKey: deLaCola.idempotencyKey } },
    })
    expect(pago.shiftId).toBeNull()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).shiftId).toBeNull()
    expect(await totalesDe(n.turnoB)).toEqual({ totalSales: 0, totalOrders: 0 })
    const filas = await conciliaciones(n.venueId)
    expect(filas).toHaveLength(1)
    expect(filas[0].data).toMatchObject({ reason: 'SALE_SHIFT_CLOSED', saleShiftId: n.turnoA, channel: 'recordOrderPayment' })
  })

  it('5. negocio sin turnos (enableShifts=false): la venta tardía queda sin turno y SIN conciliación', async () => {
    const n = await negocio({ enableShifts: false })

    const creada = await crearOrden(n, { shiftIdDeLaVenta: n.turnoA })
    expect(creada.status).toBe(201)
    const pagada = await pagarEnMobile(n, creada.body.order.id, { shiftIdDeLaVenta: n.turnoA })
    expect(pagada.status).toBe(200)

    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pagada.body.payment.paymentId } })).shiftId).toBeNull()
    expect(await conciliaciones(n.venueId)).toHaveLength(0)
  })

  it('6. sin isOfflineReplay el campo se ignora (mobile y /tpv): como hoy, en B y sin conciliación', async () => {
    const n = await negocio()

    const creada = await crearOrden(n, { isOfflineReplay: false, shiftIdDeLaVenta: n.turnoA })
    expect(creada.status).toBe(201)
    const orderId = creada.body.order.id
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).shiftId).toBe(n.turnoB)
    const pagada = await pagarEnMobile(n, orderId, { isOfflineReplay: false, shiftIdDeLaVenta: n.turnoA })
    expect(pagada.status).toBe(200)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pagada.body.payment.paymentId } })).shiftId).toBe(n.turnoB)

    const rapido = cobroDeTerminal(n, { shiftIdDeLaVenta: n.turnoA })
    expect((await request(app).post(`/api/v1/tpv/venues/${n.venueId}/fast`).set(n.como).send(rapido)).status).toBe(201)
    const pagoRapido = await prisma.payment.findUniqueOrThrow({
      where: { venueId_idempotencyKey: { venueId: n.venueId, idempotencyKey: rapido.idempotencyKey } },
    })
    expect(pagoRapido.shiftId).toBe(n.turnoB)
    expect(await conciliaciones(n.venueId)).toHaveLength(0)
  })

  // 🔴 Revisión de S5 #1: el efectivo de la venta tardía ya lo contó el cajón del turno A (cerrado). Si entrara al cajón abierto de
  // B, el cierre de B firmaría un faltante falso; si entrara al de A, recalcularía su corte firmado (fuera de este bloque).
  it('7. el efectivo de la venta tardía NO entra a ningún cajón (ni en línea ni por el barrido); el cobro en línea sí entra a B', async () => {
    const n = await negocio()
    const cajaA = await prisma.cashDrawerSession.create({
      data: {
        venueId: n.venueId,
        shiftId: n.turnoA,
        openedByStaffId: n.staffId,
        openedByName: 'Caja Turno',
        openedAt: n.hace(3),
        closedAt: n.hace(1),
        status: 'CLOSED',
        startingAmount: new Prisma.Decimal(0),
      },
    })
    const cajaB = await prisma.cashDrawerSession.create({
      data: {
        venueId: n.venueId,
        shiftId: n.turnoB,
        openedByStaffId: n.staffId,
        openedByName: 'Caja Turno',
        openedAt: n.hace(1),
        status: 'OPEN',
        startingAmount: new Prisma.Decimal(0),
      },
    })
    const ventasEnCaja = (sessionId: string) => prisma.cashDrawerEvent.count({ where: { sessionId, type: 'CASH_SALE' } })

    // Las tres puertas de la cola, con el turno A.
    const creada = await crearOrden(n, { shiftIdDeLaVenta: n.turnoA })
    const pagada = await pagarEnMobile(n, creada.body.order.id, { shiftIdDeLaVenta: n.turnoA })
    expect(pagada.status).toBe(200)
    const rapido = cobroDeTerminal(n, { isOfflineReplay: true, shiftIdDeLaVenta: n.turnoA })
    expect((await request(app).post(`/api/v1/tpv/venues/${n.venueId}/fast`).set(n.como).send(rapido)).status).toBe(201)
    const otraOrden = await crearOrden(n, { shiftIdDeLaVenta: n.turnoA })
    const deOrden = cobroDeTerminal(n, { amount: 10000, isOfflineReplay: true, shiftIdDeLaVenta: n.turnoA })
    expect(
      (await request(app).post(`/api/v1/tpv/venues/${n.venueId}/orders/${otraOrden.body.order.id}`).set(n.como).send(deOrden)).status,
    ).toBe(201)

    const tardios = await prisma.payment.findMany({
      where: { venueId: n.venueId, shiftId: null },
      select: { id: true, posRawData: true },
      take: 10,
    })
    expect(tardios).toHaveLength(3)
    for (const p of tardios) expect(p.posRawData).toMatchObject({ ventaDeTurnoCerrado: n.turnoA })
    expect(await ventasEnCaja(cajaB.id)).toBe(0)

    // Control: un cobro EN LÍNEA sí entra al cajón de B (la prueba podría ver un CASH_SALE).
    const enLinea = cobroDeTerminal(n, {})
    expect((await request(app).post(`/api/v1/tpv/venues/${n.venueId}/fast`).set(n.como).send(enLinea)).status).toBe(201)
    expect(await ventasEnCaja(cajaB.id)).toBe(1)

    // El barrido de respaldo, ya pasado su margen: no adopta las tardías (las tres caen en la ventana de B, sin turno).
    // 🔴 El barrido es GLOBAL y las suites del mismo proceso comparten la base (runner desechable y CI): lo reparable de OTRA
    // suite (efectivoSinRed inserta a mano una devolución en efectivo sin cajón) entraba en `reposted` y esta prueba fallaba
    // según el orden de las suites. Se usa el SQL real y sólo se miran (y se reponen) las filas de este negocio.
    const deEsteNegocio = <T extends { venueId: string }>(filas: T[]) => filas.filter(f => f.venueId === n.venueId)
    const barrido = new CashDrawerReconcilerJob({
      cron: { start: () => undefined, stop: () => undefined },
      now: () => new Date(Date.now() + 5 * 60_000),
      findUnpostedCashPayments: async (...a) => deEsteNegocio(await barridoReal.findUnpostedCashPayments(...a)),
      findUnpostedCashRefunds: async (...a) => deEsteNegocio(await barridoReal.findUnpostedCashRefunds(...a)),
    })
    const resultado = await barrido.runNow()
    // `scanned` 0: el SQL ni siquiera levanta las marcadas (si lo hiciera, el posteo las frenaría y `reposted` no lo vería).
    expect(resultado.scanned).toBe(0)
    expect(resultado.reposted).toBe(0)
    expect(await ventasEnCaja(cajaB.id)).toBe(1)
    expect(await ventasEnCaja(cajaA.id)).toBe(0)
  })

  // 🔴 Codex servidor r1 #1: con `shiftIdDeLaVenta: "NO-EXISTE"` un cajero sacaba su efectivo del arqueo (el pago quedaba sin turno
  // y marcado, y el cajón no lo sumaba). Un id que no es turno de ESTE negocio se ignora: todo como hoy, en B y en el cajón de B.
  it('8. turno de la venta inventado o de OTRO negocio ⇒ se ignora: orden, pago y cajón en el turno vivo, sin conciliación', async () => {
    const n = await negocio()
    const otro = await negocio()
    const cajaB = await prisma.cashDrawerSession.create({
      data: {
        venueId: n.venueId,
        shiftId: n.turnoB,
        openedByStaffId: n.staffId,
        openedByName: 'Caja Turno',
        openedAt: n.hace(1),
        status: 'OPEN',
        startingAmount: new Prisma.Decimal(0),
      },
    })

    for (const pedido of ['NO-EXISTE', otro.turnoA]) {
      const creada = await crearOrden(n, { shiftIdDeLaVenta: pedido })
      expect(creada.status).toBe(201)
      expect((await prisma.order.findUniqueOrThrow({ where: { id: creada.body.order.id } })).shiftId).toBe(n.turnoB)
      const pagada = await pagarEnMobile(n, creada.body.order.id, { shiftIdDeLaVenta: pedido })
      expect(pagada.status).toBe(200)
      const pago = await prisma.payment.findUniqueOrThrow({ where: { id: pagada.body.payment.paymentId } })
      expect(pago.shiftId).toBe(n.turnoB)
      expect(pago.posRawData).toBeNull()

      const rapido = cobroDeTerminal(n, { isOfflineReplay: true, shiftIdDeLaVenta: pedido })
      expect((await request(app).post(`/api/v1/tpv/venues/${n.venueId}/fast`).set(n.como).send(rapido)).status).toBe(201)
      const pagoRapido = await prisma.payment.findUniqueOrThrow({
        where: { venueId_idempotencyKey: { venueId: n.venueId, idempotencyKey: rapido.idempotencyKey } },
      })
      expect(pagoRapido.shiftId).toBe(n.turnoB)
    }

    expect(await totalesDe(n.turnoB)).toEqual({ totalSales: 300, totalOrders: 4 })
    expect(await conciliaciones(n.venueId)).toHaveLength(0)
    expect(await prisma.cashDrawerEvent.count({ where: { sessionId: cajaB.id, type: 'CASH_SALE' } })).toBe(4)
  })

  // 🔴 Codex servidor r1 #2: la terminal creó la orden EN LÍNEA creyendo seguir en A (otro aparato ya había cerrado A y abierto B), el
  // servidor la puso en B y la respuesta se perdió; el pago sube por la cola con A. Manda el turno que el servidor le dio a la orden.
  it('9. orden creada en línea en B + pago de la cola con A ⇒ el pago va a B (como su orden), sin marca ni conciliación', async () => {
    const n = await negocio()

    const creada = await crearOrden(n, { isOfflineReplay: false })
    expect(creada.status).toBe(201)
    const orderId = creada.body.order.id
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).shiftId).toBe(n.turnoB)

    const pagada = await pagarEnMobile(n, orderId, { shiftIdDeLaVenta: n.turnoA })
    expect(pagada.status).toBe(200)
    const pago = await prisma.payment.findUniqueOrThrow({ where: { id: pagada.body.payment.paymentId } })
    expect(pago.shiftId).toBe(n.turnoB)
    expect(pago.posRawData).toBeNull()
    expect(await totalesDe(n.turnoB)).toEqual({ totalSales: 100, totalOrders: 1 })
    expect(await conciliaciones(n.venueId)).toHaveLength(0)
  })

  // 🔴 Codex servidor r1 #2 (la otra mitad): el cierre adopta los cobros SIN turno de una orden del turno. Una venta tardía marcada
  // nunca entra así a un corte, ni a la lista de turnos; un huérfano sin marca (con o sin datos de tarjeta) sí, como hoy.
  it('10. el cierre y la lista de turnos nunca adoptan un cobro marcado como venta de turno cerrado', async () => {
    const n = await negocio()
    const orden = await prisma.order.create({
      data: { venueId: n.venueId, shiftId: n.turnoB, orderNumber: `B-${randomUUID()}`, subtotal: 60, total: 60, taxAmount: 0 },
    })
    const cobro = (monto: number, posRawData?: Prisma.InputJsonValue) =>
      prisma.payment.create({
        data: {
          venueId: n.venueId,
          orderId: orden.id,
          amount: new Prisma.Decimal(monto),
          tipAmount: new Prisma.Decimal(0),
          method: 'CASH',
          status: 'COMPLETED',
          shiftId: null,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: new Prisma.Decimal(monto),
          ...(posRawData === undefined ? {} : { posRawData }),
        },
      })
    const marcado = await cobro(40, { ventaDeTurnoCerrado: n.turnoA })
    const sinDatos = await cobro(10)
    const conTarjeta = await cobro(10, { cardBrand: 'VISA' })

    const delCierre = await readShiftPaymentsForClose(n.venueId, n.turnoB, n.hace(1), new Date())
    expect(delCierre.map(p => p.id).sort()).toEqual([sinDatos.id, conTarjeta.id].sort())
    expect(delCierre.map(p => p.id)).not.toContain(marcado.id)

    const lista = await getShifts(n.venueId, 10, 1)
    expect(lista.data.find((t: { id: string }) => t.id === n.turnoB)?.paymentSum).toBe(20)
  })
})
