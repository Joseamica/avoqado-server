/**
 * Lealtad — la venta que la terminal sube de su cola sin red queda fechada a la hora en que se VENDIÓ (`Order.loyaltySaleAt`), no a
 * la de su llegada: el tope de sellos del día y las promociones miden el día de la venta. Misma regla que el POS (`horaDeLaVenta`):
 * nunca después de la llegada. Por HTTP con los validadores reales (el de `/tpv` borra lo que su esquema no declara) y contra
 * Postgres REAL. Sin `createdAtLocal` (terminal vieja), en línea, o con basura: como hoy (`loyaltySaleAt` null, cobro 201).
 *
 * Correr (base desechable, nunca av-db-25):
 *   node scripts/run-with-launch-campaigns-test-db.cjs npx jest --selectProjects integration --runInBand \
 *     --runTestsByPath tests/integration/payments/horaDeLaVentaTpv.integration.test.ts
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

/** Un negocio por prueba, sin turnos. Sin limpieza: la base se borra al terminar. */
async function negocio() {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const organizationId = (
    await prisma.organization.create({ data: { name: `Hora ${s}`, email: `hora-${s}@example.com`, phone: '5555555555' } })
  ).id
  const venueId = (await prisma.venue.create({ data: { organizationId, name: `Hora ${s}`, slug: `hora-${s}`, seatCapExempt: true } })).id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: false, requirePinLogin: false } })
  const staffId = (
    await prisma.staff.create({ data: { email: `hora-${s}@staff.test`, firstName: 'Caja', lastName: 'Hora', active: true } })
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

/** Sube un cobro rápido y devuelve la orden FAST que creó. */
async function rapido(n: Negocio, extra: Record<string, unknown>) {
  const cuerpo = cobroDeTerminal(n, extra)
  const r = await request(app).post(`/api/v1/tpv/venues/${n.venueId}/fast`).set(n.como).send(cuerpo)
  expect(r.status).toBe(201)
  const pago = await prisma.payment.findUniqueOrThrow({
    where: { venueId_idempotencyKey: { venueId: n.venueId, idempotencyKey: cuerpo.idempotencyKey } },
    include: { order: { select: { loyaltySaleAt: true, loyaltyEligibleAt: true } } },
  })
  return pago.order!
}

/** Una cuenta abierta de `piezas` × $50, creada en línea por el POS. */
async function cuenta(n: Negocio, piezas: number) {
  const creada = await request(app)
    .post(`/api/v1/mobile/venues/${n.venueId}/orders`)
    .set(n.como)
    .send({
      staffId: n.staffId,
      source: 'TPV',
      orderType: 'TAKEOUT',
      externalId: `venta-${randomUUID()}`,
      items: [{ productId: n.productId, quantity: piezas }],
    })
  expect(creada.status).toBe(201)
  return creada.body.order.id as string
}

/**
 * Codex r1 #1: cuenta de $200. La terminal A cobra $100 sin red a las 23:55 (CDMX); la caja B cobra los otros $100 EN LÍNEA a las
 * 00:05. A sube después y SALDA: la venta es de las 00:05 (cuando de verdad quedó pagada), nunca de las 23:55 del día anterior.
 * La hora de B se fija en la base para que el cruce de medianoche sea exacto.
 */
async function partidaCruzandoMedianoche(n: Negocio, pagarB: (orderId: string) => Promise<string>) {
  const orderId = await cuenta(n, 4)
  const paymentIdB = await pagarB(orderId)
  const b = new Date(Date.now() - 2 * 3_600_000)
  await prisma.payment.update({ where: { id: paymentIdB }, data: { createdAt: b } })
  return { orderId, b, a: b.getTime() - 10 * 60_000 }
}

afterAll(async () => {
  await prisma.$disconnect()
})

describe('hora de la venta de la cola de la terminal (loyaltySaleAt) — por HTTP y contra Postgres', () => {
  it('1. /tpv/fast de la cola: la hora que capturó la terminal (número o texto de dígitos)', async () => {
    const n = await negocio()
    const anoche = Date.now() - 10 * 3_600_000

    const comoNumero = await rapido(n, { isOfflineReplay: true, createdAtLocal: anoche })
    expect(comoNumero.loyaltySaleAt).toEqual(new Date(anoche))
    expect(comoNumero.loyaltyEligibleAt!.getTime()).toBeGreaterThan(anoche)

    const comoTexto = await rapido(n, { isOfflineReplay: true, createdAtLocal: String(anoche + 1) })
    expect(comoTexto.loyaltySaleAt).toEqual(new Date(anoche + 1))
  })

  it('2. reloj de la terminal adelantado: nunca después de la llegada', async () => {
    const n = await negocio()
    const antes = Date.now()

    const orden = await rapido(n, { isOfflineReplay: true, createdAtLocal: antes + 86_400_000 })

    expect(orden.loyaltySaleAt!.getTime()).toBeGreaterThanOrEqual(antes)
    expect(orden.loyaltySaleAt!.getTime()).toBeLessThanOrEqual(orden.loyaltyEligibleAt!.getTime())
  })

  it('3. como hoy: terminal vieja (sin campo), en línea (sin isOfflineReplay) y basura ⇒ 201 y loyaltySaleAt null', async () => {
    const n = await negocio()

    expect((await rapido(n, { isOfflineReplay: true })).loyaltySaleAt).toBeNull()
    expect((await rapido(n, { createdAtLocal: Date.now() - 3_600_000 })).loyaltySaleAt).toBeNull()
    const conBasura = await rapido(n, { isOfflineReplay: true, createdAtLocal: { ayer: true } })
    expect(conBasura.loyaltySaleAt).toBeNull()
    expect(conBasura.loyaltyEligibleAt).not.toBeNull()
  })

  it('4. /tpv/orders/:orderId de la cola (Mesas): la cuenta saldada guarda la hora de la venta', async () => {
    const n = await negocio()
    const orderId = await cuenta(n, 2)
    const anoche = Date.now() - 10 * 3_600_000

    const subida = await request(app)
      .post(`/api/v1/tpv/venues/${n.venueId}/orders/${orderId}`)
      .set(n.como)
      .send(cobroDeTerminal(n, { amount: 10000, isOfflineReplay: true, createdAtLocal: anoche }))
    expect(subida.status).toBe(201)

    const orden = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(orden.paymentStatus).toBe('PAID')
    expect(orden.loyaltyEligibleAt).not.toBeNull()
    expect(orden.loyaltySaleAt).toEqual(new Date(anoche))
  })

  it('5. /tpv/orders partida: A sin red 23:55 + B en línea 00:05 ⇒ la venta es de las 00:05', async () => {
    const n = await negocio()
    const { orderId, b, a } = await partidaCruzandoMedianoche(n, async id => {
      const enLinea = cobroDeTerminal(n, { amount: 10000 })
      expect((await request(app).post(`/api/v1/tpv/venues/${n.venueId}/orders/${id}`).set(n.como).send(enLinea)).status).toBe(201)
      return (
        await prisma.payment.findUniqueOrThrow({
          where: { venueId_idempotencyKey: { venueId: n.venueId, idempotencyKey: enLinea.idempotencyKey } },
        })
      ).id
    })

    const subida = await request(app)
      .post(`/api/v1/tpv/venues/${n.venueId}/orders/${orderId}`)
      .set(n.como)
      .send(cobroDeTerminal(n, { amount: 10000, isOfflineReplay: true, createdAtLocal: a }))
    expect(subida.status).toBe(201)

    const orden = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(orden.paymentStatus).toBe('PAID')
    expect(orden.loyaltySaleAt).toEqual(b)
  })

  it('6. POS (mobile /pay) partida: la misma regla que la terminal', async () => {
    const n = await negocio()
    const pagar = (id: string, extra: Record<string, unknown>) =>
      request(app)
        .post(`/api/v1/mobile/venues/${n.venueId}/orders/${id}/pay`)
        .set(n.como)
        .send({ amount: 10000, tip: 0, staffId: n.staffId, idempotencyKey: `cobro-${randomUUID()}`, ...extra })
    const { orderId, b, a } = await partidaCruzandoMedianoche(n, async id => {
      const r = await pagar(id, {})
      expect(r.status).toBe(200)
      return r.body.payment.paymentId
    })

    expect((await pagar(orderId, { isOfflineReplay: true, createdAtLocal: a })).status).toBe(200)

    const orden = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(orden.paymentStatus).toBe('PAID')
    expect(orden.loyaltySaleAt).toEqual(b)
  })
})
