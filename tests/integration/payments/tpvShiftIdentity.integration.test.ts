/**
 * D24 (Testarudo, 22-nov-2026) — con Postgres real y el `checkPermission` real.
 *
 * La N86 se quedó en la caja de ayer porque quien entró era de Cocina: GET /tpv/venues/:id/shift exige `shifts:read`. La ruta
 * nueva dice CUÁL caja del negocio está abierta con el permiso de cobrar (`payments:create`) y sin una sola cifra.
 */
import cuid from 'cuid'
import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { StaffRole } from '@prisma/client'

jest.mock('@/communication/rabbitmq/commandListener', () => ({ deliverPosCommand: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

import prisma from '@/utils/prismaClient'
import { getShiftIdentity } from '@/controllers/tpv/shift.tpv.controller'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { abrirTurnoDeCaja } from '@/services/shared/turnoDeCaja'

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(database.pathname)) {
  throw new Error('Esta suite exige una base desechable propia de avq-verify, nunca av-db-25.')
}

const app = express()
app.get(
  '/venues/:venueId/shift/identity',
  (req, _res, next) => {
    // Sólo la autenticación la pone la prueba; el permiso y la base son reales. El token dice la sucursal donde entró la persona.
    req.authContext = {
      userId: req.get('x-test-actor')!,
      orgId: 'test-org',
      venueId: req.get('x-test-token-venue') ?? req.params.venueId,
      role: StaffRole.KITCHEN,
    }
    next()
  },
  checkPermission('payments:create'),
  getShiftIdentity,
)
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code })
})

async function negocio(key: string, organizationId?: string) {
  const orgId =
    organizationId ??
    (await prisma.organization.create({ data: { name: `D24 ${key}`, email: `${key}@example.com`, phone: '5555555555' } })).id
  const venue = await prisma.venue.create({ data: { name: `D24 ${key}`, slug: `d24-${key}`, organizationId: orgId } })
  return { venueId: venue.id, organizationId: orgId }
}

async function persona(venueId: string, role: StaffRole) {
  const key = cuid()
  const staff = await prisma.staff.create({ data: { firstName: 'Persona', lastName: role, email: `${key}@staff.test`, active: true } })
  await prisma.staffVenue.create({ data: { staffId: staff.id, venueId, role } })
  return staff.id
}

/** Cocina con el permiso de cobrar, como la de Testarudo (13 permisos, 3 cobros en 30 días); sin `shifts:read`. */
async function cocinaQueCobra(venueId: string) {
  const cocina = await persona(venueId, StaffRole.KITCHEN)
  await prisma.venueRolePermission.create({
    data: {
      venueId,
      role: StaffRole.KITCHEN,
      permissions: ['home:read', 'orders:read', 'orders:create', 'orders:update', 'menu:read', 'payments:create'],
      modifiedBy: cocina,
    },
  })
  return cocina
}

const identidad = (venueId: string, actor: string, query = '', tokenVenue?: string) => {
  const r = request(app).get(`/venues/${venueId}/shift/identity${query}`).set('x-test-actor', actor)
  return tokenVenue ? r.set('x-test-token-venue', tokenVenue) : r
}

async function cerrar(shiftId: string, drawerId: string) {
  await prisma.$transaction([
    prisma.shift.update({ where: { id: shiftId }, data: { status: 'CLOSED', endTime: new Date() } }),
    prisma.cashDrawerSession.update({ where: { id: drawerId }, data: { status: 'CLOSED', closedAt: new Date() } }),
  ])
}

describe('D24 · GET /tpv/venues/:venueId/shift/identity (Postgres real)', () => {
  it('Cocina con permiso de cobrar ve cuál caja está abierta y cómo quedó la de ayer, sin una sola cifra', async () => {
    const n = await negocio(cuid())
    const dueno = await persona(n.venueId, StaffRole.OWNER)
    const cocina = await cocinaQueCobra(n.venueId)
    const ayer = await abrirTurnoDeCaja({ venueId: n.venueId, staffId: dueno, startingCash: 1500, source: 'TURNO_TPV' })
    await cerrar(ayer.shiftId, ayer.cashDrawerSessionId)
    const hoy = await abrirTurnoDeCaja({ venueId: n.venueId, staffId: dueno, startingCash: 2000, source: 'TURNO_TPV' })

    const r = await identidad(n.venueId, cocina, `?known=${ayer.shiftId}`)

    expect(r.status).toBe(200)
    expect(r.body.shift).toMatchObject({
      id: hoy.shiftId,
      venueId: n.venueId,
      status: 'OPEN',
      staffId: dueno,
      cashDrawerSessionId: hoy.cashDrawerSessionId,
    })
    expect(Number(r.body.shift.startingCash)).toBe(2000)
    expect(typeof r.body.shift.startTime).toBe('string')
    expect(Object.keys(r.body.shift).sort()).toEqual([
      'cashDrawerSessionId',
      'id',
      'staffId',
      'startTime',
      'startingCash',
      'status',
      'venueId',
    ])
    expect(r.body.known).toEqual({ id: ayer.shiftId, venueId: n.venueId, status: 'CLOSED' })
    expect(JSON.stringify(r.body)).not.toMatch(/total|expected|esperado|tips|sales/i)
  })

  it('sin caja abierta contesta shift null (no inventa ninguna)', async () => {
    const n = await negocio(cuid())
    const cocina = await cocinaQueCobra(n.venueId)
    const r = await identidad(n.venueId, cocina)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ shift: null, known: null })
  })

  it('Cocina SIN permiso de cobrar (los de fábrica) recibe 403', async () => {
    const n = await negocio(cuid())
    const cocina = await persona(n.venueId, StaffRole.KITCHEN)
    const r = await identidad(n.venueId, cocina)
    expect(r.status).toBe(403)
  })

  it('otra sucursal ⇒ 403: la persona de A no pregunta por la caja de B', async () => {
    const a = await negocio(cuid())
    const b = await negocio(cuid(), a.organizationId)
    const cocinaDeA = await cocinaQueCobra(a.venueId)
    const duenoDeB = await persona(b.venueId, StaffRole.OWNER)
    await abrirTurnoDeCaja({ venueId: b.venueId, staffId: duenoDeB, startingCash: 100, source: 'TURNO_TPV' })

    const r = await identidad(b.venueId, cocinaDeA, '', a.venueId)

    expect(r.status).toBe(403)
    expect(r.body.shift).toBeUndefined()
  })

  it('known de otra sucursal no se revela: known null', async () => {
    const a = await negocio(cuid())
    const b = await negocio(cuid(), a.organizationId)
    const cocinaDeA = await cocinaQueCobra(a.venueId)
    const duenoDeB = await persona(b.venueId, StaffRole.OWNER)
    const deB = await abrirTurnoDeCaja({ venueId: b.venueId, staffId: duenoDeB, startingCash: 100, source: 'TURNO_TPV' })

    const r = await identidad(a.venueId, cocinaDeA, `?known=${deB.shiftId}`)

    expect(r.status).toBe(200)
    expect(r.body.known).toBeNull()
  })
})
