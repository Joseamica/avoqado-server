/**
 * 🔴 DINERO — «Corregir conteo» de un corte ya cerrado y contado, contra Postgres REAL.
 *
 * Turno (`Shift`) y caja física (`CashDrawerSession`) cambian juntos en UNA transacción; el resultado se recalcula con los
 * movimientos de la caja, igual que el recálculo de un movimiento tardío (`cashDrawerPosting.ts`), y queda una fila de bitácora.
 * Aquí se prueba lo que un mock no puede: candados reales, CAS perdidos, rollback real y carreras con el borrado y los tardíos.
 *
 * Correr (va a la nube, con base propia; nunca av-db-25):
 *   AVQ_TREE=<worktree> ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects=integration \
 *     --runTestsByPath tests/integration/shifts/corregirConteo.integration.test.ts --detectOpenHandles=false
 */
import type { NextFunction, Request, Response } from 'express'
import { Prisma, StaffRole } from '@prisma/client'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
  broadcastTpvStatusUpdate: jest.fn(),
}))
// Interruptor para «si la bitácora falla»: por default deja pasar a la implementación real (las tareas siguientes agregan
// pruebas a este mismo archivo y necesitan la bitácora de verdad).
let mockBitacoraFalla = false
jest.mock('@/services/activityAudit.service', () => {
  const real = jest.requireActual('@/services/activityAudit.service')
  return {
    ...real,
    writeLegacyActivityAuditTx: jest.fn((...args: unknown[]) =>
      mockBitacoraFalla ? Promise.reject(new Error('bitácora caída')) : real.writeLegacyActivityAuditTx(...args),
    ),
  }
})

// Guarda permisiva SÓLO para la herramienta MCP real de abajo (el permiso ya se prueba por HTTP): venue y permiso pasan.
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (venueId: string) => ({ venueId: { in: [venueId] } }), requirePermission: () => undefined }),
}))

// La identidad del token: quién (`x-test-actor`) y con qué rol (`x-test-role`). Permiso, validador y servicio, reales.
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const actorId = req.get('x-test-actor')
    if (!actorId) return res.status(401).json({ success: false, message: 'Autenticación requerida' })
    Object.assign(req, {
      authContext: { userId: actorId, venueId: req.params.venueId, orgId: req.params.venueId, role: req.get('x-test-role') ?? 'OWNER' },
    })
    next()
  },
}))
jest.mock('@/middlewares/registerDevice.middleware', () => ({
  registerDeviceMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  capturarVenueDeLaRuta: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

import prisma from '@/utils/prismaClient'
import { registerShiftTools } from '@/mcp/tools/shifts'
import { correctCashCount, previewCashCountCorrection } from '@/services/dashboard/cashCountCorrection.service'
import { deleteShift, getShiftById } from '@/services/dashboard/shift.dashboard.service'
import { postCashSaleToDrawer } from '@/services/shared/cashDrawerPosting'

const cuid = require('cuid') as () => string

jest.setTimeout(90_000)

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(database.pathname)) {
  throw new Error('Esta suite exige una base local DESECHABLE (avoqado_<tarea>_test_…), nunca av-db-25.')
}

/** Un negocio por corte: los candados son por negocio, así una prueba no espera a otra. Sin limpieza: la base se borra al terminar. */
async function negocio() {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const organizationId = (
    await prisma.organization.create({ data: { name: `Conteo ${s}`, email: `conteo-${s}@example.com`, phone: '5555555555' } })
  ).id
  const venueId = (await prisma.venue.create({ data: { organizationId, name: `Conteo ${s}`, slug: `conteo-${s}`, seatCapExempt: true } }))
    .id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: true, requirePinLogin: false } })
  const staffId = (
    await prisma.staff.create({ data: { email: `conteo-${s}@staff.test`, firstName: 'Caja', lastName: 'Turno', active: true } })
  ).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: StaffRole.OWNER } })
  return { venueId, staffId }
}

async function sembrarCorte({
  counted = 20000,
  difference = 18000 as number | null,
  overShort = 18000,
  ventasEnCaja = 0,
  linked = true,
  originSystem = 'AVOQADO' as 'AVOQADO' | 'POS_SOFTRESTAURANT',
} = {}) {
  const { venueId, staffId } = await negocio()
  const hace = (horas: number) => new Date(Date.now() - horas * 3_600_000)
  const shiftId = (
    await prisma.shift.create({
      data: {
        venueId,
        staffId,
        startTime: hace(3),
        endTime: hace(1),
        status: 'CLOSED',
        closedById: staffId,
        startingCash: 2000,
        cashDeclared: counted,
        endingCash: counted,
        cashDifference: difference,
        originSystem,
      },
    })
  ).id
  const cajaId = (
    await prisma.cashDrawerSession.create({
      data: {
        venueId,
        openedByStaffId: staffId,
        openedByName: 'Caja Turno',
        openedAt: hace(3),
        startingAmount: 2000,
        closedByStaffId: staffId,
        closedByName: 'Caja Turno',
        closedAt: hace(1),
        actualAmount: counted,
        overShort,
        status: 'CLOSED',
        shiftId: linked ? shiftId : null,
      },
    })
  ).id
  const evento = (type: 'CASH_SALE' | 'CLOSE', amount: number) => ({
    sessionId: cajaId,
    venueId,
    type,
    amount,
    staffId,
    staffName: 'Caja Turno',
  })
  await prisma.cashDrawerEvent.createMany({
    data: [...(ventasEnCaja > 0 ? [evento('CASH_SALE', ventasEnCaja)] : []), evento('CLOSE', counted)],
  })
  return { venueId, staffId, shiftId, cajaId }
}

type Corte = Awaited<ReturnType<typeof sembrarCorte>>

const corregir = (s: Corte, extra: Record<string, unknown> = {}) =>
  correctCashCount({
    venueId: s.venueId,
    shiftId: s.shiftId,
    countedCash: 2000,
    reason: 'error de dedo',
    expectedCurrentCount: 20000,
    expectedResultingDifference: 0,
    expectedCorrectionCount: 0,
    staffId: s.staffId,
    source: 'DASHBOARD',
    ...extra,
  })

const tardio = (s: Corte, amount = 100) =>
  postCashSaleToDrawer({
    venueId: s.venueId,
    paymentId: cuid(),
    status: 'COMPLETED',
    type: 'REGULAR',
    method: 'CASH',
    amount,
    tipAmount: 0,
    staffId: s.staffId,
    staffName: 'Caja',
    targetSessionId: s.cajaId,
  })

const pesos = (v: Prisma.Decimal | null) => (v == null ? null : v.toFixed(2))

/** Lo que importa del corte, en texto con 2 decimales, más las filas de bitácora de la corrección. */
async function estado(s: Corte) {
  const caja = await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: s.cajaId } })
  const turno = await prisma.shift.findUniqueOrThrow({ where: { id: s.shiftId } })
  return {
    actualAmount: pesos(caja.actualAmount),
    overShort: pesos(caja.overShort),
    cashDeclared: pesos(turno.cashDeclared),
    endingCash: pesos(turno.endingCash),
    cashDifference: pesos(turno.cashDifference),
    bitacora: await prisma.activityLog.count({ where: { venueId: s.venueId, action: 'CASH_COUNT_CORRECTED' } }),
  }
}

const SIN_CORREGIR = {
  actualAmount: '20000.00',
  overShort: '18000.00',
  cashDeclared: '20000.00',
  endingCash: '20000.00',
  cashDifference: '18000.00',
  bitacora: 0,
}

afterAll(async () => {
  await prisma.$disconnect()
})

describe('corregir el conteo de un corte cerrado — contra Postgres', () => {
  it('corrige caja y turno juntos, deja la bitácora y no toca el evento CLOSE', async () => {
    const s = await sembrarCorte()
    const antes = await prisma.shift.findUniqueOrThrow({ where: { id: s.shiftId } })

    await expect(corregir(s)).resolves.toMatchObject({
      shiftId: s.shiftId,
      cashDrawerSessionId: s.cajaId,
      countedBefore: 20000,
      countedAfter: 2000,
      differenceBefore: 18000,
      differenceAfter: 0,
      expectedAmount: 2000,
      correctionsBefore: 0,
    })

    const caja = await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: s.cajaId } })
    expect({ actualAmount: pesos(caja.actualAmount), overShort: pesos(caja.overShort), closedByStaffId: caja.closedByStaffId }).toEqual({
      actualAmount: '2000.00',
      overShort: '0.00',
      closedByStaffId: s.staffId,
    })
    const turno = await prisma.shift.findUniqueOrThrow({ where: { id: s.shiftId } })
    expect({
      cashDeclared: pesos(turno.cashDeclared),
      endingCash: pesos(turno.endingCash),
      cashDifference: pesos(turno.cashDifference),
      status: turno.status,
      endTime: turno.endTime,
    }).toEqual({ cashDeclared: '2000.00', endingCash: '2000.00', cashDifference: '0.00', status: 'CLOSED', endTime: antes.endTime })

    const filas = await prisma.activityLog.findMany({ where: { venueId: s.venueId, action: 'CASH_COUNT_CORRECTED' }, take: 5 })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ entity: 'Shift', entityId: s.shiftId, staffId: s.staffId })
    expect(filas[0].data).toMatchObject({
      cashDrawerSessionId: s.cajaId,
      countedBefore: '20000.00',
      countedAfter: '2000.00',
      differenceBefore: '18000.00',
      differenceAfter: '0.00',
      expectedAmount: '2000.00',
      reason: 'error de dedo',
      source: 'DASHBOARD',
    })

    const cierre = await prisma.cashDrawerEvent.findFirstOrThrow({ where: { sessionId: s.cajaId, type: 'CLOSE' } })
    expect(pesos(cierre.amount)).toBe('20000.00')
  })

  it('cierre de la PAX con foto vieja: el resultado sale de los movimientos y un tardío no lo hace saltar', async () => {
    // La «foto» de la PAX firmó la diferencia contra un esperado de $2,000, pero la caja ya traía una venta de $100.
    const s = await sembrarCorte({ ventasEnCaja: 100, difference: 18000, overShort: 18000 })

    await expect(corregir(s, { countedCash: 2100, expectedResultingDifference: 0 })).resolves.toMatchObject({
      countedAfter: 2100,
      differenceAfter: 0,
      expectedAmount: 2100,
    })
    expect(await estado(s)).toMatchObject({ overShort: '0.00', cashDifference: '0.00' })

    await expect(tardio(s)).resolves.toBe('POSTED')
    expect(await estado(s)).toMatchObject({
      actualAmount: '2100.00',
      cashDeclared: '2100.00',
      overShort: '-100.00',
      cashDifference: '-100.00',
    })
  })

  it('caja y turno con diferencias distintas quedan con la misma', async () => {
    const s = await sembrarCorte({ overShort: 17950, difference: 18000 })

    await corregir(s)

    expect(await estado(s)).toMatchObject({ overShort: '0.00', cashDifference: '0.00' })
  })

  it('un cobro tardío que llegó mientras el gerente escribía ⇒ CASH_COUNT_CHANGED sin escribir', async () => {
    const s = await sembrarCorte()
    await expect(tardio(s)).resolves.toBe('POSTED')
    const trasElTardio = await estado(s)

    // El gerente vio «quedará en $0», pero con la venta de $100 quedaría en −$100: no se le guarda un número que no vio.
    await expect(corregir(s)).rejects.toMatchObject({ statusCode: 409, code: 'CASH_COUNT_CHANGED' })

    expect(await estado(s)).toEqual(trasElTardio)
    expect(trasElTardio).toMatchObject({ actualAmount: '20000.00', cashDeclared: '20000.00', bitacora: 0 })
  })

  it('dos correcciones a la vez: una gana y la otra recibe CASH_COUNT_CHANGED', async () => {
    const s = await sembrarCorte()

    const [a, b] = await Promise.allSettled([corregir(s), corregir(s, { countedCash: 2500, expectedResultingDifference: 500 })])

    const cumplidas = [a, b].filter(r => r.status === 'fulfilled')
    const rechazadas = [a, b].filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(cumplidas).toHaveLength(1)
    expect(rechazadas).toHaveLength(1)
    expect(rechazadas[0].reason).toMatchObject({ statusCode: 409, code: 'CASH_COUNT_CHANGED' })
    expect((await estado(s)).bitacora).toBe(1)
  })

  it('corregir y borrar el corte a la vez no se traban', async () => {
    for (let vuelta = 0; vuelta < 5; vuelta++) {
      const s = await sembrarCorte()

      const [correccion, borrado] = await Promise.allSettled([corregir(s), deleteShift(s.venueId, s.shiftId, s.staffId)])

      for (const r of [correccion, borrado]) {
        if (r.status === 'rejected') {
          const texto = `${(r.reason as Error)?.message ?? ''} ${(r.reason as { code?: string })?.code ?? ''}`
          expect(texto).not.toMatch(/40P01|deadlock/i)
        }
      }
      expect(borrado).toEqual({ status: 'fulfilled', value: true })
      if (correccion.status === 'rejected') expect(correccion.reason).toMatchObject({ statusCode: 404 })
    }
  })

  it('otro gerente corrigió y dejó el mismo número ⇒ CASH_COUNT_CHANGED', async () => {
    const s = await sembrarCorte()
    const vistaDeA = await previewCashCountCorrection(s.venueId, s.shiftId, 2000)
    expect(vistaDeA).toMatchObject({ countedBefore: 20000, differenceAfter: 0, correctionsBefore: 0 })

    await corregir(s, { expectedCorrectionCount: 0 })
    await corregir(s, { countedCash: 20000, expectedCurrentCount: 2000, expectedResultingDifference: 18000, expectedCorrectionCount: 1 })

    await expect(
      corregir(s, {
        expectedCurrentCount: vistaDeA.countedBefore,
        expectedResultingDifference: vistaDeA.differenceAfter,
        expectedCorrectionCount: vistaDeA.correctionsBefore,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CASH_COUNT_CHANGED' })
    expect(await estado(s)).toMatchObject({ actualAmount: '20000.00', cashDeclared: '20000.00', bitacora: 2 })
  })

  it('si la bitácora falla, no queda nada escrito', async () => {
    const s = await sembrarCorte()
    mockBitacoraFalla = true
    try {
      await expect(corregir(s)).rejects.toThrow('bitácora caída')
    } finally {
      mockBitacoraFalla = false
    }

    expect(await estado(s)).toEqual(SIN_CORREGIR)
  })

  it('corte de otro negocio ⇒ 404', async () => {
    const s = await sembrarCorte()
    const otro = await negocio()

    await expect(corregir({ ...s, venueId: otro.venueId })).rejects.toMatchObject({ statusCode: 404 })
    await expect(previewCashCountCorrection(otro.venueId, s.shiftId, 2000)).rejects.toMatchObject({ statusCode: 404 })
    expect(await estado(s)).toEqual(SIN_CORREGIR)
  })

  it('la número 51 ⇒ CASH_COUNT_TOO_MANY', async () => {
    const s = await sembrarCorte()
    await prisma.activityLog.createMany({
      data: Array.from({ length: 50 }, () => ({
        venueId: s.venueId,
        staffId: s.staffId,
        action: 'CASH_COUNT_CORRECTED',
        entity: 'Shift',
        entityId: s.shiftId,
        data: {},
      })),
    })

    await expect(corregir(s, { expectedCorrectionCount: 50 })).rejects.toMatchObject({ statusCode: 409, code: 'CASH_COUNT_TOO_MANY' })
    await expect(previewCashCountCorrection(s.venueId, s.shiftId, 2000)).rejects.toMatchObject({ code: 'CASH_COUNT_TOO_MANY' })
    expect(await estado(s)).toEqual({ ...SIN_CORREGIR, bitacora: 50 })
  })

  it('motivo de puros espacios o 1999.995 ⇒ 400 sin escribir', async () => {
    const s = await sembrarCorte()

    await expect(corregir(s, { reason: '     ' })).rejects.toMatchObject({ statusCode: 400, code: 'CASH_COUNT_INVALID_REASON' })
    await expect(corregir(s, { countedCash: 1999.995 })).rejects.toMatchObject({ statusCode: 400, code: 'CASH_COUNT_INVALID_AMOUNT' })
    expect(await estado(s)).toEqual(SIN_CORREGIR)
  })

  it.each([
    ['sin ligar', { linked: false }, 'CASH_COUNT_NO_LINKED_DRAWER'],
    ['SoftRestaurant', { originSystem: 'POS_SOFTRESTAURANT' as const }, 'CASH_COUNT_EXTERNAL_POS'],
    ['cashDifference nulo', { difference: null }, 'CASH_COUNT_NO_SIGNED_DIFFERENCE'],
  ])('bloqueo sembrado: %s ⇒ %s, sin escribir', async (_nombre, siembra, code) => {
    const s = await sembrarCorte(siembra)
    const antes = await estado(s)

    await expect(corregir(s)).rejects.toMatchObject({ statusCode: 409, code })

    expect(await estado(s)).toEqual(antes)
    expect(antes.bitacora).toBe(0)
  })

  it('expectedCurrentCount viejo ⇒ CASH_COUNT_CHANGED sin escribir', async () => {
    const s = await sembrarCorte()

    await expect(corregir(s, { expectedCurrentCount: 19000 })).rejects.toMatchObject({ statusCode: 409, code: 'CASH_COUNT_CHANGED' })
    expect(await estado(s)).toEqual(SIN_CORREGIR)
  })

  it('la vista previa da los mismos números sin escribir', async () => {
    const s = await sembrarCorte()

    const vista = await previewCashCountCorrection(s.venueId, s.shiftId, 2000)
    expect(await estado(s)).toEqual(SIN_CORREGIR)

    expect(await corregir(s)).toEqual(vista)
  })

  describe('el detalle del corte', () => {
    it('dice que se puede corregir y, tras corregir, enseña quién, antes y motivo', async () => {
      const s = await sembrarCorte()

      const antes = await getShiftById(s.venueId, s.shiftId)
      expect(antes.countCorrection).toEqual({ allowed: true, blockedReason: null })
      expect(antes.countCorrections).toEqual([])
      expect(antes.cashDrawer.linkedToShift).toBe(true)
      expect(antes.cashDrawer.expectedAmount).toBe(2000)

      await corregir(s)
      const despues = await getShiftById(s.venueId, s.shiftId)
      expect(despues.countCorrections[0]).toMatchObject({
        countedBefore: 20000,
        countedAfter: 2000,
        differenceBefore: 18000,
        differenceAfter: 0,
        reason: 'error de dedo',
        staffName: 'Caja Turno',
        source: 'DASHBOARD',
      })
      expect(typeof despues.countCorrections[0].createdAt).toBe('string')
    })

    it('un corte sin caja ligada sale bloqueado con su razón', async () => {
      const s = await sembrarCorte({ linked: false })
      const d = await getShiftById(s.venueId, s.shiftId)
      expect(d.countCorrection).toEqual({ allowed: false, blockedReason: 'NO_LINKED_DRAWER' })
    })

    it('trae todas las correcciones, la más nueva primero', async () => {
      const s = await sembrarCorte()
      await corregir(s) // 20000 -> 2000
      await corregir(s, { countedCash: 2001, expectedCurrentCount: 2000, expectedResultingDifference: 1, expectedCorrectionCount: 1 })
      await corregir(s, { countedCash: 2000, expectedCurrentCount: 2001, expectedResultingDifference: 0, expectedCorrectionCount: 2 })

      const d = await getShiftById(s.venueId, s.shiftId)
      expect(d.countCorrections.map((c: any) => c.countedAfter)).toEqual([2000, 2001, 2000])
      expect(d.countCorrections.map((c: any) => c.countedBefore)).toEqual([2001, 2000, 20000])
    })
  })
})

describe('por HTTP: la ruta «corregir conteo» y la puerta vieja cerrada', () => {
  const express = require('express') as typeof import('express')
  const request = require('supertest') as typeof import('supertest')
  const app = express()
  app.use(express.json())
  app.use('/api/v1/dashboard', (require('@/routes/dashboard.routes') as typeof import('@/routes/dashboard.routes')).default)
  app.use((error: { statusCode?: number; message?: string; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ success: false, message: error.message, code: error.code })
  })

  const cuerpo = (extra: Record<string, unknown> = {}) => ({
    countedCash: 2000,
    reason: 'error de dedo',
    expectedCurrentCount: 20000,
    expectedResultingDifference: 0,
    expectedCorrectionCount: 0,
    ...extra,
  })
  const post = (s: Corte, role: string, body: Record<string, unknown>) =>
    request(app)
      .post(`/api/v1/dashboard/venues/${s.venueId}/shifts/${s.shiftId}/cash-count-correction`)
      .set({ 'x-test-actor': s.staffId, 'x-test-role': role })
      .send(body)
  const estado = async (s: Corte) => ({
    turno: await prisma.shift.findUniqueOrThrow({ where: { id: s.shiftId }, select: { endingCash: true, cashDeclared: true, cashDifference: true } }),
    caja: await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: s.cajaId }, select: { actualAmount: true, overShort: true } }),
  })

  it('CASHIER ⇒ 403 y nada cambia', async () => {
    const s = await sembrarCorte()
    const antes = await estado(s)
    // El rol sale del token cuando el venue coincide, pero la fila de la base manda: el actor sembrado es OWNER, así que se baja a CASHIER.
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: s.staffId, venueId: s.venueId } }, data: { role: StaffRole.CASHIER } })
    const r = await post(s, 'CASHIER', cuerpo())
    expect(r.status).toBe(403)
    expect(await estado(s)).toEqual(antes)
  })

  it('motivo de puros espacios ⇒ 400', async () => {
    const s = await sembrarCorte()
    const antes = await estado(s)
    const r = await post(s, 'OWNER', cuerpo({ reason: '     ' }))
    expect(r.status).toBe(400)
    expect(await estado(s)).toEqual(antes)
  })

  it('2000.005 ⇒ 400', async () => {
    const s = await sembrarCorte()
    const antes = await estado(s)
    const r = await post(s, 'OWNER', cuerpo({ countedCash: 2000.005 }))
    expect(r.status).toBe(400)
    expect(await estado(s)).toEqual(antes)
  })

  it('MANAGER corrige ⇒ 200 con el resultado', async () => {
    const s = await sembrarCorte()
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: s.staffId, venueId: s.venueId } }, data: { role: StaffRole.MANAGER } })
    const r = await post(s, 'MANAGER', cuerpo())
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ shiftId: s.shiftId, countedBefore: 20000, countedAfter: 2000, differenceAfter: 0 })
    const d = await estado(s)
    expect(Number(d.turno.endingCash)).toBe(2000)
    expect(Number(d.caja.actualAmount)).toBe(2000)
  })

  it('PUT con endingCash sobre corte con caja ligada ⇒ 409 CASH_COUNT_USE_CORRECTION y nada cambia', async () => {
    const s = await sembrarCorte()
    const antes = await estado(s)
    const r = await request(app)
      .put(`/api/v1/dashboard/venues/${s.venueId}/shifts/${s.shiftId}`)
      .set({ 'x-test-actor': s.staffId, 'x-test-role': 'OWNER' })
      .send({ endingCash: 5 })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('CASH_COUNT_USE_CORRECTION')
    expect(await estado(s)).toEqual(antes)
  })

  it('PUT con sólo totalSales sigue funcionando', async () => {
    const s = await sembrarCorte()
    const antes = await estado(s)
    const r = await request(app)
      .put(`/api/v1/dashboard/venues/${s.venueId}/shifts/${s.shiftId}`)
      .set({ 'x-test-actor': s.staffId, 'x-test-role': 'OWNER' })
      .send({ totalSales: 123 })
    expect(r.status).toBe(200)
    expect(Number((await prisma.shift.findUniqueOrThrow({ where: { id: s.shiftId } })).totalSales)).toBe(123)
    expect(await estado(s)).toEqual(antes)
  })
})

describe('herramienta MCP correct_cash_count — la real, contra Postgres', () => {
  type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>
  let tool: Handler
  const scope = { staffId: '', activeOrg: 'org', allowedVenueIds: [] as string[], perVenueAccess: new Map() }
  beforeAll(() => {
    const handlers = new Map<string, Handler>()
    registerShiftTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as Handler) } as never, scope as never)
    tool = handlers.get('correct_cash_count')!
  })
  const llamar = async (s: Corte, args: Record<string, unknown>) => {
    scope.staffId = s.staffId // el autor de la bitácora es una persona real (FK)
    return JSON.parse((await tool({ venueId: s.venueId, shiftId: s.shiftId, countedCash: 2000, reason: 'error de dedo', ...args }, {})).content[0].text)
  }
  const tres = { expectedCurrentCount: 20000, expectedResultingDifference: 0, expectedCorrectionCount: 0 }

  it('1999.995 ⇒ CASH_COUNT_INVALID_AMOUNT y la base no cambia', async () => {
    const s = await sembrarCorte()
    expect(await llamar(s, { countedCash: 1999.995 })).toMatchObject({ ok: false, code: 'CASH_COUNT_INVALID_AMOUNT' })
    expect(await estado(s)).toEqual(SIN_CORREGIR)
  })

  it('motivo de espacios ⇒ CASH_COUNT_INVALID_REASON en la vista previa y con confirm, sin escribir', async () => {
    const s = await sembrarCorte()
    expect(await llamar(s, { reason: '   ' })).toMatchObject({ ok: false, code: 'CASH_COUNT_INVALID_REASON' })
    expect(await llamar(s, { reason: '   ', confirm: true, ...tres })).toMatchObject({ ok: false, code: 'CASH_COUNT_INVALID_REASON' })
    expect(await estado(s)).toEqual(SIN_CORREGIR)
  })

  it('vista previa y luego confirm con sus tres valores ⇒ ok y una fila de bitácora con source MCP', async () => {
    const s = await sembrarCorte()
    const vista = await llamar(s, {})
    expect(vista).toMatchObject({ requiresConfirmation: true, ...tres })
    expect((await estado(s)).bitacora).toBe(0)
    const { expectedCurrentCount, expectedResultingDifference, expectedCorrectionCount } = vista
    expect(await llamar(s, { confirm: true, expectedCurrentCount, expectedResultingDifference, expectedCorrectionCount })).toMatchObject({
      ok: true,
      countedAfter: 2000,
    })
    const filas = await prisma.activityLog.findMany({ where: { venueId: s.venueId, action: 'CASH_COUNT_CORRECTED' } })
    expect(filas).toHaveLength(1)
    expect(filas[0].staffId).toBe(s.staffId)
    expect(filas[0].data).toMatchObject({ source: 'MCP', mcp: { source: 'customer-mcp' } })
  })
})
