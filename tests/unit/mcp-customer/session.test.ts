import jwt from 'jsonwebtoken'
import { ACCESS_TOKEN_SECRET } from '@/config/env'
// La revocación (sesión cerrada, corte, JTI) la decide el middleware real; aquí se simula su veredicto.
let mockSesionViva = true
jest.mock('@/middlewares/autenticacionOpcional.middleware', () => ({
  autenticacionOpcional: async (req: any, _res: unknown, next: () => void) => {
    if (mockSesionViva) req.authContext = { userId: (require('jsonwebtoken').decode(req.cookies.accessToken) as any).sub }
    next()
  },
}))

import { staffIdFromDashboardSession } from '../../../src/mcp/oauth/session'

beforeEach(() => {
  mockSesionViva = true
})

const sign = (payload: object, opts?: jwt.SignOptions) => jwt.sign(payload, ACCESS_TOKEN_SECRET, { algorithm: 'HS256', ...opts })

describe('staffIdFromDashboardSession', () => {
  it('returns the staffId (sub) from a valid dashboard session cookie', async () => {
    const token = sign({ sub: 'staff-1', orgId: 'o1', venueId: 'v1', role: 'OWNER' })
    expect(await staffIdFromDashboardSession({ cookies: { accessToken: token } })).toBe('staff-1')
  })

  it('returns null when there is no cookie', async () => {
    expect(await staffIdFromDashboardSession({})).toBeNull()
    expect(await staffIdFromDashboardSession({ cookies: {} })).toBeNull()
  })

  it('returns null for an impersonation session (act claim) — never SSO as the impersonated user', async () => {
    const token = sign({ sub: 'victim', act: { sub: 'admin' }, role: 'OWNER' })
    expect(await staffIdFromDashboardSession({ cookies: { accessToken: token } })).toBeNull()
  })

  it('returns null for a token signed with the wrong secret (tampered)', async () => {
    const token = jwt.sign({ sub: 'staff-1' }, 'a-totally-different-secret-1234567890', { algorithm: 'HS256' })
    expect(await staffIdFromDashboardSession({ cookies: { accessToken: token } })).toBeNull()
  })

  it('returns null for an expired token', async () => {
    const token = sign({ sub: 'staff-1' }, { expiresIn: '-1s' })
    expect(await staffIdFromDashboardSession({ cookies: { accessToken: token } })).toBeNull()
  })

  it('returns null for a malformed token', async () => {
    expect(await staffIdFromDashboardSession({ cookies: { accessToken: 'not.a.jwt' } })).toBeNull()
  })

  it('🔴 una sesión CERRADA (o cortada por cambio de contraseña) ya no conecta el MCP aunque el token no haya vencido', async () => {
    mockSesionViva = false
    const token = sign({ sub: 'staff-1', orgId: 'o1', venueId: 'v1', role: 'OWNER' })
    expect(await staffIdFromDashboardSession({ cookies: { accessToken: token } })).toBeNull()
  })
})
