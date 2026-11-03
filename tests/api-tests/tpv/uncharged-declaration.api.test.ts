/*
  tests/api-tests/tpv/uncharged-declaration.api.test.ts

  Botón «No se cobró» del banner verde de la terminal (founder, 3-nov: «A»). La capa HTTP REAL de
  `POST /tpv/venues/:venueId/terminal-payment/requests/:requestId/uncharged-declaration`, con el Express real y supertest.

  Lo que la RUTA garantiza y una prueba de servicio no demuestra:
    · por aquí sólo se DECLARA: sin `statement: UNCHARGED_VERIFIED` es 400 y no libera (`permisoDeLiberacion` por sí solo dejaría
      a un gerente liberar a secas);
    · ese 400 va ANTES del limitador y del permiso: no gasta la cubeta del PIN de gerente;
    · sin token 401, y un token de otro negocio se queda en la pertenencia;
    · la puerta es la misma del POS: el mesero llega al servicio y recibe el 403 con código; quien no tiene ningún permiso, no.
  La aceptación completa, contra Postgres, vive en `tests/integration/tpv/unchargedDeclarationRuta.integration.test.ts`.
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

import jwt from 'jsonwebtoken'
import { api, startApiServer } from '@tests/__helpers__/apiServer'
import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'
import { logAction } from '@/services/dashboard/activity-log.service'

const app = require('../../../src/app').default
startApiServer(() => app)

const venueId = 'clvenuedeclara0000000001'
const requestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const RUTA = `/api/v1/tpv/venues/${venueId}/terminal-payment/requests/${requestId}/uncharged-declaration`
const PIN = '918273'
const cuerpo = (extra: Record<string, unknown> = {}) => ({
  resolutionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  statement: 'UNCHARGED_VERIFIED',
  statementVersion: 1,
  ...extra,
})

const tokenDe = (staffId: string, role: string, venue = venueId) =>
  jwt.sign({ sub: staffId, orgId: 'org_test', venueId: venue, role }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })

/** Una sesión de este venue, como la que deja la TPV: rol real en `StaffVenue`, sin el permiso de declarar si es mesero. */
function sesion(staffId: string, role: string) {
  mirrorTokenRoleOnStaffVenue(role, venueId)
  prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) =>
    where.venueId === venueId && where.pin === undefined && where.staffId === staffId
      ? { id: `sv-${staffId}`, staffId, role, permissionSetId: null, permissionSet: null }
      : null,
  )
  return tokenDe(staffId, role)
}

/** Que no se haya tocado nada del dinero: ni la transacción de la declaración ni la fila. */
function noSeLiberoNada() {
  expect(prismaMock.$transaction).not.toHaveBeenCalled()
  expect(prismaMock.terminalPaymentRequest.findFirst).not.toHaveBeenCalled()
  expect(prismaMock.terminalPaymentRequest.update).not.toHaveBeenCalled()
  expect(prismaMock.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockReset()
  prismaMock.$transaction.mockImplementation((callback: any) => callback(prismaMock))
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(null)
})

describe('POST /tpv/venues/:venueId/terminal-payment/requests/:requestId/uncharged-declaration', () => {
  describe('por aquí sólo se declara', () => {
    it('P1 sin `statement` ⇒ 400 y no libera, aunque quien pide sea un gerente con `tpv:update`', async () => {
      const token = sesion('staff-manager', 'MANAGER')
      for (const body of [{}, { reason: 'la terminal se reinició' }, { reason: 'ya revisé, no se cobró', confirm: true }]) {
        const res = await api().post(RUTA).set('Authorization', `Bearer ${token}`).send(body)
        expect(res.status).toBe(400)
        expect(res.body).toMatchObject({ success: false, released: false, code: 'UNCHARGED_STATEMENT_REQUIRED' })
      }
      noSeLiberoNada()
    })

    it('P1 con otro `statement` ⇒ 400 y no libera: ni el del banco ni el de «no presentó tarjeta»', async () => {
      const token = sesion('staff-manager', 'MANAGER')
      for (const statement of [
        'BANK_DECLINED',
        'NO_INSTRUMENT_PRESENTED',
        'NO_BANK_TRACE_AFTER_WINDOW',
        'uncharged_verified',
        true,
        null,
      ]) {
        const res = await api().post(RUTA).set('Authorization', `Bearer ${token}`).send(cuerpo({ statement }))
        expect(res.status).toBe(400)
      }
      noSeLiberoNada()
    })

    it('P1 ese 400 va ANTES del limitador: 105 cuerpos con PIN y sin `statement` no gastan la cubeta del PIN (DEV: 100 por minuto)', async () => {
      const token = sesion('staff-waiter', 'WAITER')
      const estados = new Set<number>()
      for (let i = 0; i < 105; i++) {
        const res = await api()
          .post(RUTA)
          .set('Authorization', `Bearer ${token}`)
          .set('X-Forwarded-For', '10.7.0.1')
          .send({ supervisorPin: PIN })
        estados.add(res.status)
      }
      expect([...estados]).toEqual([400])
    })
  })

  describe('las puertas', () => {
    it('P1 sin token ⇒ 401', async () => {
      const res = await api().post(RUTA).send(cuerpo())
      expect(res.status).toBe(401)
      noSeLiberoNada()
    })

    it('P1 un token de OTRO negocio se queda en la pertenencia: 403, y ni con PIN llega a la cubeta del negocio ajeno', async () => {
      mirrorTokenRoleOnStaffVenue('WAITER', venueId)
      prismaMock.staffVenue.findUnique.mockImplementation((args: any) => {
        const llave = args?.where?.staffId_venueId
        return Promise.resolve(
          llave?.venueId === venueId && llave?.staffId === 'staff-waiter'
            ? { role: 'WAITER', active: true, permissionSetId: null, permissionSet: null }
            : null,
        )
      })
      const tokenAjeno = tokenDe('staff-ajeno', 'MANAGER', 'clvenueajeno000000000001')
      const res = await api()
        .post(RUTA)
        .set('Authorization', `Bearer ${tokenAjeno}`)
        .set('X-Forwarded-For', '10.7.0.2')
        .send(cuerpo({ supervisorPin: PIN }))
      expect(res.status).toBe(403)
      expect(res.headers['ratelimit-limit']).toBeUndefined()
      expect(res.headers['ratelimit-remaining']).toBeUndefined()
      noSeLiberoNada()
    })

    it('P1 el mesero (`payments:create`, sin declarar) y sin PIN LLEGA al servicio: 403 SUPERVISOR_AUTHORIZATION_REQUIRED, sin leer la fila', async () => {
      const token = sesion('staff-waiter', 'WAITER')
      const res = await api().post(RUTA).set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', '10.7.0.3').send(cuerpo())
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'SUPERVISOR_AUTHORIZATION_REQUIRED' })
      expect(res.body.message).toBe('Pide a un gerente que ingrese su PIN para confirmar que este cobro no pasó.')
      expect(prismaMock.terminalPaymentRequest.findFirst).not.toHaveBeenCalled()
      expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'TERMINAL_PAYMENT_UNCHARGED_AUTH_DENIED', venueId }))
    })

    it('P1 sin ninguno de los dos permisos ⇒ 403 en la puerta, con la misma negación que el POS', async () => {
      const permissionSet = { id: 'ps-solo-leer', permissions: ['orders:read'] }
      mirrorTokenRoleOnStaffVenue('WAITER', venueId, { permissionSet })
      const res = await api()
        .post(RUTA)
        .set('Authorization', `Bearer ${tokenDe('staff-a-la-medida', 'WAITER')}`)
        .set('X-Forwarded-For', '10.7.0.4')
        .send(cuerpo())
      expect(res.status).toBe(403)
      expect(res.body.required).toBe('payments:reconcile-uncharged')
      noSeLiberoNada()
    })

    // 🔴 VA AL FINAL: agota la cubeta por IP del proceso entero.
    it('P1 demasiados PIN seguidos dan 429 por HTTP: es la MISMA cubeta del PIN de gerente', async () => {
      const token = sesion('staff-waiter', 'WAITER')
      let primer429: { status: number; body: any } | null = null
      for (let i = 0; i < 250 && !primer429; i++) {
        const res = await api()
          .post(RUTA)
          .set('Authorization', `Bearer ${token}`)
          .set('X-Forwarded-For', '10.7.0.5')
          .send(cuerpo({ supervisorPin: PIN }))
        if (res.status === 429) primer429 = res
        else expect(res.body.code).toBe('SUPERVISOR_AUTHORIZATION_REQUIRED')
      }
      expect(primer429?.body).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' })
    })
  })
})
