/*
  tests/api-tests/mobile/terminal-payment-release.api.test.ts

  A5 (20-oct, «ninguna duda de un cobro de la tablet sin salida», E7): la declaración «no se cobró» por la capa HTTP REAL de
  `POST /mobile/venues/:venueId/terminal-payment/:requestId/release`, con el Express real y supertest. Lo que la ruta garantiza
  y una prueba de servicio no demuestra:

    · un MESERO (WAITER: `payments:create`, sin `payments:reconcile-uncharged`) LLEGA al servicio y recibe el 403 con código
      `SUPERVISOR_AUTHORIZATION_REQUIRED` —el mismo de «no presentó tarjeta»—, no el 403 genérico del middleware;
    · la cubeta del PIN sólo cuenta cuerpos CON `supervisorPin` y responde 429 por HTTP; sin PIN no cuenta (Codex plan-r1-3);
    · un error inesperado con el PIN en el cuerpo nunca saca el PIN ni en la respuesta ni en el log.
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
import type { Response } from 'supertest'
import { api, startApiServer } from '@tests/__helpers__/apiServer'
import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'

const app = require('../../../src/app').default
startApiServer(() => app)

const venueId = 'clvenuerelease0000000001'
const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RUTA = `/api/v1/mobile/venues/${venueId}/terminal-payment/${requestId}/release`
const PIN = '918273'
const cuerpo = (extra: Record<string, unknown> = {}) => ({
  resolutionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  statement: 'UNCHARGED_VERIFIED',
  statementVersion: 1,
  ...extra,
})
/** El token del POS móvil de un MESERO de este venue. */
const tokenDeMesero = () =>
  jwt.sign({ sub: 'staff-waiter', orgId: 'org_test', venueId, role: 'WAITER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockReset()
  prismaMock.$transaction.mockImplementation((callback: any) => callback(prismaMock))
  mirrorTokenRoleOnStaffVenue('WAITER', venueId)
  // La sesión es un mesero ACTIVO del venue, sin el permiso; ningún PIN pertenece a alguien con el permiso.
  prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) =>
    where.venueId === venueId && where.pin === undefined && where.staffId === 'staff-waiter'
      ? { id: 'sv-waiter', staffId: 'staff-waiter', role: 'WAITER', permissionSetId: null, permissionSet: null }
      : null,
  )
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(null)
})

describe('POST /mobile/venues/:venueId/terminal-payment/:requestId/release — la declaración por HTTP (A5, E7)', () => {
  it('P1 E7: un error inesperado con el PIN en el cuerpo nunca saca el PIN (ni en la respuesta ni en el log)', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(new Error(`db caída con supervisorPin=${PIN} adentro`))
    const res = await api()
      .post(RUTA)
      .set('Authorization', `Bearer ${tokenDeMesero()}`)
      .send(cuerpo({ supervisorPin: PIN }))
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain(PIN)
    const llamadas = JSON.stringify([
      (logger.error as jest.Mock).mock.calls,
      (logger.warn as jest.Mock).mock.calls,
      (logger.info as jest.Mock).mock.calls,
    ])
    expect(llamadas).not.toContain(PIN)
    expect(llamadas).not.toContain('db caída')
  })

  it('P1 Fix0: un PIN equivocado deja su asiento (como «no presentó tarjeta»), con la sesión y el venue, sin el PIN', async () => {
    const res = await api()
      .post(RUTA)
      .set('Authorization', `Bearer ${tokenDeMesero()}`)
      .send(cuerpo({ supervisorPin: PIN }))
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'SUPERVISOR_AUTHORIZATION_REQUIRED' })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TERMINAL_PAYMENT_UNCHARGED_AUTH_DENIED',
        staffId: 'staff-waiter',
        venueId,
        entity: 'TerminalPaymentRequest',
        entityId: requestId,
        data: expect.objectContaining({ requestId, code: 'SUPERVISOR_AUTHORIZATION_REQUIRED', conPin: true }),
      }),
    )
    expect(JSON.stringify((logAction as jest.Mock).mock.calls)).not.toContain(PIN)
    expect(JSON.stringify(res.body)).not.toContain(PIN)
  })

  it('P1 Fix1 (I-1): un token de OTRO negocio con PIN recibe 403 y NO gasta la cubeta del negocio víctima', async () => {
    // Sólo el mesero de ESTE venue es miembro; el atacante es de otra organización y apunta a este venue.
    prismaMock.staffVenue.findUnique.mockImplementation((args: any) => {
      const llave = args?.where?.staffId_venueId
      return Promise.resolve(
        llave?.venueId === venueId && llave?.staffId === 'staff-waiter'
          ? { role: 'WAITER', active: true, permissionSetId: null, permissionSet: null }
          : null,
      )
    })
    const tokenAjeno = jwt.sign(
      { sub: 'staff-ajeno', orgId: 'org_ajena', venueId: 'clvenueajeno000000000001', role: 'MANAGER' },
      process.env.ACCESS_TOKEN_SECRET as string,
      { expiresIn: '15m' },
    )
    // 205 intentos desde IPs distintas: si contaran, rebasarían la cubeta del VENUE (DEV: 200 por minuto).
    const estados: number[] = []
    for (let i = 0; i < 205; i++) {
      const res = await api()
        .post(RUTA)
        .set('Authorization', `Bearer ${tokenAjeno}`)
        .set('X-Forwarded-For', `10.9.${Math.floor(i / 250)}.${i % 250}`)
        .send(cuerpo({ supervisorPin: '0000' }))
      estados.push(res.status)
    }
    expect([...new Set(estados)]).toEqual([403])
    // El intento legítimo del negocio, después, no está bloqueado.
    const legitimo = await api()
      .post(RUTA)
      .set('Authorization', `Bearer ${tokenDeMesero()}`)
      .set('X-Forwarded-For', '10.8.0.1')
      .send(cuerpo({ supervisorPin: PIN }))
    expect({ status: legitimo.status, code: legitimo.body.code }).toEqual({ status: 403, code: 'SUPERVISOR_AUTHORIZATION_REQUIRED' })
  })

  /**
   * Codex servidor r4 (fix 1, regresión de A5): la PUERTA de la declaración acepta CUALQUIERA de `payments:create` o
   * `payments:reconcile-uncharged`. En develop pedía `payments:reconcile-uncharged`; A5 la cambió a `payments:create` y dejó en la
   * puerta (403) a quien tiene SÓLO el permiso de declarar (rol a la medida o lista propia). Liberar a secas sigue en `tpv:update`.
   */
  describe('la puerta de /release según el permiso (Codex servidor r4)', () => {
    /** Una sesión de este venue cuya lista propia (`PermissionSet`) es exactamente `permisos`. */
    function sesionConLista(permisos: string[]) {
      const permissionSet = { id: 'ps-a-la-medida', permissions: permisos }
      mirrorTokenRoleOnStaffVenue('WAITER', venueId, { permissionSet })
      prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) =>
        where.venueId === venueId && where.pin === undefined && where.staffId === 'staff-a-la-medida'
          ? { id: 'sv-a-la-medida', staffId: 'staff-a-la-medida', role: 'WAITER', permissionSetId: permissionSet.id, permissionSet }
          : null,
      )
      return jwt.sign({ sub: 'staff-a-la-medida', orgId: 'org_test', venueId, role: 'WAITER' }, process.env.ACCESS_TOKEN_SECRET as string, {
        expiresIn: '15m',
      })
    }

    it('P1 (a) SÓLO `payments:reconcile-uncharged`, sin `payments:create`: pasa la puerta Y la autorización del servicio', async () => {
      const token = sesionConLista(['payments:reconcile-uncharged'])
      // Lo primero que hace el servicio DESPUÉS de autorizar es enumerar los vínculos: se corta ahí, a propósito, para fijar
      // por HTTP que la puerta y la autorización dejaron pasar a esta persona (la aceptación entera, contra Postgres, vive en
      // `terminalPaymentReleaseRuta.integration.test.ts`).
      prismaMock.terminalPaymentAttemptLink.findMany.mockRejectedValueOnce(new Error('alto: ya pasó la autorización'))
      const res = await api().post(RUTA).set('Authorization', `Bearer ${token}`).send(cuerpo())
      expect(res.status).toBe(500)
      expect(prismaMock.terminalPaymentAttemptLink.findMany).toHaveBeenCalledTimes(1)
      expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'TERMINAL_PAYMENT_UNCHARGED_AUTH_DENIED' }))
    })

    it('P1 (b) SÓLO `payments:create` (el mesero) y sin PIN: llega al servicio y recibe SUPERVISOR_AUTHORIZATION_REQUIRED', async () => {
      const res = await api().post(RUTA).set('Authorization', `Bearer ${tokenDeMesero()}`).send(cuerpo())
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'SUPERVISOR_AUTHORIZATION_REQUIRED' })
      expect(prismaMock.terminalPaymentRequest.findFirst).not.toHaveBeenCalled()
    })

    it('P1 (c) sin NINGUNO de los dos permisos: 403 en la puerta con la MISMA negación de develop (bitácora, `required`, `overridable`)', async () => {
      // Re-revisión Codex r4 (M1): la negación es la de `checkPermission('payments:reconcile-uncharged')`, como en `c137ec666`.
      for (const conPinDeGerente of [true, false]) {
        jest.clearAllMocks()
        prismaMock.venueSettings.findUnique.mockResolvedValue({ managerPinOverrideEnabled: conPinDeGerente } as any)
        const token = sesionConLista(['orders:read'])
        const res = await api().post(RUTA).set('Authorization', `Bearer ${token}`).send(cuerpo())
        expect(res.status).toBe(403)
        expect(res.body).toEqual({
          error: 'Forbidden',
          message: "Permission 'payments:reconcile-uncharged' required",
          required: 'payments:reconcile-uncharged',
          userRole: 'WAITER',
          ...(conPinDeGerente ? { overridable: true } : {}),
        })
        expect(logAction).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'PERMISSION_DENIED',
            entity: 'permission',
            entityId: 'payments:reconcile-uncharged',
            staffId: 'staff-a-la-medida',
            venueId,
            data: expect.objectContaining({ permission: 'payments:reconcile-uncharged', method: 'POST', hasPermissionSet: true }),
          }),
        )
        expect(prismaMock.$transaction).not.toHaveBeenCalled()
        expect(prismaMock.terminalPaymentRequest.findFirst).not.toHaveBeenCalled()
      }
    })

    it('P1 (d) liberar A SECAS con sólo `payments:reconcile-uncharged`: 403 en la puerta (pide `tpv:update`)', async () => {
      const token = sesionConLista(['payments:reconcile-uncharged'])
      const res = await api().post(RUTA).set('Authorization', `Bearer ${token}`).send({ reason: 'la PAX se reinició' })
      expect(res.status).toBe(403)
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(prismaMock.terminalPaymentRequest.findFirst).not.toHaveBeenCalled()
    })
  })

  // 🔴 VA AL FINAL: agota la cubeta por IP del proceso entero.
  it('P1 E7: demasiados PIN seguidos en /release dan 429 por HTTP; sin PIN no cuentan', async () => {
    // Sin PIN: el mesero LLEGA al servicio (la puerta es `payments:create`) y recibe el código de la declaración. DEV permite 100
    // por minuto por IP: 105 seguidas superan la cubeta si la ruta las contara.
    const sinPin: { status: number; code: unknown; conCabecera: boolean }[] = []
    for (let i = 0; i < 105; i++) {
      const res = await api().post(RUTA).set('Authorization', `Bearer ${tokenDeMesero()}`).send(cuerpo())
      sinPin.push({
        status: res.status,
        code: res.body.code,
        conCabecera: res.headers['ratelimit-limit'] !== undefined || res.headers['ratelimit-remaining'] !== undefined,
      })
    }
    expect([...new Set(sinPin.map(r => `${r.status} ${r.code} ${r.conCabecera}`))]).toEqual(['403 SUPERVISOR_AUTHORIZATION_REQUIRED false'])
    // Sin autorización no se buscó ni se creó nada (la AUTORIZACIÓN va antes de la fila: Codex plan-r1-8).
    expect(prismaMock.terminalPaymentRequest.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.terminalPaymentRequest.createMany).not.toHaveBeenCalled()

    // Con PIN (equivocado: adivinar) la cubeta SÍ cuenta, hasta el 429. Se pide HASTA el primer 429: la ventana de DEV es fija de
    // 1 min y si se cumple a media corrida el contador vuelve a cero.
    const conPin: number[] = []
    let primer429: Response | null = null
    for (let i = 0; i < 250 && !primer429; i++) {
      const res = await api()
        .post(RUTA)
        .set('Authorization', `Bearer ${tokenDeMesero()}`)
        .send(cuerpo({ supervisorPin: PIN }))
      conPin.push(res.status)
      if (res.status === 429) primer429 = res
      else expect(res.body.code).toBe('SUPERVISOR_AUTHORIZATION_REQUIRED')
    }
    expect(primer429).not.toBeNull()
    expect(primer429?.body).toEqual({
      error: 'RATE_LIMIT_EXCEEDED',
      code: 'RATE_LIMIT_EXCEEDED',
      message: expect.any(String),
      retryAfter: 15 * 60,
    })
    expect(Number(primer429?.headers['retry-after'])).toBeGreaterThan(0)

    // Y sin PIN sigue pasando aunque la cubeta esté agotada.
    const despues = await api().post(RUTA).set('Authorization', `Bearer ${tokenDeMesero()}`).send(cuerpo())
    expect({ status: despues.status, code: despues.body.code }).toEqual({ status: 403, code: 'SUPERVISOR_AUTHORIZATION_REQUIRED' })
  })
})
