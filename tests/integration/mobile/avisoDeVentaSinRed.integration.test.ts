/**
 * «Cobrar sin red» (S7) — el aviso al gerente, contra Postgres REAL y por HTTP con las rutas, el permiso, los validadores y los
 * servicios reales (sólo la identidad viene de cabeceras de prueba). Lo que se mira son las filas que ve el dueño: `Notification`
 * en su panel y `ActivityLog` `VENTA_SIN_RED_<AVISO>`.
 *
 * Correr (base desechable, nunca av-db-25):
 *   node scripts/run-with-launch-campaigns-test-db.cjs npx jest --selectProjects integration --runInBand \
 *     --runTestsByPath tests/integration/mobile/avisoDeVentaSinRed.integration.test.ts
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
// La identidad del token: quién (`x-test-actor`) y, si es la terminal, su serial firmado (`x-test-serial`). Lo demás, real.
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const actorId = req.get('x-test-actor')
    if (!actorId) return res.status(401).json({ success: false, message: 'Autenticación requerida' })
    const serial = req.get('x-test-serial')
    Object.assign(req, {
      authContext: {
        userId: actorId,
        venueId: req.params.venueId,
        orgId: req.params.venueId,
        role: 'CASHIER',
        ...(serial ? { terminalSerialNumber: serial } : {}),
      },
    })
    next()
  },
}))
// La bitácora REAL (el setup de integración la simula para todas las suites): aquí es lo que se mira.
jest.mock('@/services/dashboard/activity-log.service', () => jest.requireActual('@/services/dashboard/activity-log.service'))
jest.mock('@/middlewares/registerDevice.middleware', () => ({
  registerDeviceMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  capturarVenueDeLaRuta: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

import prisma from '@/utils/prismaClient'
import { claimPaymentEffects, runClaimedPaymentEffect } from '@/services/tpv/paymentEffects.service'

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
process.env.TOUCH_HEARTBEAT_ENABLED = 'false'

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(database.pathname)) {
  throw new Error('Esta suite exige una base local DESECHABLE (avoqado_<tarea>_test_…), nunca av-db-25.')
}

const SERIAL = 'AVQD-2841548417'

/** Un negocio por prueba: dueño, admin y cajera; el turno A ya lo cerró otro aparato y B es el vivo. La base se borra al terminar. */
async function negocio() {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const organizationId = (
    await prisma.organization.create({ data: { name: `Aviso ${s}`, email: `aviso-${s}@example.com`, phone: '5555555555' } })
  ).id
  const venueId = (await prisma.venue.create({ data: { organizationId, name: `Aviso ${s}`, slug: `aviso-${s}`, seatCapExempt: true } })).id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: true, requirePinLogin: false } })
  const persona = async (rol: StaffRole) => {
    const id = (
      await prisma.staff.create({
        data: { email: `${rol.toLowerCase()}-${s}@staff.test`, firstName: rol, lastName: 'Aviso', active: true },
      })
    ).id
    await prisma.staffVenue.create({ data: { venueId, staffId: id, role: rol } })
    return id
  }
  const ownerId = await persona(StaffRole.OWNER)
  const adminId = await persona(StaffRole.ADMIN)
  const cajeraId = await persona(StaffRole.CASHIER)
  const categoryId = (await prisma.menuCategory.create({ data: { venueId, name: `Cat ${s}`, slug: `cat-${s}` } })).id
  const productId = (
    await prisma.product.create({
      data: { venueId, categoryId, sku: `SKU-${randomUUID()}`, name: `Café ${s}`, price: new Prisma.Decimal(50) },
    })
  ).id
  const hace = (horas: number) => new Date(Date.now() - horas * 3_600_000)
  const turnoA = (
    await prisma.shift.create({
      data: { venueId, staffId: cajeraId, startTime: hace(3), endTime: hace(1), status: 'CLOSED', closedById: ownerId },
    })
  ).id
  await prisma.shift.create({ data: { venueId, staffId: cajeraId, startTime: hace(1), status: 'OPEN' } })
  return {
    venueId,
    ownerId,
    adminId,
    cajeraId,
    productId,
    turnoA,
    terminal: { 'x-test-actor': cajeraId, 'x-test-serial': SERIAL },
    android: { 'x-test-actor': cajeraId },
  }
}

type Negocio = Awaited<ReturnType<typeof negocio>>

const crearOrden = (n: Negocio, como: Record<string, string>, extra: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/mobile/venues/${n.venueId}/orders`)
    .set(como)
    .send({ staffId: n.cajeraId, orderType: 'TAKEOUT', isOfflineReplay: true, items: [{ productId: n.productId, quantity: 2 }], ...extra })

const pagarEnMobile = (n: Negocio, como: Record<string, string>, orderId: string, extra: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/mobile/venues/${n.venueId}/orders/${orderId}/pay`)
    .set(como)
    .send({ amount: 10000, tip: 0, staffId: n.cajeraId, isOfflineReplay: true, ...extra })

/**
 * S3 «Efectivo sin red en el turno correcto» (cambio A PROPÓSITO): el aviso `TURNO_CERRADO` ya no sale directo después de responder;
 * nace con el dinero como efecto durable `AVISO_TURNO_CERRADO` y lo manda el trabajador de efectos (cada 30 s en producción). Aquí se
 * corre ese trabajador a mano —un pase, como el job— antes de contar las filas que ve el dueño. Los demás avisos siguen siendo directos.
 */
async function correrElTrabajadorDeEfectos(venueId: string) {
  // El reclamo toma un lote de 25 por `nextAttemptAt` de TODA la base: con las demás suites (CI corre todas juntas) el aviso de esta
  // prueba quedaba fuera del lote. Se pone primero en la fila; no depende de cuántos efectos dejaron las demás pruebas.
  await prisma.paymentEffect.updateMany({ where: { venueId, status: 'PENDING' }, data: { nextAttemptAt: new Date(0) } })
  for (const efecto of await claimPaymentEffects({ now: new Date() })) {
    await runClaimedPaymentEffect(efecto).catch(() => false)
  }
}

/** Las filas que ve el dueño, esperando a que el aviso (que corre después de responder o en el trabajador de efectos) se asiente. */
async function avisosDe(venueId: string, entityId: string, esperados: number) {
  const leer = () =>
    prisma.notification.findMany({ where: { venueId, entityType: 'VentaSinRed', entityId }, orderBy: { recipientId: 'asc' }, take: 10 })
  await correrElTrabajadorDeEfectos(venueId)
  for (let i = 0; i < 40; i++) {
    const filas = await leer()
    if (filas.length >= esperados && esperados > 0) return filas
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return leer()
}
const bitacoraDe = (venueId: string, action: string) => prisma.activityLog.findMany({ where: { venueId, action }, take: 10 })

afterAll(async () => {
  await prisma.$disconnect()
})

describe('aviso al gerente de una venta de la cola de la terminal — por HTTP y contra Postgres', () => {
  // Codex servidor r1 #4: un 403 la terminal lo REINTENTA (`SyncOutcome.kt`): el aviso dice qué revisar, nunca «regístrala a mano».
  it('1. la cajera dada de baja (token vigente) sube su venta: 403 REAL del permiso ⇒ REINTENTANDO a OWNER y ADMIN, una sola vez', async () => {
    const n = await negocio()
    await prisma.staffVenue.updateMany({ where: { venueId: n.venueId, staffId: n.cajeraId }, data: { active: false } })
    const llave = `venta-${randomUUID()}`

    const primera = await crearOrden(n, n.terminal, { externalId: llave })
    const segunda = await crearOrden(n, n.terminal, { externalId: llave })

    expect(primera.status).toBe(403)
    expect(segunda.status).toBe(403)
    const filas = await avisosDe(n.venueId, `REINTENTANDO:${llave}`, 2)
    expect(filas.map(f => f.recipientId).sort()).toEqual([n.adminId, n.ownerId].sort())
    expect(filas[0]).toMatchObject({ type: 'ALERT', title: 'Una venta sin conexión todavía no se puede subir' })
    expect(filas[0].message).toContain(SERIAL)
    expect(filas[0].message).not.toContain('regístrala a mano')
    const bitacora = await bitacoraDe(n.venueId, 'VENTA_SIN_RED_REINTENTANDO')
    expect(bitacora).toHaveLength(1)
    expect(bitacora[0]).toMatchObject({ entity: 'VentaSinRed', entityId: llave })
  })

  it('2. mobile: la venta de un turno ya cerrado ⇒ se registra sin turno y TURNO_CERRADO avisa con la llave de la venta', async () => {
    const n = await negocio()
    const llave = `venta-${randomUUID()}`

    const creada = await crearOrden(n, n.terminal, { externalId: llave, shiftIdDeLaVenta: n.turnoA })
    expect(creada.status).toBe(201)
    const pagada = await pagarEnMobile(n, n.terminal, creada.body.order.id, { idempotencyKey: llave, shiftIdDeLaVenta: n.turnoA })
    expect(pagada.status).toBe(200)

    const filas = await avisosDe(n.venueId, `TURNO_CERRADO:${llave}`, 2)
    expect(filas).toHaveLength(2)
    expect(filas[0].actionUrl).toBe(
      `/venues/${(await prisma.venue.findUniqueOrThrow({ where: { id: n.venueId } })).slug}/orders/${creada.body.order.id}`,
    )
    expect(await bitacoraDe(n.venueId, 'VENTA_SIN_RED_TURNO_CERRADO')).toHaveLength(1)
  })

  it('3. /tpv/fast: la venta de un turno ya cerrado ⇒ TURNO_CERRADO', async () => {
    const n = await negocio()
    const llave = `cobro-${randomUUID()}`

    const subida = await request(app).post(`/api/v1/tpv/venues/${n.venueId}/fast`).set(n.terminal).send({
      venueId: n.venueId,
      amount: 5000,
      tip: 0,
      status: 'COMPLETED',
      method: 'CASH',
      source: 'TPV',
      splitType: 'FULLPAYMENT',
      staffId: n.cajeraId,
      paidProductsId: [],
      currency: 'MXN',
      idempotencyKey: llave,
      isOfflineReplay: true,
      shiftIdDeLaVenta: n.turnoA,
    })
    expect(subida.status).toBe(201)

    expect(await avisosDe(n.venueId, `TURNO_CERRADO:${llave}`, 2)).toHaveLength(2)
  })

  // S3 (cambio A PROPÓSITO): la venta APARTADA del POS (sin serial) también avisa al gerente —«Un aparato…»—, por el efecto durable.
  // Lo que sigue siendo sólo de la terminal: el aviso REINTENTANDO del 403 de la cajera dada de baja.
  it('4. Android (token sin serial): la venta de un turno cerrado avisa TURNO_CERRADO («Un aparato»); el 403 de la cajera dada de baja, no', async () => {
    const n = await negocio()
    const llave = `venta-${randomUUID()}`
    const creada = await crearOrden(n, n.android, { externalId: llave, shiftIdDeLaVenta: n.turnoA })
    expect(creada.status).toBe(201)
    expect((await pagarEnMobile(n, n.android, creada.body.order.id, { idempotencyKey: llave, shiftIdDeLaVenta: n.turnoA })).status).toBe(
      200,
    )
    await prisma.staffVenue.updateMany({ where: { venueId: n.venueId, staffId: n.cajeraId }, data: { active: false } })
    expect((await crearOrden(n, n.android, { externalId: `venta-${randomUUID()}` })).status).toBe(403)

    await new Promise(resolve => setTimeout(resolve, 500))
    const turnoCerrado = await avisosDe(n.venueId, `TURNO_CERRADO:${llave}`, 2)
    expect(turnoCerrado).toHaveLength(2)
    expect(turnoCerrado[0].message).toMatch(/^Un aparato subió una venta/)
    expect(await prisma.notification.count({ where: { venueId: n.venueId, entityType: 'VentaSinRed' } })).toBe(2)
  })

  it('5. la cola de la terminal sube la MISMA venta dos veces (crear ×2 y pagar ×2, misma llave) ⇒ una orden y un pago con su terminal; conciliación y aviso una vez', async () => {
    const n = await negocio()
    // `serialNumber` es único en toda la base: uno propio, para que el token resuelva a una terminal de ESTE negocio.
    const serial = `AVQD-${randomUUID()}`
    const terminalId = (
      await prisma.terminal.create({ data: { venueId: n.venueId, name: 'Terminal de la cola', serialNumber: serial, type: 'TPV_ANDROID' } })
    ).id
    const terminal = { 'x-test-actor': n.cajeraId, 'x-test-serial': serial }
    const llave = `venta-${randomUUID()}`

    // La respuesta se perdió: la cola reintenta las dos llamadas con sus mismas llaves.
    const creada = await crearOrden(n, terminal, { externalId: llave, shiftIdDeLaVenta: n.turnoA })
    const creadaOtraVez = await crearOrden(n, terminal, { externalId: llave, shiftIdDeLaVenta: n.turnoA })
    expect([creada.status, creadaOtraVez.status]).toEqual([201, 201])
    const orderId = creada.body.order.id
    expect(creadaOtraVez.body.order.id).toBe(orderId)
    const pagada = await pagarEnMobile(n, terminal, orderId, { idempotencyKey: llave, shiftIdDeLaVenta: n.turnoA })
    const pagadaOtraVez = await pagarEnMobile(n, terminal, orderId, { idempotencyKey: llave, shiftIdDeLaVenta: n.turnoA })
    expect([pagada.status, pagadaOtraVez.status]).toEqual([200, 200])
    expect(pagadaOtraVez.body.payment.paymentId).toBe(pagada.body.payment.paymentId)

    const ordenes = await prisma.order.findMany({
      where: { venueId: n.venueId },
      select: { id: true, externalId: true, terminalId: true, source: true, paymentStatus: true, shiftId: true },
      take: 5,
    })
    expect(ordenes).toEqual([{ id: orderId, externalId: llave, terminalId, source: 'TPV', paymentStatus: 'PAID', shiftId: null }])
    const pagos = await prisma.payment.findMany({
      where: { venueId: n.venueId },
      select: { id: true, terminalId: true, source: true, amount: true, shiftId: true },
      take: 5,
    })
    expect(pagos.map(p => ({ ...p, amount: Number(p.amount) }))).toEqual([
      { id: pagada.body.payment.paymentId, terminalId, source: 'TPV', amount: 100, shiftId: null },
    ])
    expect(await bitacoraDe(n.venueId, 'PAYMENT_WITHOUT_SHIFT')).toHaveLength(1)

    const filas = await avisosDe(n.venueId, `TURNO_CERRADO:${llave}`, 2)
    expect(filas.map(f => f.recipientId).sort()).toEqual([n.adminId, n.ownerId].sort())
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await prisma.notification.count({ where: { venueId: n.venueId, entityType: 'VentaSinRed' } })).toBe(2)
    expect(await bitacoraDe(n.venueId, 'VENTA_SIN_RED_TURNO_CERRADO')).toHaveLength(1)
  })

  // 🔴 Codex servidor r1 #6 + S3 «Efectivo sin red en el turno correcto» (cambio A PROPÓSITO): el servidor murió DESPUÉS del commit del
  // pago y antes de avisar. El aviso TURNO_CERRADO ya no depende del reintento del aparato: su obligación (efecto durable
  // `AVISO_TURNO_CERRADO`) nació con el dinero y el trabajador de efectos la cumple UNA vez, aunque la cola reintente con la misma llave
  // (un solo efecto, dos notificaciones —dueño y admin—, nunca cuatro). El PRECIO_CAMBIADO, que sigue siendo directo, vuelve a avisar
  // desde lo guardado en el reintento idempotente, como antes.
  it('6. aviso pendiente tras el commit ⇒ TURNO_CERRADO lo manda el trabajador una vez; el reintento idempotente no crea otro efecto (mobile, /tpv/fast y /tpv/orders/:o)', async () => {
    const n = await negocio()
    const efectosDe = (paymentId: string) =>
      prisma.paymentEffect.count({ where: { venueId: n.venueId, paymentId, kind: 'AVISO_TURNO_CERRADO' } })
    const cuantosDe = (entityId: string) =>
      prisma.notification.count({ where: { venueId: n.venueId, entityType: 'VentaSinRed', entityId } })
    const deTerminal = (llave: string, extra: Record<string, unknown> = {}) => ({
      venueId: n.venueId,
      amount: 5000,
      tip: 0,
      status: 'COMPLETED',
      method: 'CASH',
      source: 'TPV',
      splitType: 'FULLPAYMENT',
      staffId: n.cajeraId,
      paidProductsId: [],
      currency: 'MXN',
      idempotencyKey: llave,
      isOfflineReplay: true,
      shiftIdDeLaVenta: n.turnoA,
      ...extra,
    })

    // mobile: venta de un turno cerrado que además deja saldo ($100 de la orden, se registran $60) ⇒ TURNO_CERRADO y PRECIO_CAMBIADO.
    const llave = `venta-${randomUUID()}`
    const creada = await crearOrden(n, n.terminal, { externalId: llave, shiftIdDeLaVenta: n.turnoA })
    const pago = { idempotencyKey: llave, shiftIdDeLaVenta: n.turnoA, amount: 6000 }
    const pagada = await pagarEnMobile(n, n.terminal, creada.body.order.id, pago)
    expect(pagada.status).toBe(200)
    // La respuesta se perdió y el trabajador todavía no corre: la cola reintenta con la MISMA llave.
    expect((await pagarEnMobile(n, n.terminal, creada.body.order.id, pago)).status).toBe(200)
    expect(await prisma.payment.count({ where: { venueId: n.venueId } })).toBe(1)
    expect(await efectosDe(pagada.body.payment.paymentId)).toBe(1)
    expect(await avisosDe(n.venueId, `TURNO_CERRADO:${llave}`, 2)).toHaveLength(2)
    expect(await avisosDe(n.venueId, `PRECIO_CAMBIADO:${llave}`, 2)).toHaveLength(2)
    // PRECIO_CAMBIADO (directo) perdido ⇒ el reintento idempotente lo repone; TURNO_CERRADO no se duplica.
    await prisma.notification.deleteMany({ where: { venueId: n.venueId, entityType: 'VentaSinRed', entityId: `PRECIO_CAMBIADO:${llave}` } })
    await prisma.activityLog.deleteMany({ where: { venueId: n.venueId, action: 'VENTA_SIN_RED_PRECIO_CAMBIADO' } })
    expect((await pagarEnMobile(n, n.terminal, creada.body.order.id, pago)).status).toBe(200)
    expect(await avisosDe(n.venueId, `PRECIO_CAMBIADO:${llave}`, 2)).toHaveLength(2)
    expect(await cuantosDe(`TURNO_CERRADO:${llave}`)).toBe(2)
    expect(await bitacoraDe(n.venueId, 'VENTA_SIN_RED_TURNO_CERRADO')).toHaveLength(1)
    expect(await bitacoraDe(n.venueId, 'VENTA_SIN_RED_PRECIO_CAMBIADO')).toHaveLength(1)

    // /tpv/fast: dos subidas con la misma llave ⇒ un pago, un efecto, dos notificaciones.
    const rapida = `cobro-${randomUUID()}`
    expect((await request(app).post(`/api/v1/tpv/venues/${n.venueId}/fast`).set(n.terminal).send(deTerminal(rapida))).status).toBe(201)
    expect((await request(app).post(`/api/v1/tpv/venues/${n.venueId}/fast`).set(n.terminal).send(deTerminal(rapida))).status).toBe(201)
    const pagoRapido = await prisma.payment.findFirstOrThrow({ where: { venueId: n.venueId, idempotencyKey: rapida } })
    expect(await efectosDe(pagoRapido.id)).toBe(1)
    expect(await avisosDe(n.venueId, `TURNO_CERRADO:${rapida}`, 2)).toHaveLength(2)

    // /tpv/orders/:orderId: tres subidas con la misma llave ⇒ un efecto, dos notificaciones.
    const deOrden = `cobro-${randomUUID()}`
    const otraOrden = await crearOrden(n, n.terminal, { externalId: `venta-${randomUUID()}`, shiftIdDeLaVenta: n.turnoA })
    const ruta = `/api/v1/tpv/venues/${n.venueId}/orders/${otraOrden.body.order.id}`
    for (let vez = 0; vez < 3; vez++) {
      expect(
        (
          await request(app)
            .post(ruta)
            .set(n.terminal)
            .send(deTerminal(deOrden, { amount: 10000 }))
        ).status,
      ).toBe(201)
    }
    const pagoDeOrden = await prisma.payment.findFirstOrThrow({ where: { venueId: n.venueId, idempotencyKey: deOrden } })
    expect(await efectosDe(pagoDeOrden.id)).toBe(1)
    expect(await avisosDe(n.venueId, `TURNO_CERRADO:${deOrden}`, 2)).toHaveLength(2)
    await correrElTrabajadorDeEfectos(n.venueId)
    expect(await cuantosDe(`TURNO_CERRADO:${deOrden}`)).toBe(2)
  })

  // 🔴 Codex servidor r2 (P2): la terminal vendió sin red con un extra que el dueño BORRÓ antes de que subiera la venta. Antes: TypeError
  // ⇒ 500, la cola reintentaba para siempre y nadie se enteraba. Ahora: 400 MODIFIER_NOT_FOUND (definitivo para la terminal) y aviso
  // RECHAZADA una vez, con «regístrala a mano».
  it('7. extra borrado del catálogo antes de subir la venta ⇒ 400 MODIFIER_NOT_FOUND y aviso RECHAZADA una vez', async () => {
    const n = await negocio()
    const grupo = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: 'Extras' } })
    const extra = await prisma.modifier.create({ data: { groupId: grupo.id, name: 'Queso', price: new Prisma.Decimal(15) } })
    await prisma.modifier.delete({ where: { id: extra.id } }) // `deleteModifier` del panel borra la fila
    const llave = `venta-${randomUUID()}`
    const venta = { externalId: llave, items: [{ productId: n.productId, quantity: 1, modifierIds: [extra.id] }] }

    const primera = await crearOrden(n, n.terminal, venta)
    const segunda = await crearOrden(n, n.terminal, venta)

    expect([primera.status, segunda.status]).toEqual([400, 400])
    expect(primera.body).toMatchObject({ code: 'MODIFIER_NOT_FOUND', message: 'Un extra de esta venta ya no existe en el catálogo' })
    expect(await prisma.order.count({ where: { venueId: n.venueId } })).toBe(0)
    const filas = await avisosDe(n.venueId, `RECHAZADA:${llave}`, 2)
    expect(filas.map(f => f.recipientId).sort()).toEqual([n.adminId, n.ownerId].sort())
    expect(filas[0].message).toContain('regístrala a mano')
    expect(filas[0].message).toContain('ya no existe en el catálogo')
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await prisma.notification.count({ where: { venueId: n.venueId, entityType: 'VentaSinRed' } })).toBe(2)
    expect(await bitacoraDe(n.venueId, 'VENTA_SIN_RED_RECHAZADA')).toHaveLength(1)
  })
})
