/**
 * 🔴 DINERO — S3 «Efectivo sin red en el turno y la caja en que se cobró» (decisión «a» del founder, 21-oct-2026). Contra
 * Postgres REAL y por HTTP, con las rutas y los validadores reales. Spec:
 * `docs/superpowers/specs/2026-10-21-efectivo-sin-red-turno-correcto-design.md` (Avoqado/).
 *
 * El recorrido (dos aparatos): se abre la caja A con $1,000; un aparato SIN RED cobra $100 en efectivo; otro aparato cierra la
 * caja A contando $1,100 (el billete sí está en el cajón: «sobran $100») y abre la caja B; vuelve la red y el primero sube su
 * cola con `cashDrawerSessionId` = caja A. Opción 1 del founder (21-oct, «lo seguro ahora»): la venta NUNCA cae en el turno ni en la
 * caja de B; queda APARTE (`SALE_SHIFT_CLOSED`), con su aviso durable al gerente, y el corte de A sigue diciendo «sobran $100» hasta
 * que el gerente lo concilie. Reproducción r0 (antes del arreglo): la orden caía en el turno B.
 *
 * Correr (base desechable, nunca av-db-25):
 *   node scripts/run-with-launch-campaigns-test-db.cjs npx jest --selectProjects integration --runInBand \
 *     --runTestsByPath tests/integration/payments/ventaTardiaDeLaCola.integration.test.ts
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
// La notificación real escribe en la base; aquí se puede hacer fallar UNA vez para probar el reintento del efecto.
const mockNotificacion = { fallarUnaVez: false }
jest.mock('@/services/dashboard/notification.service', () => {
  const real = jest.requireActual('@/services/dashboard/notification.service')
  return {
    ...real,
    sendNotification: jest.fn(async (...args: unknown[]) => {
      if (mockNotificacion.fallarUnaVez) {
        mockNotificacion.fallarUnaVez = false
        throw new Error('notificaciones caídas')
      }
      return real.sendNotification(...args)
    }),
  }
})
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
// Codex r5 (código) #1: la ventana «a media transacción» desde las entradas REALES (`/pay`, `/fast`). El gancho corre una vez, justo
// después de que el cobro lee la caja de la venta y antes del claim; sin gancho, todo como siempre.
const mockVentana: { despuesDeLeerLaCaja: null | (() => Promise<void>) } = { despuesDeLeerLaCaja: null }
jest.mock('@/services/shared/paymentShiftClaim', () => {
  const real = jest.requireActual('@/services/shared/paymentShiftClaim')
  return {
    ...real,
    ventaDeLaColaEnTx: jest.fn(async (...args: unknown[]) => {
      const venta = await real.ventaDeLaColaEnTx(...args)
      const gancho = mockVentana.despuesDeLeerLaCaja
      if (gancho) {
        mockVentana.despuesDeLeerLaCaja = null
        await gancho()
      }
      return venta
    }),
  }
})

// Codex r6 (código) #1 y #3: la ventana ENTRE el commit del cobro y su movimiento de caja (que va después, fuera de la transacción). El
// gancho corre una vez antes del movimiento; `saltar` lo pierde (el proceso murió) para que lo reponga el barrido.
const mockMovimiento: { antes: null | (() => Promise<void>); saltar: boolean } = { antes: null, saltar: false }
jest.mock('@/services/shared/cashDrawerPosting', () => {
  const real = jest.requireActual('@/services/shared/cashDrawerPosting')
  return {
    ...real,
    postCashSaleToDrawer: jest.fn(async (...args: unknown[]) => {
      const gancho = mockMovimiento.antes
      mockMovimiento.antes = null
      if (gancho) await gancho()
      if (mockMovimiento.saltar) {
        mockMovimiento.saltar = false
        return 'FAILED'
      }
      return real.postCashSaleToDrawer(...args)
    }),
  }
})

import prisma from '@/utils/prismaClient'
import { CashDrawerReconcilerJob } from '@/jobs/cash-drawer-reconciler.job'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { claimPaymentEffects, runClaimedPaymentEffect } from '@/services/tpv/paymentEffects.service'
import { readShiftPaymentsForClose } from '@/services/tpv/shift.tpv.service'
import { deleteShift } from '@/services/dashboard/shift.dashboard.service'
import { claimShiftForCapturedPayment, ventaDeLaColaEnTx } from '@/services/shared/paymentShiftClaim'

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

const cobradoHace = 2 * 60_000

/** La orden de la cola sin red del primer aparato (dos cafés de $50). */
const crearOrdenDeLaCola = async (n: Negocio, extra: Record<string, unknown>) => {
  const creada = await request(app)
    .post(`/api/v1/mobile/venues/${n.venueId}/orders`)
    .set(n.como)
    .send({
      staffId: n.staffId,
      orderType: 'TAKEOUT',
      externalId: `venta-${randomUUID()}`,
      isOfflineReplay: true,
      createdAtLocal: Date.now() - cobradoHace,
      items: [{ productId: n.productId, quantity: 2 }],
      ...extra,
    })
  expect(creada.status).toBe(201)
  return creada.body.order.id as string
}

/** El cobro de $100 en efectivo de esa orden, que hizo mientras su caja estaba abierta. */
const pagarDeLaCola = async (n: Negocio, orderId: string, extra: Record<string, unknown>) => {
  const pagada = await request(app)
    .post(`/api/v1/mobile/venues/${n.venueId}/orders/${orderId}/pay`)
    .set(n.como)
    .send({
      amount: 10000,
      tip: 0,
      staffId: n.staffId,
      idempotencyKey: `cobro-${randomUUID()}`,
      isOfflineReplay: true,
      createdAtLocal: Date.now() - cobradoHace,
      edadDeLaVentaMs: cobradoHace,
      ...extra,
    })
  expect(pagada.status).toBe(200)
  return pagada.body.payment.paymentId as string
}

/** La cola sin red del primer aparato: la orden y el cobro de $100 que hizo mientras la caja A estaba abierta. */
const subirCobroTardio = async (n: Negocio, extra: Record<string, unknown>) => {
  const orderId = await crearOrdenDeLaCola(n, extra)
  return { orderId, paymentId: await pagarDeLaCola(n, orderId, extra) }
}

/** La venta rápida de $100 en efectivo de la cola, por `/mobile/…/fast`. */
const ventaRapidaDeLaCola = async (n: Negocio, cajaId: string) => {
  const r = await request(app)
    .post(`/api/v1/mobile/venues/${n.venueId}/fast`)
    .set(n.como)
    .send({
      venueId: n.venueId,
      amount: 10000,
      tip: 0,
      status: 'COMPLETED',
      method: 'CASH',
      source: 'APP',
      splitType: 'FULLPAYMENT',
      staffId: n.staffId,
      paidProductsId: [],
      currency: 'MXN',
      idempotencyKey: `rapida-${randomUUID()}`,
      isOfflineReplay: true,
      cashDrawerSessionId: cajaId,
    })
  expect(r.status).toBeLessThan(300)
  return prisma.payment.findFirstOrThrow({ where: { venueId: n.venueId }, orderBy: { createdAt: 'desc' } })
}

/** Otro aparato cierra la caja A CONTANDO (con persona y monto) y su turno T. */
const cerrarAContadaYT = async (n: Negocio, a: { cajaId: string; turnoId: string }) => {
  await prisma.shift.update({ where: { id: a.turnoId }, data: { status: 'CLOSED', endTime: new Date() } })
  await prisma.cashDrawerSession.update({
    where: { id: a.cajaId },
    data: { status: 'CLOSED', closedAt: new Date(), closedByStaffId: n.staffId, actualAmount: new Prisma.Decimal(1000) },
  })
}

/** El SERVIDOR cierra la caja sola (`cashDrawerAutoClose`): sin conteo ni persona, y sin tocar su turno. */
const cerrarSolaPorElSistema = (cajaId: string) =>
  prisma.cashDrawerSession.update({
    where: { id: cajaId },
    data: { status: 'CLOSED', closedAt: new Date(), closedByName: 'Cierre automático', closedByStaffId: null, actualAmount: null },
  })

/** Otro aparato cierra la caja CONTANDO; su turno sigue abierto (el cierre va en dos pasos, o el turno se cierra después). */
const cerrarContadaSinTocarElTurno = (n: Negocio, cajaId: string) =>
  prisma.cashDrawerSession.update({
    where: { id: cajaId },
    data: { status: 'CLOSED', closedAt: new Date(), closedByStaffId: n.staffId, actualAmount: new Prisma.Decimal(1000) },
  })

/** El barrido de caja como si ya hubiera pasado su espera (3 min tras el cobro). */
const correrElBarrido = () =>
  new CashDrawerReconcilerJob({ cron: { start: jest.fn(), stop: jest.fn() }, now: () => new Date(Date.now() + 4 * 60_000) }).runNow()

const ventasDelTurno = async (shiftId: string) => Number((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).totalSales)

afterEach(() => {
  mockVentana.despuesDeLeerLaCaja = null
  Object.assign(mockMovimiento, { antes: null, saltar: false })
})

afterAll(async () => {
  await prisma.$disconnect()
})

const conciliaciones = (venueId: string) =>
  prisma.activityLog.findMany({ where: { venueId, action: 'PAYMENT_WITHOUT_SHIFT' }, orderBy: { createdAt: 'asc' }, take: 10 })
const avisos = (venueId: string) => prisma.paymentEffect.findMany({ where: { venueId, kind: 'AVISO_TURNO_CERRADO' }, take: 10 })
const ventasDeCaja = (cajaId: string) => prisma.cashDrawerEvent.count({ where: { sessionId: cajaId, type: 'CASH_SALE' } })
const overShortDe = async (cajaId: string) =>
  Number((await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: cajaId } })).overShort)

/** A abierto con $1,000, cerrado contando $1,100 (sobran $100: el billete del aparato sin red), y B abierto con $500. */
async function aCerradaYBAbierta() {
  const n = await negocio()
  const a = await abrirCaja(n, 1000)
  await cerrarCaja(n, a.cajaId, 1100)
  expect(await overShortDe(a.cajaId)).toBe(100)
  const b = await abrirCaja(n, 500)
  expect(b.turnoId).not.toBe(a.turnoId)
  return { n, a, b }
}

describe('S3 — una venta de la cola de un turno ya cerrado nunca cae en el turno nuevo', () => {
  it('reproducción (dos aparatos): la venta queda APARTE con aviso; la caja A sigue «+100» y B no cambia', async () => {
    const { n, a, b } = await aCerradaYBAbierta()

    const { orderId, paymentId } = await subirCobroTardio(n, { cashDrawerSessionId: a.cajaId })

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).shiftId).toBeNull()
    const pago = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(pago.shiftId).toBeNull()
    expect(pago.posRawData).toMatchObject({ ventaDeTurnoCerrado: a.turnoId })
    expect(await ventasDelTurno(b.turnoId)).toBe(0)
    expect(await ventasDeCaja(b.cajaId)).toBe(0)
    expect(await overShortDe(a.cajaId)).toBe(100)
    const filas = await conciliaciones(n.venueId)
    expect(filas).toHaveLength(1)
    expect(filas[0].data).toMatchObject({ reason: 'SALE_SHIFT_CLOSED', saleShiftId: a.turnoId, paymentId })
    expect(await avisos(n.venueId)).toEqual([expect.objectContaining({ paymentId, status: 'PENDING' })])
  })

  it('el MISMO envío otra vez ⇒ un solo cobro, una conciliación y un aviso', async () => {
    const { n, a } = await aCerradaYBAbierta()
    const llave = `cobro-${randomUUID()}`
    const { orderId } = await subirCobroTardio(n, { cashDrawerSessionId: a.cajaId, idempotencyKey: llave })
    const otraVez = await request(app)
      .post(`/api/v1/mobile/venues/${n.venueId}/orders/${orderId}/pay`)
      .set(n.como)
      .send({ amount: 10000, tip: 0, staffId: n.staffId, idempotencyKey: llave, isOfflineReplay: true, cashDrawerSessionId: a.cajaId })
    expect(otraVez.status).toBe(200)
    expect(await prisma.payment.count({ where: { venueId: n.venueId, orderId } })).toBe(1)
    expect(await conciliaciones(n.venueId)).toHaveLength(1)
    expect(await avisos(n.venueId)).toHaveLength(1)
  })

  it('con la caja A todavía abierta ⇒ todo en A, como hoy', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    const { paymentId } = await subirCobroTardio(n, { cashDrawerSessionId: a.cajaId })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).shiftId).toBe(a.turnoId)
    expect(await ventasDelTurno(a.turnoId)).toBe(100)
    expect(await avisos(n.venueId)).toHaveLength(0)
  })

  it('sin isOfflineReplay ⇒ la caja se ignora: como hoy, en el turno vivo B', async () => {
    const { n, a, b } = await aCerradaYBAbierta()
    const creada = await request(app)
      .post(`/api/v1/mobile/venues/${n.venueId}/orders`)
      .set(n.como)
      .send({ staffId: n.staffId, orderType: 'TAKEOUT', items: [{ productId: n.productId, quantity: 2 }], cashDrawerSessionId: a.cajaId })
    const pagada = await request(app)
      .post(`/api/v1/mobile/venues/${n.venueId}/orders/${creada.body.order.id}/pay`)
      .set(n.como)
      .send({ amount: 10000, tip: 0, staffId: n.staffId, idempotencyKey: `cobro-${randomUUID()}`, cashDrawerSessionId: a.cajaId })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pagada.body.payment.paymentId } })).shiftId).toBe(b.turnoId)
    expect(await avisos(n.venueId)).toHaveLength(0)
  })

  it('venta rápida por /mobile/…/fast con la caja A cerrada ⇒ aparte, con aviso', async () => {
    const { n, a, b } = await aCerradaYBAbierta()
    const r = await request(app)
      .post(`/api/v1/mobile/venues/${n.venueId}/fast`)
      .set(n.como)
      .send({
        venueId: n.venueId,
        amount: 10000,
        tip: 0,
        status: 'COMPLETED',
        method: 'CASH',
        source: 'APP',
        splitType: 'FULLPAYMENT',
        staffId: n.staffId,
        paidProductsId: [],
        currency: 'MXN',
        idempotencyKey: `rapida-${randomUUID()}`,
        isOfflineReplay: true,
        cashDrawerSessionId: a.cajaId,
      })
    expect(r.status).toBeLessThan(300)
    const pago = await prisma.payment.findFirstOrThrow({ where: { venueId: n.venueId }, orderBy: { createdAt: 'desc' } })
    expect(pago.shiftId).toBeNull()
    expect(await ventasDelTurno(b.turnoId)).toBe(0)
    expect(await ventasDeCaja(b.cajaId)).toBe(0)
    expect(await avisos(n.venueId)).toHaveLength(1)
  })

  // Codex r1 (código) #1: el replay de la venta rápida con su caja todavía abierta va a ESA caja (`targetSessionId` + `exigirAbierta`).
  it('venta rápida de la cola con la caja A todavía abierta ⇒ su turno y su efectivo en A', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    const r = await request(app)
      .post(`/api/v1/mobile/venues/${n.venueId}/fast`)
      .set(n.como)
      .send({
        venueId: n.venueId,
        amount: 10000,
        tip: 0,
        status: 'COMPLETED',
        method: 'CASH',
        source: 'APP',
        splitType: 'FULLPAYMENT',
        staffId: n.staffId,
        paidProductsId: [],
        currency: 'MXN',
        idempotencyKey: `rapida-${randomUUID()}`,
        isOfflineReplay: true,
        cashDrawerSessionId: a.cajaId,
      })
    expect(r.status).toBeLessThan(300)
    const pago = await prisma.payment.findFirstOrThrow({ where: { venueId: n.venueId }, orderBy: { createdAt: 'desc' } })
    expect(pago.shiftId).toBe(a.turnoId)
    expect(await ventasDelTurno(a.turnoId)).toBe(100)
    expect(await ventasDeCaja(a.cajaId)).toBe(1)
    expect(await avisos(n.venueId)).toHaveLength(0)
  })

  it('mesa abierta sin red: OPEN_TABLE → ADD_ITEMS → PAY_CASH con la caja A y B ya abierto ⇒ la cuenta y el cobro aparte', async () => {
    const { n, a, b } = await aCerradaYBAbierta()
    const mesa = await prisma.table.create({
      data: { venueId: n.venueId, number: `M-${randomUUID().slice(0, 6)}`, capacity: 4, qrCode: randomUUID() },
    })
    const local = `local-${randomUUID()}`
    const acks = await processIntents({
      venueId: n.venueId,
      staffId: n.staffId,
      deviceId: `aparato-${randomUUID().slice(0, 8)}`,
      authorizeIntent: () => true,
      intents: [
        {
          id: randomUUID(),
          seq: 1,
          type: 'OPEN_TABLE',
          payload: { tableId: mesa.id, covers: 2, localOrderId: local, cashDrawerSessionId: a.cajaId },
        },
        { id: randomUUID(), seq: 2, type: 'ADD_ITEMS', payload: { localOrderId: local, items: [{ productId: n.productId, quantity: 2 }] } },
        { id: randomUUID(), seq: 3, type: 'PAY_CASH', payload: { localOrderId: local, amountCents: 10000, cashDrawerSessionId: a.cajaId } },
      ],
    })
    expect(acks.map(x => x.status)).toEqual(['ACKED', 'ACKED', 'ACKED'])
    const orderId = acks[0].result?.orderId as string
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).shiftId).toBeNull()
    expect((await prisma.payment.findFirstOrThrow({ where: { venueId: n.venueId, orderId } })).shiftId).toBeNull()
    expect(await ventasDelTurno(b.turnoId)).toBe(0)
    expect(await ventasDeCaja(b.cajaId)).toBe(0)
  })

  it('caja cerrada SIN turno ligado con B vivo ⇒ SALE_DRAWER_CLOSED, B no suma, y el cierre de B no la adopta por su orden', async () => {
    const { n, b } = await aCerradaYBAbierta()
    const vieja = await prisma.cashDrawerSession.create({
      data: {
        venueId: n.venueId,
        openedByStaffId: n.staffId,
        openedByName: 'Caja vieja',
        startingAmount: new Prisma.Decimal(0),
        status: 'CLOSED',
        closedAt: new Date(Date.now() - 60_000),
        shiftId: null,
      },
    })
    // La cuenta ya vive en el turno B (como la que se abrió en línea); el cobro tardío llega con la caja vieja.
    const creada = await request(app)
      .post(`/api/v1/mobile/venues/${n.venueId}/orders`)
      .set(n.como)
      .send({ staffId: n.staffId, orderType: 'TAKEOUT', items: [{ productId: n.productId, quantity: 2 }] })
    const orderId = creada.body.order.id as string
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).shiftId).toBe(b.turnoId)
    const pagada = await request(app)
      .post(`/api/v1/mobile/venues/${n.venueId}/orders/${orderId}/pay`)
      .set(n.como)
      .send({
        amount: 10000,
        tip: 0,
        staffId: n.staffId,
        idempotencyKey: `cobro-${randomUUID()}`,
        isOfflineReplay: true,
        cashDrawerSessionId: vieja.id,
      })
    expect(pagada.status).toBe(200)
    const pago = await prisma.payment.findUniqueOrThrow({ where: { id: pagada.body.payment.paymentId } })
    expect(pago.shiftId).toBeNull()
    expect(pago.posRawData).toMatchObject({ cajaDeLaVentaCerrada: vieja.id })
    expect(await ventasDelTurno(b.turnoId)).toBe(0)
    expect((await conciliaciones(n.venueId))[0].data).toMatchObject({ reason: 'SALE_DRAWER_CLOSED', saleDrawerId: vieja.id })
    const turnoB = await prisma.shift.findUniqueOrThrow({ where: { id: b.turnoId } })
    const delCierre = await readShiftPaymentsForClose(n.venueId, b.turnoId, turnoB.startTime, new Date())
    expect(delCierre.map(p => p.id)).not.toContain(pago.id)
  })

  it('la notificación falla una vez ⇒ el trabajador de efectos la crea en el siguiente pase, sin otro envío del aparato', async () => {
    const { n, a } = await aCerradaYBAbierta()
    await subirCobroTardio(n, { cashDrawerSessionId: a.cajaId })
    const [efecto] = await avisos(n.venueId)

    // El reclamo toma un lote de 25 por `nextAttemptAt` de TODA la base (CI corre todas las suites juntas): primero en la fila.
    const alFrente = () => prisma.paymentEffect.update({ where: { id: efecto.id }, data: { nextAttemptAt: new Date(0) } })
    mockNotificacion.fallarUnaVez = true
    await alFrente()
    const primero = (await claimPaymentEffects({ now: new Date() })).filter(c => c.id === efecto.id)
    expect(primero).toHaveLength(1)
    expect(await runClaimedPaymentEffect(primero[0])).toBe(false)
    expect(await prisma.paymentEffect.findUniqueOrThrow({ where: { id: efecto.id } })).toMatchObject({ status: 'PENDING', attempts: 0 })

    // El siguiente pase: su espera ya pasó a los 6 min.
    const despues = new Date(Date.now() + 6 * 60_000)
    expect((await prisma.paymentEffect.findUniqueOrThrow({ where: { id: efecto.id } })).nextAttemptAt.getTime()).toBeLessThanOrEqual(
      despues.getTime(),
    )
    await alFrente()
    const segundo = (await claimPaymentEffects({ now: despues })).filter(c => c.id === efecto.id)
    expect(await runClaimedPaymentEffect(segundo[0])).toBe(true)
    expect(await prisma.paymentEffect.findUniqueOrThrow({ where: { id: efecto.id } })).toMatchObject({ status: 'DONE' })
    expect(await prisma.notification.count({ where: { venueId: n.venueId, entityType: 'VentaSinRed' } })).toBe(1)
  })

  it('cobro dividido: parte 1 con red en A, parte 2 tardía con A cerrado ⇒ la 1 en A, la 2 aparte', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    const creada = await request(app)
      .post(`/api/v1/mobile/venues/${n.venueId}/orders`)
      .set(n.como)
      .send({ staffId: n.staffId, orderType: 'TAKEOUT', items: [{ productId: n.productId, quantity: 2 }] })
    const orderId = creada.body.order.id as string
    const parte1 = await request(app)
      .post(`/api/v1/mobile/venues/${n.venueId}/orders/${orderId}/pay`)
      .set(n.como)
      .send({ amount: 5000, tip: 0, staffId: n.staffId, idempotencyKey: `p1-${randomUUID()}` })
    await cerrarCaja(n, a.cajaId, 1100)
    await abrirCaja(n, 500)
    const parte2 = await request(app)
      .post(`/api/v1/mobile/venues/${n.venueId}/orders/${orderId}/pay`)
      .set(n.como)
      .send({
        amount: 5000,
        tip: 0,
        staffId: n.staffId,
        idempotencyKey: `p2-${randomUUID()}`,
        isOfflineReplay: true,
        cashDrawerSessionId: a.cajaId,
      })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: parte1.body.payment.paymentId } })).shiftId).toBe(a.turnoId)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: parte2.body.payment.paymentId } })).shiftId).toBeNull()
  })
  // 🔴 Codex r1 (código) #2: la caja que se leyó para decidir el turno no puede cerrarse (ni ligarse a otro turno) a media transacción
  // del cobro. Con dos transacciones REALES: mientras la del cobro la tiene leída, el cierre espera; sólo entra cuando el cobro termina.
  // 🔴 Sin candados de caja en el cobro (Codex r3 código #3): la apertura del día siguiente (turno → caja) y un cobro con una caja sin
  // turno no se traban. Antes, con el `FOR SHARE` de la caja, esta misma intercalación daba 40P01. El resultado es el LÍMITE declarado
  // (caja abierta sin turno que cierran a media transacción; 0 de 63 cajas en producción en 30 días): el cobro pierde el turno (CAS
  // perdido) y no suma a ninguno; nunca entra al turno nuevo.
  it('la apertura del día siguiente y un cobro con caja sin turno no se traban, y el cobro no cae en el turno nuevo', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    await prisma.cashDrawerSession.update({ where: { id: a.cajaId }, data: { shiftId: null } })
    let turnoApartado: () => void = () => {}
    const yaApartado = new Promise<void>(resolve => {
      turnoApartado = resolve
    })
    const apertura = prisma.$transaction(async tx => {
      await tx.shift.updateMany({
        where: { id: a.turnoId, status: 'OPEN', endTime: null },
        data: { status: 'CLOSED', endTime: new Date() },
      })
      turnoApartado()
      await new Promise(resolve => setTimeout(resolve, 700))
      await tx.cashDrawerSession.updateMany({ where: { id: a.cajaId, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: new Date() } })
    })
    await yaApartado
    const cobro = prisma.$transaction(async tx => {
      const venta = await ventaDeLaColaEnTx(tx, n.venueId, { cashDrawerSessionId: a.cajaId })
      return claimShiftForCapturedPayment(tx, {
        venueId: n.venueId,
        amountPesos: new Prisma.Decimal(100),
        tipPesos: new Prisma.Decimal(0),
        incrementTotalOrders: false,
        orderId: null,
        ...venta,
      })
    })
    const [, claim] = await Promise.all([apertura, cobro])
    expect(claim.shiftId).toBeNull()
    expect(await ventasDelTurno(a.turnoId)).toBe(0)
  })
  // 🔴 Codex r4 (código) #1: el cierre de caja va en dos pasos (la caja y luego su turno). Si el segundo falla, la caja A queda cerrada
  // con su turno T abierto; abrir B ese día reutiliza T y B nace SIN liga (T ya es de A). La venta tardía de A no puede caer en T ni en B.
  it('caja A cerrada con su turno T todavía abierto y B abierta en T ⇒ la venta queda APARTE, sin tocar T ni B', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    await prisma.cashDrawerSession.update({
      where: { id: a.cajaId },
      data: { status: 'CLOSED', closedAt: new Date(), closedByStaffId: n.staffId, actualAmount: new Prisma.Decimal(1000) },
    })
    const abrioB = await request(app)
      .post(`/api/v1/mobile/venues/${n.venueId}/cash-drawer/open`)
      .set(n.como)
      .send({ startingAmount: 500, deviceName: 'Aparato 2', localId: randomUUID() })
    expect([200, 201]).toContain(abrioB.status)
    const cajaB = abrioB.body.data.id as string
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: a.turnoId } })).status).toBe('OPEN')

    const { paymentId } = await subirCobroTardio(n, { cashDrawerSessionId: a.cajaId })
    const pago = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(pago.shiftId).toBeNull()
    expect(await ventasDelTurno(a.turnoId)).toBe(0)
    expect(await ventasDeCaja(cajaB)).toBe(0)
    expect(await avisos(n.venueId)).toHaveLength(1)
  })

  // 🔴 Codex r4 (código) #2: el replay lee la caja A ABIERTA y sin turno; antes de reclamar, otro aparato cierra A y abre B con el turno
  // U. Sin volver a mirar la caja, el claim encontraba U y lo sumaba. Ahora, tras el claim, se relee la caja: cambió ⇒ se deshace y aparte.
  it('caja sin turno que cierran y reemplazan a media transacción ⇒ el cobro NO suma al turno nuevo: queda aparte', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    await prisma.cashDrawerSession.update({ where: { id: a.cajaId }, data: { shiftId: null } })
    let leida: () => void = () => {}
    const yaLeida = new Promise<void>(resolve => {
      leida = resolve
    })
    let abrioU: () => void = () => {}
    const yaAbrioU = new Promise<void>(resolve => {
      abrioU = resolve
    })
    const cobro = prisma.$transaction(
      async tx => {
        const venta = await ventaDeLaColaEnTx(tx, n.venueId, { cashDrawerSessionId: a.cajaId })
        leida()
        await yaAbrioU
        return claimShiftForCapturedPayment(tx, {
          venueId: n.venueId,
          amountPesos: new Prisma.Decimal(100),
          tipPesos: new Prisma.Decimal(0),
          incrementTotalOrders: true,
          orderId: null,
          ...venta,
        })
      },
      { timeout: 30_000, maxWait: 5_000 },
    )
    await yaLeida
    await prisma.shift.update({ where: { id: a.turnoId }, data: { status: 'CLOSED', endTime: new Date() } })
    await prisma.cashDrawerSession.update({ where: { id: a.cajaId }, data: { status: 'CLOSED', closedAt: new Date() } })
    const b = await abrirCaja(n, 500)
    abrioU()
    const claim = await cobro
    expect(claim).toMatchObject({ shiftId: null, pendingReason: 'SALE_DRAWER_CLOSED', saleDrawerId: a.cajaId })
    const u = await prisma.shift.findUniqueOrThrow({ where: { id: b.turnoId } })
    expect(Number(u.totalSales)).toBe(0)
    expect(u.totalOrders).toBe(0)
  })

  // 🔴 Codex r5 (código) #3: el SERVIDOR cierra SOLO una caja sin movimientos por horas, SIN conteo (`cashDrawerAutoClose`), y su turno
  // sigue abierto. Un aparato que vendió sin red en esa caja no debe quedar aparte: nadie firmó un corte. Va a su turno, y su efectivo
  // sólo a SU caja (cerrada ⇒ lo repone el barrido en su ventana), nunca a la que se abrió después.
  it('caja A cerrada SOLA por el sistema (sin conteo) con su turno T abierto ⇒ la venta va a T, no queda aparte, y B no la recibe', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    await prisma.cashDrawerSession.update({
      where: { id: a.cajaId },
      data: { status: 'CLOSED', closedAt: new Date(), closedByName: 'Cierre automático', closedByStaffId: null, actualAmount: null },
    })
    const abrioB = await request(app)
      .post(`/api/v1/mobile/venues/${n.venueId}/cash-drawer/open`)
      .set(n.como)
      .send({ startingAmount: 500, deviceName: 'Aparato 2', localId: randomUUID() })
    expect([200, 201]).toContain(abrioB.status)
    const cajaB = abrioB.body.data.id as string

    const { paymentId } = await subirCobroTardio(n, { cashDrawerSessionId: a.cajaId })
    const pago = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(pago.shiftId).toBe(a.turnoId)
    expect(await ventasDelTurno(a.turnoId)).toBe(100)
    expect(await ventasDeCaja(cajaB)).toBe(0)
    // Codex r6 (código) #1: el billete está en A; nadie la contó, así que se anota ahí (sin recalcular nada).
    expect(await ventasDeCaja(a.cajaId)).toBe(1)
    expect(await avisos(n.venueId)).toHaveLength(0)
  })

  // 🔴 Codex r6 (código) #1: la caja A la cerró el sistema (sin conteo) y su turno T sigue abierto; no hay otra caja. Antes, `/pay` exigía
  // que A siguiera abierta y el barrido sólo mira la ventana de A, que ya terminó: el efectivo no entraba a ninguna caja.
  it('caja A cerrada sola por el sistema, sin otra caja: /pay anota el efectivo en A, sin tocar su corte', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    await cerrarSolaPorElSistema(a.cajaId)
    const { paymentId } = await subirCobroTardio(n, { cashDrawerSessionId: a.cajaId })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).shiftId).toBe(a.turnoId)
    expect(await ventasDelTurno(a.turnoId)).toBe(100)
    expect(await ventasDeCaja(a.cajaId)).toBe(1)
    const cajaA = await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: a.cajaId } })
    expect(cajaA).toMatchObject({ status: 'CLOSED', actualAmount: null, overShort: null })
  })

  it('caja A cerrada sola por el sistema, sin otra caja: /fast anota el efectivo en A', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    await cerrarSolaPorElSistema(a.cajaId)
    const pago = await ventaRapidaDeLaCola(n, a.cajaId)
    expect(pago.shiftId).toBe(a.turnoId)
    expect(await ventasDeCaja(a.cajaId)).toBe(1)
  })

  // Codex r6 (código) #1, «sin depender de la hora de llegada»: si el movimiento se pierde (el proceso muere tras el commit), el barrido lo
  // repone en SU caja autocerrada. Por la ventana, la única caja que cubre la hora del cobro es B (sin liga), y ahí caía.
  it('el movimiento se pierde con A cerrada sola y B abierta ⇒ el barrido lo repone en A, nunca en B', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    await cerrarSolaPorElSistema(a.cajaId)
    const abrioB = await request(app)
      .post(`/api/v1/mobile/venues/${n.venueId}/cash-drawer/open`)
      .set(n.como)
      .send({ startingAmount: 500, deviceName: 'Aparato 2', localId: randomUUID() })
    expect([200, 201]).toContain(abrioB.status)
    const cajaB = abrioB.body.data.id as string
    mockMovimiento.saltar = true
    await subirCobroTardio(n, { cashDrawerSessionId: a.cajaId })
    expect(await ventasDeCaja(a.cajaId)).toBe(0)

    await correrElBarrido()

    expect(await ventasDeCaja(a.cajaId)).toBe(1)
    expect(await ventasDeCaja(cajaB)).toBe(0)
  })

  // 🔴 Codex r6 (código) #2: el replay lee A ABIERTA y ligada a T; a media subida otro aparato cierra A CONTANDO y T sigue abierto. Sin
  // releer la caja ligada, el cobro sumaba a T sin marca ni aviso, y el barrido podía recalcular el corte firmado de A.
  it('entrada real /pay: la caja ligada se cierra CONTADA a media subida con su turno abierto ⇒ aparte, T no suma', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    const orderId = await crearOrdenDeLaCola(n, { cashDrawerSessionId: a.cajaId })
    mockVentana.despuesDeLeerLaCaja = async () => {
      await cerrarContadaSinTocarElTurno(n, a.cajaId)
    }
    const paymentId = await pagarDeLaCola(n, orderId, { cashDrawerSessionId: a.cajaId })
    const pago = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(pago.shiftId).toBeNull()
    expect(pago.posRawData).toMatchObject({ cajaDeLaVentaCerrada: a.cajaId })
    expect(await ventasDelTurno(a.turnoId)).toBe(0)
    expect(await ventasDeCaja(a.cajaId)).toBe(0)
    expect(await avisos(n.venueId)).toHaveLength(1)
  })

  it('entrada real /fast: la caja ligada se cierra CONTADA a media subida con su turno abierto ⇒ aparte, T no suma', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    mockVentana.despuesDeLeerLaCaja = async () => {
      await cerrarContadaSinTocarElTurno(n, a.cajaId)
    }
    const pago = await ventaRapidaDeLaCola(n, a.cajaId)
    expect(pago.shiftId).toBeNull()
    expect(await ventasDelTurno(a.turnoId)).toBe(0)
    expect(await ventasDeCaja(a.cajaId)).toBe(0)
    expect(await avisos(n.venueId)).toHaveLength(1)
  })

  it('entrada real /pay: la caja ligada la cierra SOLA el sistema a media subida ⇒ la venta va a T y su efectivo a A', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    const orderId = await crearOrdenDeLaCola(n, { cashDrawerSessionId: a.cajaId })
    mockVentana.despuesDeLeerLaCaja = async () => {
      await cerrarSolaPorElSistema(a.cajaId)
    }
    const paymentId = await pagarDeLaCola(n, orderId, { cashDrawerSessionId: a.cajaId })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).shiftId).toBe(a.turnoId)
    expect(await ventasDelTurno(a.turnoId)).toBe(100)
    expect(await ventasDeCaja(a.cajaId)).toBe(1)
    expect(await avisos(n.venueId)).toHaveLength(0)
  })

  // 🔴 Codex r7 (código) #1: A la cerró el sistema con su turno T ya cerrado, y U está abierto. A media subida, un ADMIN borra T desde el
  // DASHBOARD (`deleteShift`: borrado duro, la caja queda sin liga). El turno salió de una caja ya validada: no se toma por inventado ni la
  // venta cae en U; queda aparte.
  const aAutocerradaConSuTurnoCerradoYUAbierto = async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    await prisma.shift.update({ where: { id: a.turnoId }, data: { status: 'CLOSED', endTime: new Date() } })
    await cerrarSolaPorElSistema(a.cajaId)
    const u = await abrirCaja(n, 500)
    expect(u.turnoId).not.toBe(a.turnoId)
    mockVentana.despuesDeLeerLaCaja = async () => {
      await prisma.shift.delete({ where: { id: a.turnoId } })
    }
    return { n, a, u }
  }

  it('/fast: borran el turno viejo desde el panel a media subida ⇒ la venta queda aparte, nunca en el turno nuevo', async () => {
    const { n, a, u } = await aAutocerradaConSuTurnoCerradoYUAbierto()
    const pago = await ventaRapidaDeLaCola(n, a.cajaId)
    expect(pago.shiftId).toBeNull()
    expect(await ventasDelTurno(u.turnoId)).toBe(0)
    expect(await ventasDeCaja(u.cajaId)).toBe(0)
    expect(await avisos(n.venueId)).toHaveLength(1)
  })

  it('crear orden + /pay: borran el turno viejo a media subida ⇒ ni la orden ni el cobro caen en el turno nuevo', async () => {
    const { n, a, u } = await aAutocerradaConSuTurnoCerradoYUAbierto()
    const { orderId, paymentId } = await subirCobroTardio(n, { cashDrawerSessionId: a.cajaId })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).shiftId).toBeNull()
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).shiftId).toBeNull()
    expect(await ventasDelTurno(u.turnoId)).toBe(0)
    expect(await avisos(n.venueId)).toHaveLength(1)
  })

  // 🔴 Codex r8 (código) #1, la familia de r7 de raíz: borrar un turno es lo ÚNICO que suelta la liga caja → turno (`SetNull`). Con su
  // caja todavía ABIERTA (cierre en dos pasos a medias), la caja quedaba «abierta sin turno» y la venta de la cola caía en el turno vivo.
  // Ya no se puede: el turno se borra sólo cuando su caja cerró, y una caja cerrada sin turno aparta la venta.
  it('no se puede borrar un turno cerrado cuya caja sigue abierta; con la caja cerrada sí', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    await prisma.shift.update({ where: { id: a.turnoId }, data: { status: 'CLOSED', endTime: new Date(Date.now() - 1000) } })

    await expect(deleteShift(n.venueId, a.turnoId, n.staffId)).rejects.toMatchObject({ statusCode: 400 })
    expect(await prisma.shift.findUnique({ where: { id: a.turnoId } })).not.toBeNull()
    expect((await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: a.cajaId } })).shiftId).toBe(a.turnoId)

    await cerrarContadaSinTocarElTurno(n, a.cajaId)
    expect(await deleteShift(n.venueId, a.turnoId, n.staffId)).toBe(true)
    expect(await prisma.shift.findUnique({ where: { id: a.turnoId } })).toBeNull()
  })

  // 🔴 Codex r6 (código) #3: A abierta SIN liga y su turno en CLOSING ⇒ el cobro no toma turno (`SHIFT_NOT_OPEN`). Antes del movimiento
  // otro aparato cierra A contando y abre B: `/fast` perdía la caja capturada y el movimiento caía en la caja abierta de ese momento, B.
  const cajaSinLigaConSuTurnoCerrando = async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    await prisma.cashDrawerSession.update({ where: { id: a.cajaId }, data: { shiftId: null } })
    await prisma.shift.update({ where: { id: a.turnoId }, data: { status: 'CLOSING' } })
    const b: { cajaId?: string } = {}
    mockMovimiento.antes = async () => {
      await cerrarContadaSinTocarElTurno(n, a.cajaId)
      b.cajaId = (
        await prisma.cashDrawerSession.create({
          data: { venueId: n.venueId, openedByStaffId: n.staffId, openedByName: 'Aparato 2', startingAmount: new Prisma.Decimal(500) },
        })
      ).id
    }
    return { n, a, b }
  }

  it('/fast sin turno vivo: cierran A y abren B antes del movimiento ⇒ el efectivo NUNCA cae en B', async () => {
    const { n, a, b } = await cajaSinLigaConSuTurnoCerrando()
    const pago = await ventaRapidaDeLaCola(n, a.cajaId)
    expect(b.cajaId).toBeDefined()
    expect(pago.shiftId).toBeNull()
    expect(await ventasDeCaja(b.cajaId as string)).toBe(0)
    expect((await conciliaciones(n.venueId))[0].data).toMatchObject({ reason: 'SHIFT_NOT_OPEN', paymentId: pago.id })
  })

  it('/pay sin turno vivo: cierran A y abren B antes del movimiento ⇒ el efectivo NUNCA cae en B', async () => {
    const { n, a, b } = await cajaSinLigaConSuTurnoCerrando()
    const { paymentId } = await subirCobroTardio(n, { cashDrawerSessionId: a.cajaId })
    expect(b.cajaId).toBeDefined()
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).shiftId).toBeNull()
    expect(await ventasDeCaja(b.cajaId as string)).toBe(0)
  })

  // 🔴 Codex r5 (código) #1: la relectura de la caja sin turno, desde la entrada REAL de `/pay` (antes sólo la probaba la función).
  it('entrada real /pay: la caja sin turno cierra y abren otra a media subida ⇒ aparte, sin sumar al turno nuevo', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    await prisma.cashDrawerSession.update({ where: { id: a.cajaId }, data: { shiftId: null } })
    const orderId = await crearOrdenDeLaCola(n, { cashDrawerSessionId: a.cajaId })
    const nueva: { cajaId?: string; turnoId?: string } = {}
    mockVentana.despuesDeLeerLaCaja = async () => {
      await cerrarAContadaYT(n, a)
      Object.assign(nueva, await abrirCaja(n, 500))
    }
    const paymentId = await pagarDeLaCola(n, orderId, { cashDrawerSessionId: a.cajaId })
    expect(nueva.turnoId).toBeDefined()
    const pago = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(pago.shiftId).toBeNull()
    expect(await ventasDelTurno(nueva.turnoId as string)).toBe(0)
    expect(await ventasDeCaja(nueva.cajaId as string)).toBe(0)
    expect(await avisos(n.venueId)).toHaveLength(1)
  })

  it('entrada real /fast: la caja sin turno cierra y abren otra a media subida ⇒ aparte, sin sumar al turno nuevo', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    await prisma.cashDrawerSession.update({ where: { id: a.cajaId }, data: { shiftId: null } })
    const nueva: { cajaId?: string; turnoId?: string } = {}
    mockVentana.despuesDeLeerLaCaja = async () => {
      await cerrarAContadaYT(n, a)
      Object.assign(nueva, await abrirCaja(n, 500))
    }
    const pago = await ventaRapidaDeLaCola(n, a.cajaId)
    expect(nueva.turnoId).toBeDefined()
    expect(pago.shiftId).toBeNull()
    expect(await ventasDelTurno(nueva.turnoId as string)).toBe(0)
    expect(await ventasDeCaja(nueva.cajaId as string)).toBe(0)
    expect(await avisos(n.venueId)).toHaveLength(1)
  })

  // 🔴 Codex r5 (código) #2: cierran la caja sin turno y su turno, y TODAVÍA no abren otro: sin turno vivo, el claim salía antes de la
  // relectura (`NO_SHIFT`) y la venta perdía su marca y su aviso.
  it('entrada real /pay: la caja sin turno cierra a media subida y no hay turno nuevo ⇒ aparte con su aviso', async () => {
    const n = await negocio()
    const a = await abrirCaja(n, 1000)
    await prisma.cashDrawerSession.update({ where: { id: a.cajaId }, data: { shiftId: null } })
    const orderId = await crearOrdenDeLaCola(n, { cashDrawerSessionId: a.cajaId })
    mockVentana.despuesDeLeerLaCaja = () => cerrarAContadaYT(n, a)
    const paymentId = await pagarDeLaCola(n, orderId, { cashDrawerSessionId: a.cajaId })
    const pago = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(pago.shiftId).toBeNull()
    expect(pago.posRawData).toMatchObject({ cajaDeLaVentaCerrada: a.cajaId })
    expect(await avisos(n.venueId)).toHaveLength(1)
  })

  // 🔴 Codex r1 (código) #4: el aviso nunca se descarta, ni siquiera con el agotamiento del reclamo (seis reclamos interrumpidos).
  it('un aviso con los intentos agotados se sigue reclamando: nunca DEAD_LETTER', async () => {
    const { n, a } = await aCerradaYBAbierta()
    await subirCobroTardio(n, { cashDrawerSessionId: a.cajaId })
    const [efecto] = await avisos(n.venueId)
    // El reclamo toma un lote de 25 por `nextAttemptAt`: primero en la fila, para no depender de cuántos efectos dejaron las demás pruebas.
    await prisma.paymentEffect.update({ where: { id: efecto.id }, data: { attempts: 9, nextAttemptAt: new Date(0) } })

    const reclamados = (await claimPaymentEffects({ now: new Date() })).filter(c => c.id === efecto.id)

    expect(reclamados).toHaveLength(1)
    expect((await prisma.paymentEffect.findUniqueOrThrow({ where: { id: efecto.id } })).status).toBe('PROCESSING')
  })

  // 🔴 Codex r1 (código) #5: un pago APARTADO que nació antes del efecto durable (la versión anterior lo avisaba directo) y cuya
  // respuesta se perdió: el reintento con la misma llave le crea el aviso que le falta, sin crear otro cobro.
  it('pago apartado de antes del efecto durable + reintento con la misma llave ⇒ se crea su aviso, una sola vez', async () => {
    const { n, a } = await aCerradaYBAbierta()
    const llave = `cobro-${randomUUID()}`
    const { orderId, paymentId } = await subirCobroTardio(n, { cashDrawerSessionId: a.cajaId, idempotencyKey: llave })
    await prisma.paymentEffect.deleteMany({ where: { venueId: n.venueId, kind: 'AVISO_TURNO_CERRADO' } })

    for (let vez = 0; vez < 2; vez++) {
      const otraVez = await request(app)
        .post(`/api/v1/mobile/venues/${n.venueId}/orders/${orderId}/pay`)
        .set(n.como)
        .send({ amount: 10000, tip: 0, staffId: n.staffId, idempotencyKey: llave, isOfflineReplay: true, cashDrawerSessionId: a.cajaId })
      expect(otraVez.status).toBe(200)
    }

    expect(await prisma.payment.count({ where: { venueId: n.venueId, orderId } })).toBe(1)
    expect(await avisos(n.venueId)).toEqual([expect.objectContaining({ paymentId, status: 'PENDING' })])
  })
})
