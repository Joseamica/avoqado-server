jest.mock('../../../src/mcp/oauth/tokenStore', () => ({
  consumeAuthCode: jest.fn(),
  peekAuthCodeChallenge: jest.fn(),
  createRefreshToken: jest.fn(),
  consumeRefreshToken: jest.fn(),
  revokeRefreshToken: jest.fn(),
}))
jest.mock('../../../src/mcp/oauth/clientsStore', () => ({ prismaClientsStore: {} }))

import { provider } from '../../../src/mcp/oauth/provider'
import { issueMcpToken } from '../../../src/mcp/mcpToken'
import * as store from '../../../src/mcp/oauth/tokenStore'

beforeAll(() => {
  process.env.ACCESS_TOKEN_SECRET = 'test-secret'
})
const guard = jest.requireActual('../../../src/utils/passwordChangeGuard')
let corteSpy: jest.SpyInstance
let accesoSpy: jest.SpyInstance
beforeEach(() => {
  jest.clearAllMocks()
  // Sin corte por default: estas pruebas no tocan la base (Codex S4 abajo cambia el valor).
  corteSpy = jest.spyOn(guard, 'motivoDeConcesionInvalidada').mockResolvedValue(null)
  accesoSpy = jest.spyOn(guard, 'motivoDeSesionInvalidada').mockResolvedValue(null)
})
afterEach(() => {
  corteSpy.mockRestore()
  accesoSpy.mockRestore()
})

it('verifyAccessToken returns AuthInfo with staffId/activeOrg in extra', async () => {
  const token = issueMcpToken('s1', 'o1', 3600, 'c1')
  const info = await provider.verifyAccessToken(token)
  expect(info.clientId).toBe('c1')
  expect(info.extra).toEqual({ staffId: 's1', activeOrg: 'o1' })
  expect(info.scopes).toContain('mcp:read')
})

it('verifyAccessToken throws on a non-MCP token', async () => {
  await expect(provider.verifyAccessToken('garbage')).rejects.toBeTruthy()
})

it('exchangeAuthorizationCode consumes the code and returns access+refresh', async () => {
  ;(store.consumeAuthCode as jest.Mock).mockResolvedValue({
    clientId: 'c1',
    staffId: 's1',
    activeOrg: 'o1',
    codeChallenge: 'cc',
    redirectUri: 'http://cb',
    scopes: ['mcp:read'],
  })
  ;(store.createRefreshToken as jest.Mock).mockResolvedValue({ token: 'refresh123' })
  const tokens = await provider.exchangeAuthorizationCode({ client_id: 'c1', redirect_uris: ['http://cb'] } as never, 'thecode')
  expect(tokens.access_token).toBeTruthy()
  expect(tokens.refresh_token).toBe('refresh123')
  expect(tokens.token_type).toBe('Bearer')
  const verified = await provider.verifyAccessToken(tokens.access_token)
  // The granted scope now round-trips through the token (was dropped at mint → hardcoded full set).
  expect(verified.extra).toEqual({ staffId: 's1', activeOrg: 'o1', scopes: ['mcp:read'] })
  expect(verified.scopes).toEqual(['mcp:read']) // NOT the full supported set — only what was granted
})

it('exchangeAuthorizationCode rejects a code bound to a different client', async () => {
  ;(store.consumeAuthCode as jest.Mock).mockResolvedValue({
    clientId: 'OTHER',
    staffId: 's1',
    activeOrg: 'o1',
    codeChallenge: 'cc',
    redirectUri: 'http://cb',
    scopes: [],
  })
  await expect(
    provider.exchangeAuthorizationCode({ client_id: 'c1', redirect_uris: ['http://cb'] } as never, 'thecode'),
  ).rejects.toBeTruthy()
})

// ─── Codex S4: las concesiones del MCP mueren con el corte de sesión ──────────────────────────
// Cambiar la contraseña o «cerrar sesión en todos mis dispositivos» mata los tokens del dashboard.
// Los del MCP vivían aparte: un código sin canjear, un refresh de 30 días y el acceso de 1 h seguían
// sirviendo. Ahora los tres consultan el MISMO corte.
describe('Codex S4 — corte de sesión', () => {
  const emitida = new Date('2026-09-20T10:00:00Z')

  it('🔴 un código emitido antes del corte ya no se canjea', async () => {
    ;(store.consumeAuthCode as jest.Mock).mockResolvedValue({
      clientId: 'c1',
      staffId: 's1',
      activeOrg: 'o1',
      codeChallenge: 'cc',
      redirectUri: 'http://cb',
      scopes: [],
      issuedAt: emitida,
    })
    corteSpy.mockResolvedValue('PASSWORD_CHANGED')
    await expect(provider.exchangeAuthorizationCode({ client_id: 'c1' } as never, 'x')).rejects.toThrow(/sesión|session/i)
    expect(corteSpy).toHaveBeenCalledWith('s1', emitida)
    expect(store.createRefreshToken).not.toHaveBeenCalled()
  })

  it('🔴 un refresh emitido antes del corte ya no rota', async () => {
    ;(store.consumeRefreshToken as jest.Mock).mockResolvedValue({
      clientId: 'c1',
      staffId: 's1',
      activeOrg: 'o1',
      scopes: [],
      issuedAt: emitida,
    })
    corteSpy.mockResolvedValue('SESSIONS_REVOKED')
    await expect(provider.exchangeRefreshToken({ client_id: 'c1' } as never, 'r')).rejects.toThrow(/sesión|session/i)
    expect(corteSpy).toHaveBeenCalledWith('s1', emitida)
    expect(store.createRefreshToken).not.toHaveBeenCalled()
  })

  it('🔴 el acceso de 1 h emitido antes del corte deja de servir', async () => {
    accesoSpy.mockResolvedValue('PASSWORD_CHANGED')
    await expect(provider.verifyAccessToken(issueMcpToken('s1', 'o1', 3600, 'c1'))).rejects.toBeTruthy()
    expect(accesoSpy).toHaveBeenCalledWith('s1', expect.any(Number))
  })

  it('sin corte, los tres siguen funcionando (regresión)', async () => {
    ;(store.consumeRefreshToken as jest.Mock).mockResolvedValue({
      clientId: 'c1',
      staffId: 's1',
      activeOrg: 'o1',
      scopes: [],
      issuedAt: emitida,
    })
    ;(store.createRefreshToken as jest.Mock).mockResolvedValue({ token: 'nuevo' })
    await expect(provider.exchangeRefreshToken({ client_id: 'c1' } as never, 'r')).resolves.toMatchObject({ refresh_token: 'nuevo' })
    await expect(provider.verifyAccessToken(issueMcpToken('s1', 'o1', 3600, 'c1'))).resolves.toBeTruthy()
  })
})
