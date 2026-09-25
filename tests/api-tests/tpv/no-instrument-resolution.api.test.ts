/*
  tests/api-tests/tpv/no-instrument-resolution.api.test.ts

  La declaración del cajero «no se presentó tarjeta» (plan 16-sep, Task 4): la capa HTTP de
  `POST /tpv/venues/:venueId/terminal-payment/attempts/:attemptId/no-instrument-resolution`, con el Express real y supertest,
  calcada de `terminal-payment-attempts.api.test.ts` (S6). Lo que la ruta garantiza y que una prueba de servicio no demuestra:

    · sin token → 401; un token SIN identidad de terminal (dashboard / POS móvil) → 403 TERMINAL_IDENTITY_REQUIRED, sin tocar la base;
    · el venue de la URL tiene que ser el del token (403 de `validateVenueAccess`), sin tocar la base;
    · la IDENTIDAD sale del `sub` del JWT de la terminal, nunca del cuerpo: una sesión OWNER declara sin PIN (200, by SESSION), una
      sesión CASHIER sin PIN recibe un 403 REAL (SUPERVISOR_AUTHORIZATION_REQUIRED) y con el PIN del OWNER declara (by SUPERVISOR_PIN);
    · una sesión cuyo `sub` ya no es miembro activo del venue es 403 SESSION_NOT_IN_VENUE aunque mande un PIN válido;
    · los 403 de autorización dejan rastro (`TERMINAL_PAYMENT_NO_INSTRUMENT_AUTH_DENIED`) y el PIN nunca se escribe ni se serializa;
    · el 200 conserva TODOS los campos de S6 (contrato con las apps publicadas) y añade `resolution`.
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
import request from 'supertest'
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'
import { logAction } from '@/services/dashboard/activity-log.service'
import logger from '@/config/logger'

const app = require('../../../src/app').default

const venueId = 'clvenuenoinstr00000000001'
const otroVenue = 'clvenuenoinstr00000000002'
const serial = 'AVQD-N860W173397'
const terminalId = 'n860w173397'
const attemptId = 'intento-a'
const requestId = 'solicitud-1'
const resolutionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUTA = `/api/v1/tpv/venues/${venueId}/terminal-payment/attempts/${attemptId}/no-instrument-resolution`
const cuerpo = (extra: Record<string, unknown> = {}) => ({
  requestId,
  resolutionId,
  statement: 'NO_INSTRUMENT_PRESENTED',
  statementVersion: 1,
  ...extra,
})

/** Un JWT como los que emite el login por PIN de la terminal: `sub` = quien entró, `terminalSerialNumber` = el aparato. */
function token(extra: Record<string, unknown> = {}, tokenVenueId = venueId) {
  return jwt.sign(
    { sub: 'staff-owner', orgId: 'org_test', venueId: tokenVenueId, role: 'OWNER', ...extra },
    process.env.ACCESS_TOKEN_SECRET as string,
    { expiresIn: '15m' },
  )
}
const tokenDeTerminal = (sub: string, role: string) => token({ sub, role, terminalSerialNumber: serial })

type Miembro = { id: string; staffId: string; role: string; pin?: string }
const OWNER: Miembro = { id: 'sv-owner', staffId: 'staff-owner', role: 'OWNER', pin: '1234' }
const CASHIER: Miembro = { id: 'sv-cashier', staffId: 'staff-cashier', role: 'CASHIER', pin: '3333' }

function conMiembros(miembros: Miembro[]) {
  prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) => {
    if (where.venueId !== venueId || where.active !== true || where.staff?.active !== true) return null
    const m = miembros.find(x => (where.pin !== undefined ? x.pin === where.pin : x.staffId === where.staffId))
    return m ? { id: m.id, staffId: m.staffId, role: m.role, permissionSetId: null, permissionSet: null } : null
  })
}

let fila: any
let link: any

beforeEach(() => {
  jest.clearAllMocks()
  // `clearAllMocks` NO vacía la cola de `mockRejectedValueOnce`: si una prueba que la encola termina antes
  // de llegar a `$transaction` (p. ej. un 429 de la cubeta de PIN), la falla se hereda a la siguiente y la
  // suite sale roja o verde según el orden. Se vuelve al comportamiento por defecto del setup en cada prueba.
  prismaMock.$transaction.mockReset()
  prismaMock.$transaction.mockImplementation((callback: any) => callback(prismaMock))
  const ahora = new Date()
  fila = {
    id: 'row-1',
    requestId,
    venueId,
    terminalId,
    orderId: null,
    amountCents: 10000,
    tipCents: 0,
    status: 'TIMED_OUT',
    paymentId: null,
    closedVia: null,
    failureCode: null,
    cancelDisposition: null,
    resultJson: { requestId, status: 'timeout', terminalResult: { status: 'failed', errorMessage: 'SDK U100', outcomeEvidence: null } },
    senderDevice: null,
    lateResult: false,
    createdAt: ahora,
    updatedAt: ahora,
  }
  link = { id: 'link-1', attemptId, requestId, venueId, terminalId, createdAt: ahora, operatorResolution: null }
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.terminalPaymentAttemptLink.findUnique.mockImplementation(async ({ where }: any) =>
    where.attemptId === attemptId ? link : null,
  )
  prismaMock.terminalPaymentAttemptLink.count.mockResolvedValue(1)
  prismaMock.terminalPaymentAttemptLink.update.mockImplementation(async ({ data }: any) => Object.assign(link, data))
  prismaMock.terminalPaymentRequest.findFirst.mockImplementation(async ({ where }: any) =>
    where.requestId === requestId && where.venueId === venueId && (where.terminalId === undefined || where.terminalId === terminalId)
      ? fila
      : null,
  )
  // El CAS de la declaración es un `$executeRaw` (UPDATE condicional + NOT EXISTS de evidencia positiva — Codex r1, P1-C d): el
  // mock aplica a `fila` lo que el SQL escribe si la fila sigue siendo la leída; si no, 0 filas.
  prismaMock.$executeRaw.mockImplementation(async (tpl: any, ...values: unknown[]) => {
    const sql = Array.isArray(tpl) ? tpl.join('?') : String(tpl)
    if (!sql.includes('UPDATE "TerminalPaymentRequest"')) return 0
    const json = values.find(v => typeof v === 'string' && v.includes('"operatorResolution"')) as string | undefined
    if (!json || !values.includes(fila.id) || !values.includes(fila.status) || fila.paymentId !== null) return 0
    Object.assign(fila, {
      status: 'FAILED',
      failureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
      cancelDisposition: null,
      resultJson: JSON.parse(json),
    })
    return 1
  })
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.payment.findFirst.mockResolvedValue(null)
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
  prismaMock.$queryRaw.mockResolvedValue([])
  conMiembros([OWNER, CASHIER])
})

const nadaTocado = () => {
  expect(prismaMock.terminalPaymentAttemptLink.findUnique).not.toHaveBeenCalled()
  expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
  expect(prismaMock.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
  expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
}

describe('POST /tpv/venues/:venueId/terminal-payment/attempts/:attemptId/no-instrument-resolution', () => {
  it('401 sin token', async () => {
    expect((await request(app).post(RUTA).send(cuerpo())).status).toBe(401)
    nadaTocado()
  })

  it('(a) 200 con la sesión OWNER de la terminal: declara SIN PIN, by SESSION, y la respuesta conserva los campos de S6', async () => {
    const res = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${tokenDeTerminal('staff-owner', 'OWNER')}`)
      .send(cuerpo())
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.resolution).toMatchObject({ id: resolutionId, by: 'SESSION' })
    expect(typeof res.body.resolution.acceptedAt).toBe('string')
    // Contrato con las apps publicadas: TODO lo que S6 ya devolvía sigue ahí. Los campos NUEVOS son aditivos — un APK
    // de la calle los ignora — y se listan aquí a propósito: si alguno desapareciera, esta prueba lo caza.
    expect(res.body).toMatchObject({ attemptId, requestId })
    expect(Object.keys(res.body.attempt).sort()).toEqual(
      [
        'amountCents',
        'attemptId',
        'evidenceContradiction',
        'isWinner',
        'linkedAt',
        'outcome',
        'paymentContradiction',
        'paymentId',
        'paymentStatus',
        'processorEvidence',
        'processorEvidenceAt',
        'recordedVia',
        'tipCents',
        'winnerPaymentId',
        // «Ninguna terminal muerta» (22-sep): la declaración del cajero y el aviso de evidencia sin dueño.
        'resolution',
        'unattributedEvidence',
      ].sort(),
    )
    expect(res.body.request).toMatchObject({
      requestId,
      status: 'FAILED',
      failureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'OPERATOR_RECONCILED',
      evidenceClass: 'OPERATOR',
      closedVia: null,
      winnerAttemptId: null,
    })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED', staffId: 'staff-owner' }),
      }),
    )
    expect(logAction).not.toHaveBeenCalled()
  })

  it('(b) 403 REAL con la sesión CASHIER sin PIN: SUPERVISOR_AUTHORIZATION_REQUIRED, nada escrito, y el intento queda en la bitácora', async () => {
    const res = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${tokenDeTerminal('staff-cashier', 'CASHIER')}`)
      .send(cuerpo())
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ success: false, code: 'SUPERVISOR_AUTHORIZATION_REQUIRED' })
    expect(typeof res.body.message).toBe('string')
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    expect(prismaMock.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.terminalPaymentAttemptLink.update).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_AUTH_DENIED',
        staffId: 'staff-cashier',
        venueId,
        entityId: attemptId,
        data: expect.objectContaining({ attemptId, terminalSerial: serial, code: 'SUPERVISOR_AUTHORIZATION_REQUIRED' }),
      }),
    )
  })

  it('(c) 200 con la sesión CASHIER + supervisorPin del OWNER: by SUPERVISOR_PIN, y el PIN no se escribe en ningún lado', async () => {
    const res = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${tokenDeTerminal('staff-cashier', 'CASHIER')}`)
      .send(cuerpo({ supervisorPin: '1234' }))
    expect(res.status).toBe(200)
    expect(res.body.resolution).toMatchObject({ id: resolutionId, by: 'SUPERVISOR_PIN' })
    expect(res.body.request).toMatchObject({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE', outcome: 'NOT_CHARGED' })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED',
          staffId: 'staff-owner',
          data: expect.objectContaining({ by: 'SUPERVISOR_PIN', sessionStaffId: 'staff-cashier' }),
        }),
      }),
    )
    const escrituras = [
      ...prismaMock.$executeRaw.mock.calls,
      ...prismaMock.terminalPaymentRequest.updateMany.mock.calls,
      ...prismaMock.terminalPaymentAttemptLink.update.mock.calls,
      ...prismaMock.activityLog.create.mock.calls,
    ]
    expect(JSON.stringify(escrituras)).not.toContain('1234')
    expect(JSON.stringify(res.body)).not.toContain('1234')
  })

  it('(d) 403 TERMINAL_IDENTITY_REQUIRED con un token de DASHBOARD y con uno MÓVIL/POS (sin terminalSerialNumber), sin tocar la base', async () => {
    // El de dashboard y el de POS móvil se distinguen por su origen, no por su forma: ninguno lleva `terminalSerialNumber`.
    for (const t of [token({ sub: 'staff-owner', role: 'OWNER' }), token({ sub: 'staff-cashier', role: 'CASHIER' })]) {
      const res = await request(app).post(RUTA).set('Authorization', `Bearer ${t}`).send(cuerpo())
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ success: false, code: 'TERMINAL_IDENTITY_REQUIRED' })
    }
    nadaTocado()
  })

  it('(e) 403 de validateVenueAccess con un token de OTRO venue, sin tocar la base', async () => {
    const res = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${token({ terminalSerialNumber: serial }, otroVenue)}`)
      .send(cuerpo())
    expect(res.status).toBe(403)
    expect(res.body.code).toBeUndefined()
    nadaTocado()
  })

  it('(f) 403 SESSION_NOT_IN_VENUE con un `sub` que ya no es miembro activo del venue, aunque mande el supervisorPin del OWNER', async () => {
    const res = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${tokenDeTerminal('staff-dado-de-baja', 'CASHIER')}`)
      .send(cuerpo({ supervisorPin: '1234' }))
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ success: false, code: 'SESSION_NOT_IN_VENUE' })
    expect(prismaMock.staffVenue.findFirst.mock.calls.some(([a]: any[]) => a.where.pin !== undefined)).toBe(false)
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    expect(prismaMock.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_AUTH_DENIED',
        data: expect.objectContaining({ code: 'SESSION_NOT_IN_VENUE' }),
      }),
    )
    expect(JSON.stringify((logAction as jest.Mock).mock.calls)).not.toContain('1234')
  })

  it('un cuerpo con identidad (`staffId`) se rechaza con 409 ATTEMPT_NOT_ELIGIBLE: la identidad nunca sale del cuerpo', async () => {
    const res = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${tokenDeTerminal('staff-cashier', 'CASHIER')}`)
      .send(cuerpo({ staffId: 'staff-owner' }))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, code: 'ATTEMPT_NOT_ELIGIBLE' })
    expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    expect(prismaMock.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
  })

  it('404 ATTEMPT_NOT_FOUND para un intento de OTRA terminal, y 409 POSITIVE_EVIDENCE_EXISTS cuando ya hay dinero', async () => {
    link.terminalId = 'otra-terminal'
    const r404 = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${tokenDeTerminal('staff-owner', 'OWNER')}`)
      .send(cuerpo())
    expect(r404.status).toBe(404)
    expect(r404.body).toMatchObject({ success: false, code: 'ATTEMPT_NOT_FOUND' })
    link.terminalId = terminalId
    prismaMock.payment.findFirst.mockResolvedValue({ id: 'pay-1' })
    const r409 = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${tokenDeTerminal('staff-owner', 'OWNER')}`)
      .send(cuerpo())
    expect(r409.status).toBe(409)
    expect(r409.body).toMatchObject({ success: false, code: 'POSITIVE_EVIDENCE_EXISTS' })
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    expect(prismaMock.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
  })

  it('la cubeta del PIN sólo cuenta cuerpos CON supervisorPin: 105 declaraciones sin PIN desde la misma IP llegan todas al controlador (0 × 429, sin cabeceras RateLimit); una con PIN sí se cuenta', async () => {
    // Sin PIN no hay nada que adivinar por fuerza bruta: contar esas llamadas sólo servía para que un cuarto de hora movido en un
    // local (todas las terminales salen por la misma IP) dejara a la tienda sin poder declarar. DEV permite 100 por minuto por IP:
    // 105 seguidas superan la cubeta compartida si la ruta la contara.
    const estados: number[] = []
    let sinCabecera = 0
    for (let i = 0; i < 105; i++) {
      const res = await request(app)
        .post(RUTA)
        .set('Authorization', `Bearer ${tokenDeTerminal('staff-owner', 'OWNER')}`)
        .send(cuerpo())
      estados.push(res.status)
      if (res.headers['ratelimit-limit'] === undefined && res.headers['ratelimit-remaining'] === undefined) sinCabecera++
    }
    // Un solo objeto en la aserción: si algún día falla, el reporte dice QUÉ estados volvieron, no sólo que algo no cuadró.
    // La primera declara y el resto son replays idempotentes: todas 200, ninguna 429, ninguna con cabeceras de la cubeta.
    expect({ estados: [...new Set(estados)], sinCabecera }).toEqual({ estados: [200], sinCabecera: 105 })
    // Con PIN la cubeta SÍ se arma (cabeceras estándar presentes) — es lo que protege el PIN de la fuerza bruta.
    const conPin = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${tokenDeTerminal('staff-cashier', 'CASHIER')}`)
      .send(cuerpo({ supervisorPin: '1234' }))
    expect(conPin.status).toBe(200) // replay: ya está declarada
    expect(conPin.headers['ratelimit-limit']).toBeDefined()
    expect(conPin.headers['ratelimit-remaining']).toBeDefined()
  })

  it('503 RESOLUTION_UNAVAILABLE si la base revienta: nunca se serializa el error (podría llevar el PIN); el log lleva nombre y código, nunca el mensaje', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(new Error('db caída con supervisorPin=1234 adentro'))
    const res = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${tokenDeTerminal('staff-cashier', 'CASHIER')}`)
      .send(cuerpo({ supervisorPin: '1234' }))
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ success: false, code: 'RESOLUTION_UNAVAILABLE' })
    expect(JSON.stringify(res.body)).not.toContain('1234')
    expect(JSON.stringify(res.body)).not.toContain('db caída')
    expect(logger.error).toHaveBeenCalledWith(
      'No-instrument resolution unavailable',
      expect.objectContaining({ venueId, attemptId, errorName: 'Error' }),
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('1234')
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('db caída')
    // Un error conocido de Prisma deja su código (P2034 = serialización/deadlock), que sí sirve para diagnosticar.
    ;(logger.error as jest.Mock).mockClear()
    prismaMock.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict (pin 1234)', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    )
    const res2 = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${tokenDeTerminal('staff-cashier', 'CASHIER')}`)
      .send(cuerpo({ supervisorPin: '1234' }))
    expect(res2.status).toBe(503)
    expect(logger.error).toHaveBeenCalledWith(
      'No-instrument resolution unavailable',
      expect.objectContaining({ errorName: 'PrismaClientKnownRequestError', errorCode: 'P2034' }),
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('1234')
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('write conflict')
  })

  // 🔴 VA AL FINAL: agota la cubeta por IP del proceso entero; cualquier prueba CON PIN que corriera después recibiría 429.
  it('con PIN la cubeta es LA MISMA que la del PIN de gerente: agotarla desde esta ruta deja en 429 a POST /mobile/venues/:venueId/permission-overrides desde la misma IP', async () => {
    // DEV: 100 por minuto por IP (prod: 10 cada 15 min). Las de esta ruta con PIN cuentan; las respuestas del servicio dan igual.
    const agotadas: number[] = []
    let primer429: request.Response | null = null
    // Se pide HASTA el primer 429, no exactamente 100: la ventana es fija de 1 min, y si el minuto se
    // cumple a media corrida el contador vuelve a cero y 100 ya no alcanzan (salía rojo por el reloj).
    // 250 cubre una vuelta completa de ventana. En cuanto hay 429, dejar de pedir.
    for (let i = 0; i < 250 && !primer429; i++) {
      const res = await request(app)
        .post(RUTA)
        .set('Authorization', `Bearer ${tokenDeTerminal('staff-cashier', 'CASHIER')}`)
        .send(cuerpo({ supervisorPin: '1234' }))
      agotadas.push(res.status)
      if (res.status === 429) primer429 = res
    }
    expect(agotadas.some(s => s === 429)).toBe(true) // el tope de esta misma ruta ya se alcanzó
    // Revisión final (17-sep, D): el 429 lleva `code` (la terminal decide por él) SIN perder `retryAfter` ni `Retry-After`.
    expect(primer429?.body).toEqual({
      error: 'RATE_LIMIT_EXCEEDED',
      code: 'RATE_LIMIT_EXCEEDED',
      message: expect.any(String),
      retryAfter: 15 * 60,
    })
    expect(Number(primer429?.headers['retry-after'])).toBeGreaterThan(0)
    // La ruta del PIN de gerente, desde la MISMA IP, con un token válido y membresía real: el limitador corta ANTES de validar el cuerpo.
    mirrorTokenRoleOnStaffVenue('CASHIER', venueId)
    const override = await request(app)
      .post(`/api/v1/mobile/venues/${venueId}/permission-overrides`)
      .set('Authorization', `Bearer ${token({ sub: 'staff-cashier', role: 'CASHIER' })}`)
      .send({ pin: '1234', permission: 'orders:cancel' })
    expect({ status: override.status, body: override.body }).toEqual({
      status: 429,
      body: { error: 'RATE_LIMIT_EXCEEDED', code: 'RATE_LIMIT_EXCEEDED', message: expect.any(String), retryAfter: 15 * 60 },
    })
    expect(Number(override.headers['retry-after'])).toBeGreaterThan(0)
    // Y sin PIN esta ruta sigue pasando aunque la cubeta esté agotada: no la toca.
    const sinPin = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${tokenDeTerminal('staff-owner', 'OWNER')}`)
      .send(cuerpo())
    expect(sinPin.status).toBe(200)
  })
})
