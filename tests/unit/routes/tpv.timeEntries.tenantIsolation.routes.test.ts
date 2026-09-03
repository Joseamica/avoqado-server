/**
 * Rutas de asistencia de la TPV — aislamiento por venue y por persona.
 * Auditoría Codex de la fase 2 del checador (2026-08-26), P1-1 y P1-2.
 *
 * Antes de este arreglo:
 *   - P1-1 `POST /time-entries/:timeEntryId/break/start|end` sólo pedía JWT y el servicio
 *     buscaba la checada por `id + staffId` — y la TPV NO manda `staffId` (sólo el id en la
 *     ruta), así que el filtro era un no-op: cualquier token alteraba checadas de OTRO venue.
 *   - P1-2 `GET /venues/:venueId/staff/:staffId/time-entries` ("mis checadas") y
 *     `GET /staff/:staffId/time-summary` tomaban venue y persona de la URL sin cotejar con
 *     el token: cualquier empleado leía la asistencia de cualquiera, de cualquier venue.
 *
 * Regla que queda: la checada se acota por el venue DEL TOKEN (no del body ni de la URL), y
 * ver checadas ajenas exige `tpv-time-entries:read` — ver las PROPIAS nunca pide permiso.
 *
 * Misma técnica que tpv.addItems-timeEntries.security.routes.test.ts: router REAL,
 * validateVenueAccess REAL, checkPermission REAL, controlador REAL; se mockean auth (header),
 * prisma y el servicio.
 */

import express from 'express'
import type { Server } from 'http'
import request from 'supertest'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) {
      req.authContext = JSON.parse(ctx as string)
      const prismaMock = jest.requireMock('@/utils/prismaClient').default
      prismaMock.staffVenue.findUnique.mockResolvedValue({
        role: req.authContext.role,
        active: true,
        permissionSetId: null,
        permissionSet: null,
      })
    }
    next()
  },
}))

jest.mock('@/middlewares/validation', () => ({
  validateRequest: () => (_req: any, _res: any, next: any) => next(),
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findFirst: jest.fn(), findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    staffOrganization: { findUnique: jest.fn() },
    venueRolePermission: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

jest.mock('@/services/mobile/permission-override.mobile.service', () => ({
  isManagerPinOverrideEnabled: jest.fn().mockResolvedValue(false),
  consumePermissionOverride: jest.fn().mockResolvedValue(null),
}))

// El servicio se mockea entero: lo que se prueba es QUÉ le llega desde el controlador.
jest.mock('@/services/tpv/time-entry.tpv.service', () => ({
  startBreak: jest.fn().mockResolvedValue({ id: 'te-1', status: 'ON_BREAK' }),
  endBreak: jest.fn().mockResolvedValue({ id: 'te-1', status: 'CLOCKED_IN' }),
  getTimeEntries: jest.fn().mockResolvedValue({ timeEntries: [], total: 0 }),
  getStaffTimeSummary: jest.fn().mockResolvedValue({ totalHours: 0, timeEntries: [] }),
}))

import prisma from '@/utils/prismaClient'
import * as timeEntryService from '@/services/tpv/time-entry.tpv.service'
import tpvRouter from '@/routes/tpv.routes'

const svc = timeEntryService as jest.Mocked<typeof timeEntryService>
const staffVenueFindFirst = (prisma as any).staffVenue.findFirst as jest.Mock
const venueRolePermissionFindUnique = (prisma as any).venueRolePermission.findUnique as jest.Mock

const VENUE_A = 'venue-A'
const VENUE_B = 'venue-B'
const ME = 'staff-me'
const OTHER = 'staff-other'

const waiterMe = { userId: ME, orgId: 'org-1', venueId: VENUE_A, role: 'WAITER' }
const managerMe = { userId: ME, orgId: 'org-1', venueId: VENUE_A, role: 'MANAGER' }

function authHeader(ctx: object): Record<string, string> {
  return { 'x-test-auth-context': JSON.stringify(ctx) }
}

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/tpv', tpvRouter)
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.statusCode || 500).json({ error: err?.message || 'error' }))
  return app
}

let server: Server
beforeAll(() => {
  server = createApp().listen(0)
})
afterAll(done => {
  server.close(done)
})

beforeEach(() => {
  jest.clearAllMocks()
  staffVenueFindFirst.mockResolvedValue(null)
  venueRolePermissionFindUnique.mockResolvedValue(null)
})

describe('P1-1 · descansos: la checada se acota por el venue DEL TOKEN', () => {
  it('break/start manda al servicio el venueId del token, aunque el body traiga otro', async () => {
    const res = await request(server)
      .post('/tpv/time-entries/te-1/break/start')
      .set(authHeader(waiterMe))
      .send({ venueId: VENUE_B, staffId: OTHER })

    expect(res.status).toBe(200)
    expect(svc.startBreak).toHaveBeenCalledTimes(1)
    expect(svc.startBreak.mock.calls[0][0]).toEqual(expect.objectContaining({ timeEntryId: 'te-1', venueId: VENUE_A }))
    expect(svc.startBreak.mock.calls[0][0].venueId).not.toBe(VENUE_B)
  })

  it('break/end igual: venueId del token', async () => {
    const res = await request(server).post('/tpv/time-entries/te-1/break/end').set(authHeader(waiterMe)).send({})

    expect(res.status).toBe(200)
    expect(svc.endBreak.mock.calls[0][0]).toEqual(expect.objectContaining({ timeEntryId: 'te-1', venueId: VENUE_A }))
  })

  it('sin body (como manda la TPV real) sigue funcionando — el contrato del cliente no cambia', async () => {
    const res = await request(server).post('/tpv/time-entries/te-1/break/start').set(authHeader(waiterMe))
    expect(res.status).toBe(200)
    expect(svc.startBreak.mock.calls[0][0]).toEqual(expect.objectContaining({ venueId: VENUE_A }))
  })
})

describe('P1-2 · "mis checadas": venue de la URL == token, y persona propia o con permiso', () => {
  const my = (venue: string, staff: string) => `/tpv/venues/${venue}/staff/${staff}/time-entries`

  it('token de A sobre URL de B → 403 de validateVenueAccess, el servicio ni se llama', async () => {
    const res = await request(server).get(my(VENUE_B, ME)).set(authHeader(waiterMe))
    expect(res.status).toBe(403)
    expect(res.body.message).toBe('No tienes acceso a este venue')
    expect(svc.getTimeEntries).not.toHaveBeenCalled()
  })

  it('un WAITER ve las SUYAS sin ningún permiso especial (el reloj de pared sigue funcionando)', async () => {
    const res = await request(server).get(my(VENUE_A, ME)).set(authHeader(waiterMe))
    expect(res.status).toBe(200)
    expect(svc.getTimeEntries.mock.calls[0][0]).toEqual(expect.objectContaining({ venueId: VENUE_A, staffId: ME }))
  })

  it('un WAITER NO ve las de un compañero → 403, y la lectura rebotada NO va a la bitácora', async () => {
    const res = await request(server).get(my(VENUE_A, OTHER)).set(authHeader(waiterMe))
    expect(res.status).toBe(403)
    expect(svc.getTimeEntries).not.toHaveBeenCalled()
    // Contrato NUEVO (debeAuditarDenegacion, 2026-09-01): una LECTURA rebotada dentro
    // del propio venue no cambió nada y NO se escribe en el ActivityLog del dueño —
    // medido en Testarudo: 122/122 registros de su bitácora eran este ruido de GETs
    // de la propia app. La seguridad (403 + servicio sin llamar) queda intacta, y un
    // cruce de TENANT sí se audita siempre (test de arriba + auditoriaDeDenegaciones).
    const { logAction } = jest.requireMock('@/services/dashboard/activity-log.service')
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'PERMISSION_DENIED' }))
  })

  it('un MANAGER (tpv-time-entries:read) sí ve las de un compañero', async () => {
    const res = await request(server).get(my(VENUE_A, OTHER)).set(authHeader(managerMe))
    expect(res.status).toBe(200)
    expect(svc.getTimeEntries.mock.calls[0][0]).toEqual(expect.objectContaining({ venueId: VENUE_A, staffId: OTHER }))
  })
})

describe('P1-2 · resumen de horas: misma guarda, y SIEMPRE acotado al venue del token', () => {
  const summary = (staff: string) => `/tpv/staff/${staff}/time-summary?startDate=2026-08-01&endDate=2026-08-26`

  it('propio → 200, con venueId del token', async () => {
    const res = await request(server).get(summary(ME)).set(authHeader(waiterMe))
    expect(res.status).toBe(200)
    expect(svc.getStaffTimeSummary.mock.calls[0][0]).toEqual(expect.objectContaining({ staffId: ME, venueId: VENUE_A }))
  })

  it('ajeno sin permiso → 403, servicio no llamado', async () => {
    const res = await request(server).get(summary(OTHER)).set(authHeader(waiterMe))
    expect(res.status).toBe(403)
    expect(svc.getStaffTimeSummary).not.toHaveBeenCalled()
  })

  it('ajeno con permiso (MANAGER) → 200, y aun así acotado al venue del token', async () => {
    const res = await request(server).get(summary(OTHER)).set(authHeader(managerMe))
    expect(res.status).toBe(200)
    expect(svc.getStaffTimeSummary.mock.calls[0][0]).toEqual(expect.objectContaining({ staffId: OTHER, venueId: VENUE_A }))
  })
})
