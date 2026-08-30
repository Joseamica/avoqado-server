/*
  tests/api-tests/dashboard/overtime-approval.api.test.ts

  La CAPA HTTP de las horas extra, de punta a punta: arranca el Express real y le pega a las
  rutas con supertest.

  🔴 Existe porque la prueba de permisos que ya había es ESTÁTICA (lee el archivo de rutas y
  comprueba el nombre del permiso). Eso demuestra que alguien escribió `attendance:manage`
  en el sitio correcto, NO que un cajero reciba un 403 de verdad. Este archivo sí lo demuestra:
  ejercita el encadenado completo authenticateToken → checkPermission → validateRequest →
  controlador.

  Es también lo que sustituye al recorrido manual en el navegador, y cubre más: los 401, los
  403 por rol, el aislamiento entre negocios y el rechazo de Zod no se prueban haciendo clic.

  Middleware real de estas rutas:
    authenticateTokenMiddleware → checkPermission('attendance:read'|'attendance:manage')
    → validateRequest(<esquema>) → controlador

  Hechos de permisos (src/lib/permissions.ts):
  - `attendance:read` y `attendance:manage` → MANAGER, ADMIN, OWNER (y SUPERADMIN por comodín).
  - CASHIER y WAITER NO los tienen ni los implican: por eso reciben 403 de verdad. Ese es el
    punto — la primera versión del checador reusó `tpv-time-entries:*`, que SÍ tiene el piso, y
    fue un P1 en la auditoría de Codex.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))

// La rejilla se simula: aquí se prueba la CAPA HTTP, no la aritmética (que tiene sus 34
// pruebas puras). Lo que importa es que el controlador la llame y devuelva lo que produce.
jest.mock('../../../src/services/dashboard/attendance.dashboard.service', () => ({
  __esModule: true,
  buildAttendanceGrid: jest.fn(),
}))

import jwt from 'jsonwebtoken'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'

const app = require('../../../src/app').default
const { buildAttendanceGrid } = require('../../../src/services/dashboard/attendance.dashboard.service')

const DASH = '/api/v1/dashboard'
const venueId = 'clvenueovertime000000001'
const otherVenueId = 'clvenueovertime000000002'
const staffVenueId = 'clsvovertime00000000001'
const DIA = '2026-08-24'

const RUTA = `${DASH}/venues/${venueId}/team/${staffVenueId}/overtime-approval`
const RESUMEN = `${DASH}/venues/${venueId}/attendance/payroll-summary?startDate=2026-08-24&endDate=2026-08-30`

function makeToken(role: string, tokenVenueId: string = venueId) {
  mirrorTokenRoleOnStaffVenue(role, tokenVenueId)
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId: tokenVenueId, role }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

/** La rejilla dice que ese día se midieron `minutos` de hora extra. */
function midio(minutos: number) {
  ;(buildAttendanceGrid as jest.Mock).mockResolvedValue({
    cells: [{ staffVenueId, date: DIA, overtimeMinutes: minutos, staffId: 's1', name: 'Ana Martínez', status: 'ON_TIME' }],
    graceMinutes: 10,
    timezone: 'America/Mexico_City',
    workedTotalsByStaff: new Map(),
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  // checkPermission determinista: sin bypass de SUPERADMIN ni overrides personalizados.
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.overtimeApproval.findMany.mockResolvedValue([])
  prismaMock.overtimeApproval.upsert.mockResolvedValue({ id: 'ap1' })
  midio(120)
})

describe('PUT overtime-approval — la capa HTTP de verdad', () => {
  describe('401 sin credencial', () => {
    it('sin cabecera Authorization', async () => {
      const res = await request(app).put(RUTA).send({ date: DIA, minutesApproved: 60 })
      expect(res.status).toBe(401)
    })

    it('con un Bearer mal formado', async () => {
      const res = await request(app).put(RUTA).set('Authorization', 'Bearer no.es.un.jwt').send({ date: DIA, minutesApproved: 60 })
      expect(res.status).toBe(401)
    })
  })

  describe('🔴 403 por ROL — el piso no autoriza horas extra', () => {
    it.each([['CASHIER'], ['WAITER']])('%s recibe 403 de verdad, no sólo por el nombre del permiso', async role => {
      const res = await request(app)
        .put(RUTA)
        .set('Authorization', `Bearer ${makeToken(role)}`)
        .send({ date: DIA, minutesApproved: 60 })
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('required', 'attendance:manage')
      // Y no llegó a escribir nada.
      expect(prismaMock.overtimeApproval.upsert).not.toHaveBeenCalled()
    })
  })

  it('🔴 403 entre negocios: un token de otro venue no autoriza aquí', async () => {
    const res = await request(app)
      .put(RUTA)
      .set('Authorization', `Bearer ${makeToken('OWNER', otherVenueId)}`)
      .send({ date: DIA, minutesApproved: 60 })
    expect(res.status).toBe(403)
    expect(prismaMock.overtimeApproval.upsert).not.toHaveBeenCalled()
  })

  describe('roles que SÍ pueden', () => {
    it.each([['MANAGER'], ['ADMIN'], ['OWNER']])('%s autoriza y recibe 200', async role => {
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: staffVenueId, staffId: 's1' } as never)
      const res = await request(app)
        .put(RUTA)
        .set('Authorization', `Bearer ${makeToken(role)}`)
        .send({ date: DIA, minutesApproved: 90 })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ date: DIA, minutesApproved: 90, minutesMeasured: 120 })
    })
  })

  describe('validación de Zod — forma del cuerpo', () => {
    function comoGerente() {
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: staffVenueId, staffId: 's1' } as never)
      return makeToken('MANAGER')
    }

    it('una fecha con formato inválido se rechaza con 400', async () => {
      const res = await request(app).put(RUTA).set('Authorization', `Bearer ${comoGerente()}`).send({ date: 'ayer', minutesApproved: 60 })
      expect(res.status).toBe(400)
    })

    it('minutos negativos se rechazan con 400', async () => {
      const res = await request(app).put(RUTA).set('Authorization', `Bearer ${comoGerente()}`).send({ date: DIA, minutesApproved: -5 })
      expect(res.status).toBe(400)
    })

    it('minutos con decimales se rechazan con 400', async () => {
      const res = await request(app).put(RUTA).set('Authorization', `Bearer ${comoGerente()}`).send({ date: DIA, minutesApproved: 1.5 })
      expect(res.status).toBe(400)
    })

    it('sin minutos se rechaza con 400', async () => {
      const res = await request(app).put(RUTA).set('Authorization', `Bearer ${comoGerente()}`).send({ date: DIA })
      expect(res.status).toBe(400)
    })
  })

  describe('reglas de negocio, ya con permiso', () => {
    function comoGerente() {
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: staffVenueId, staffId: 's1' } as never)
      return makeToken('MANAGER')
    }

    it('🔴 autorizar MÁS de lo medido rebota con 400 y el motivo REAL', async () => {
      midio(120)
      const res = await request(app).put(RUTA).set('Authorization', `Bearer ${comoGerente()}`).send({ date: DIA, minutesApproved: 999 })
      expect(res.status).toBe(400)
      expect(JSON.stringify(res.body)).toMatch(/no puedes autorizar más/i)
      expect(prismaMock.overtimeApproval.upsert).not.toHaveBeenCalled()
    })

    it('un día sin horas extra rebota con 400', async () => {
      midio(0)
      const res = await request(app).put(RUTA).set('Authorization', `Bearer ${comoGerente()}`).send({ date: DIA, minutesApproved: 60 })
      expect(res.status).toBe(400)
    })

    it('autorizar CERO (negar) sí se acepta', async () => {
      const res = await request(app).put(RUTA).set('Authorization', `Bearer ${comoGerente()}`).send({ date: DIA, minutesApproved: 0 })
      expect(res.status).toBe(200)
      expect(res.body.minutesApproved).toBe(0)
    })

    it('🔴 los minutos MEDIDOS salen de la REJILLA: cambiar la rejilla cambia la respuesta', async () => {
      // Ésta es la que de verdad guarda el invariante. Si alguien hiciera que el servicio
      // dejara de consultar la rejilla, este número dejaría de seguirla y la prueba fallaría.
      midio(77)
      const res = await request(app).put(RUTA).set('Authorization', `Bearer ${comoGerente()}`).send({ date: DIA, minutesApproved: 50 })
      expect(res.status).toBe(200)
      expect(res.body.minutesMeasured).toBe(77)
      expect(prismaMock.overtimeApproval.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ minutesMeasured: 77 }) }),
      )
    })

    it('🔴 un `minutesMeasured` mandado por el cliente NUNCA llega al controlador (lo descarta Zod)', async () => {
      // 🔴 Esta prueba existe por una lección concreta: la versión anterior mandaba
      // `minutesMeasured: 480` en el cuerpo y afirmaba que "el servidor lo ignora". Era cierto,
      // pero NO guardaba nada — al romper A PROPÓSITO el controlador Y el servicio para que
      // confiaran en el cuerpo, la prueba seguía en verde. El motivo: `validateRequest` hace
      // `req.body = parsedResult.data.body`, y Zod descarta las llaves desconocidas ANTES del
      // controlador. Esa es la defensa real, así que es la que hay que fijar por su nombre.
      const { ApproveOvertimeSchema } = require('../../../src/schemas/dashboard/attendance.schema')
      const parsed = ApproveOvertimeSchema.parse({
        params: { venueId, staffVenueId },
        body: { date: DIA, minutesApproved: 120, minutesMeasured: 480 },
      })
      expect(parsed.body).not.toHaveProperty('minutesMeasured')
      expect(parsed.body).toEqual({ date: DIA, minutesApproved: 120 })
    })
  })
})

describe('GET payroll-summary — la respuesta trae los campos de horas extra', () => {
  it('🔴 el JSON incluye lo medido, lo autorizado y lo pendiente', async () => {
    // Es lo que el dashboard consume: si el contrato cambiara, la columna saldría vacía.
    ;(buildAttendanceGrid as jest.Mock).mockResolvedValue({
      cells: [
        {
          staffVenueId,
          staffId: 's1',
          name: 'Ana Martínez',
          date: DIA,
          status: 'ON_TIME',
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          clockInTime: new Date(),
          clockOutTime: new Date(),
          absenceType: null,
          overtimeMinutes: 120,
          overtimeApprovedMinutes: null,
        },
      ],
      graceMinutes: 10,
      timezone: 'America/Mexico_City',
      workedTotalsByStaff: new Map([['s1', { totalHours: 10, breakMinutes: 0 }]]),
    })

    const res = await request(app).get(RESUMEN).set('Authorization', `Bearer ${makeToken('MANAGER')}`)
    expect(res.status).toBe(200)
    const fila = res.body.rows[0]
    expect(fila).toMatchObject({
      overtimeMinutes: 120,
      overtimeApprovedMinutes: 0,
      overtimePendingMinutes: 120,
      overtimeDoubleMinutes: 0,
      overtimeTripleMinutes: 0,
    })
    expect(Array.isArray(fila.overtimeWeeks)).toBe(true)
    expect(Array.isArray(fila.overtimeDaysToReview)).toBe(true)
  })

  it('leer el resumen sólo pide `attendance:read`, no `:manage`', async () => {
    ;(buildAttendanceGrid as jest.Mock).mockResolvedValue({
      cells: [],
      graceMinutes: 10,
      timezone: 'America/Mexico_City',
      workedTotalsByStaff: new Map(),
    })
    const res = await request(app).get(RESUMEN).set('Authorization', `Bearer ${makeToken('MANAGER')}`)
    expect(res.status).toBe(200)
  })

  it('un cajero NO puede leer el resumen de nómina', async () => {
    const res = await request(app).get(RESUMEN).set('Authorization', `Bearer ${makeToken('CASHIER')}`)
    expect(res.status).toBe(403)
  })
})
