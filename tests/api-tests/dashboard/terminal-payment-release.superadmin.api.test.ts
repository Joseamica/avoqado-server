/*
  tests/api-tests/dashboard/terminal-payment-release.superadmin.api.test.ts

  A6 · S6 (21-oct, «ninguna duda de un cobro de la tablet sin salida»): soporte suelta LA TERMINAL (no la venta) por
  `POST /api/v1/dashboard/superadmin/terminals/payment-requests/:requestId/release`, con el Express real. Lo que la ruta
  garantiza y una prueba de servicio no demuestra:
    · el motivo es OBLIGATORIO y no vacío (400 sin motivo o con puros espacios), y sin él no se toca nada;
    · el origen SUPERADMIN y el staff salen del TOKEN autenticado, nunca del cuerpo;
    · sólo un SUPERADMIN llega (un gerente recibe 403).
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
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'
import { terminalPaymentService } from '@/services/terminal-payment.service'

const app = require('../../../src/app').default
startApiServer(() => app)

const tokenVenueId = 'clvenuesoporte00000000001'
const venueId = 'clvenueamaena000000000001'
const requestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const RUTA = `/api/v1/dashboard/superadmin/terminals/payment-requests/${requestId}/release`
const token = (role: string, sub: string) => {
  mirrorTokenRoleOnStaffVenue(role, tokenVenueId)
  return jwt.sign({ sub, orgId: 'org_test', venueId: tokenVenueId, role }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })
}

let soltar: jest.SpyInstance
beforeEach(() => {
  jest.clearAllMocks()
  soltar = jest
    .spyOn(terminalPaymentService, 'releaseUnknownRequest')
    .mockResolvedValue({ requestId, released: true, status: 'TIMED_OUT' } as any)
})
afterEach(() => soltar.mockRestore())

describe('POST superadmin /terminals/payment-requests/:requestId/release — soporte suelta la terminal (A6 · S6)', () => {
  it.each([
    ['sin motivo', { venueId }],
    ['motivo de puros espacios', { venueId, reason: '     ' }],
  ])('P1 %s ⇒ 400 y no se toca nada', async (_caso, cuerpo) => {
    const res = await api()
      .post(RUTA)
      .set('Authorization', `Bearer ${token('SUPERADMIN', 'staff-soporte')}`)
      .send(cuerpo)
    expect(res.status).toBe(400)
    expect(soltar).not.toHaveBeenCalled()
  })

  it('P1 el origen y el staff salen del token, no del cuerpo; responde released', async () => {
    const res = await api()
      .post(RUTA)
      .set('Authorization', `Bearer ${token('SUPERADMIN', 'staff-soporte')}`)
      .send({ venueId, reason: '  la PAX se reinició  ', source: 'MOBILE', staffId: 'otro', actor: { source: 'MOBILE' } })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, released: true, status: 'TIMED_OUT' })
    expect(soltar).toHaveBeenCalledWith({
      requestId,
      venueId,
      actor: { staffId: 'staff-soporte', source: 'SUPERADMIN' },
      reason: 'la PAX se reinició',
    })
  })

  // Fix round 1 (revisión A6, menor 1): el texto dice la verdad según el resultado — soltada, retenida por dinero, o una fila
  // que soporte no puede soltar (con su estado, si la terminal sigue apartada y qué hacer). Nunca «ya no está atorado» si aparta.
  it.each([
    ['soltada', { released: true, status: 'TIMED_OUT' }, /Terminal liberada.*venta sigue protegida/, null],
    ['conciliada', { released: false, status: 'COMPLETED', paymentId: 'p1' }, /se cerró como cobrado/, null],
    ['retenida por dinero', { released: false, status: 'UNKNOWN', heldByMoneyEvidence: true }, /rastro de dinero/, null],
    ['UNKNOWN que no se soltó', { released: false, status: 'UNKNOWN' }, /falta confirmar el resultado/, null],
    [
      'en curso (SENT)',
      { released: false, status: 'SENT', slotHeld: true },
      /sólo suelta cobros sin resultado.*en curso.*sigue apartada.*en curso/,
      /ya no aparta/,
    ],
    [
      'cancelándose',
      { released: false, status: 'CANCEL_REQUESTED', slotHeld: true },
      /cancelándose.*sigue apartada.*en curso/,
      /ya no aparta/,
    ],
    [
      'TIMED_OUT histórica retenida sin reloj acreditado',
      { released: false, status: 'TIMED_OUT', slotHeld: true },
      /vencido sin respuesta.*sigue apartada.*revis|vencido sin respuesta.*sigue apartada.*concili/,
      /ya no aparta|se suelta sola|a más tardar|20|en unos minutos/,
    ],
    [
      'sin desenlace en estricto',
      { released: false, status: 'FAILED', slotHeld: true },
      /fallido.*sigue apartada.*no se cobró/,
      /ya no aparta/,
    ],
    // A4b (21-oct): la ranura ya se soltó (el reloj, soporte o el cese acreditado) pero la VENTA sigue en duda: lo dice, sin
    // afirmar «no se cobró».
    [
      'ya no aparta y la venta sigue en duda',
      { released: false, status: 'TIMED_OUT', slotHeld: false },
      /ya no aparta la terminal.*venció sin respuesta.*venta sigue pendiente de confirmar/,
      /sigue apartada|no se cobró/,
    ],
    ['ya no aparta (resuelta)', { released: false, status: 'FAILED', slotHeld: false }, /ya no aparta la terminal.*fallido/, /pendiente/],
  ])('P1 Fix1 texto según el resultado: %s', async (_caso, resultado, dice, noDice) => {
    soltar.mockResolvedValueOnce({ requestId, ...resultado })
    const res = await api()
      .post(RUTA)
      .set('Authorization', `Bearer ${token('SUPERADMIN', 'staff-soporte')}`)
      .send({ venueId, reason: 'la PAX se reinició' })
    expect(res.status).toBe(200)
    expect(res.body.message).toMatch(dice)
    if (noDice) expect(res.body.message).not.toMatch(noDice)
    expect(res.body.message).not.toMatch(/ya no está atorado/)
  })

  it('P1 un gerente no llega a soltar la terminal (403)', async () => {
    const res = await api()
      .post(RUTA)
      .set('Authorization', `Bearer ${token('MANAGER', 'staff-gerente')}`)
      .send({ venueId, reason: 'la PAX se reinició' })
    expect(res.status).toBe(403)
    expect(soltar).not.toHaveBeenCalled()
  })
})
