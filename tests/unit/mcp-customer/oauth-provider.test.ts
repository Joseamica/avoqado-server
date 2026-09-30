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

// ─── Codex ronda 8, P1: la carrera validar → cambiar contraseña → emitir ───────────────────────
// La renovación comprobaba el corte y DESPUÉS creaba el reemplazo con la fecha de HOY. Si la
// contraseña cambiaba entre las dos cosas, el reemplazo nacía «después» del corte y seguía rotando.
// Ahora la cadena HEREDA la fecha de la autorización original: ningún corte posterior se la salta.
describe('Codex ronda 8 — la cadena de renovación hereda la fecha original', () => {
  const autorizada = new Date('2026-09-20T10:00:00Z')
  const datos = (issuedAt: Date) => ({ clientId: 'c1', staffId: 's1', activeOrg: 'o1', scopes: [], issuedAt })

  it('el refresh que reemplaza al consumido lleva la fecha ORIGINAL, no la de hoy', async () => {
    ;(store.consumeRefreshToken as jest.Mock).mockResolvedValue(datos(autorizada))
    ;(store.createRefreshToken as jest.Mock).mockResolvedValue({ token: 'nuevo' })
    await provider.exchangeRefreshToken({ client_id: 'c1' } as never, 'r')
    expect((store.createRefreshToken as jest.Mock).mock.calls[0][0].grantedAt).toEqual(autorizada)
  })

  it('el primer refresh (al canjear el código) lleva la fecha del código', async () => {
    ;(store.consumeAuthCode as jest.Mock).mockResolvedValue({ ...datos(autorizada), codeChallenge: 'cc', redirectUri: 'http://cb' })
    ;(store.createRefreshToken as jest.Mock).mockResolvedValue({ token: 'r1' })
    await provider.exchangeAuthorizationCode({ client_id: 'c1' } as never, 'x')
    expect((store.createRefreshToken as jest.Mock).mock.calls[0][0].grantedAt).toEqual(autorizada)
  })

  it('🔴 la carrera de Codex: renovar → cambia la contraseña → la siguiente renovación YA NO rota', async () => {
    let corte: Date | null = null
    corteSpy.mockImplementation(async (_s: string, emitida: Date) =>
      corte && emitida.getTime() <= corte.getTime() ? 'PASSWORD_CHANGED' : null,
    )
    // El almacén modelado como la base: el reemplazo guarda la fecha que le pasen, o la de HOY.
    let guardada: Date = autorizada
    ;(store.consumeRefreshToken as jest.Mock).mockImplementation(async () => datos(guardada))
    ;(store.createRefreshToken as jest.Mock).mockImplementation(async (d: { grantedAt?: Date }) => {
      guardada = d.grantedAt ?? new Date(Date.now() + 1000)
      return { token: 'siguiente' }
    })

    await provider.exchangeRefreshToken({ client_id: 'c1' } as never, 'r') // pasa: aún no hay corte
    corte = new Date() // la contraseña cambia justo después de la validación
    await expect(provider.exchangeRefreshToken({ client_id: 'c1' } as never, 'siguiente')).rejects.toThrow(/sesión|session/i)
  })

  it('🔴 el acceso de 1 h emitido en esa carrera también muere: se juzga con la fecha original', async () => {
    ;(store.consumeRefreshToken as jest.Mock).mockResolvedValue(datos(autorizada))
    ;(store.createRefreshToken as jest.Mock).mockResolvedValue({ token: 'nuevo' })
    const { access_token } = await provider.exchangeRefreshToken({ client_id: 'c1' } as never, 'r')
    await provider.verifyAccessToken(access_token)
    expect(accesoSpy).toHaveBeenCalledWith('s1', Math.floor(autorizada.getTime() / 1000))
  })

  it('un acceso sin fecha de concesión (tokens viejos o del servidor de desarrollo) se juzga como siempre, por su iat', async () => {
    const token = issueMcpToken('s1', 'o1', 3600, 'c1')
    await provider.verifyAccessToken(token)
    const iat = accesoSpy.mock.calls[0][1]
    expect(Math.abs(iat - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2)
  })
})
