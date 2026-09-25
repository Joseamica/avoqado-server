/**
 * Codex S2 (24-25 sep): los tokens del MCP, del selector de organización, de clientes y de consumidores se firman
 * con la MISMA llave que los de la API. El middleware sólo verificaba firma y algoritmo, así que un token del
 * MCP consentido «sólo lectura» para la organización A autenticaba escrituras en la API. Ahora sólo pasa un
 * token de la API: sin audiencia ajena y sin `type` de cliente/consumidor.
 */
import jwt from 'jsonwebtoken'

jest.mock('@/utils/tokenRevocation', () => ({ isJtiRevoked: jest.fn(async () => false) }))

import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { issueMcpToken } from '@/mcp/mcpToken'
import { esTokenDeLaApi } from '@/utils/tokenDeLaApi'
import { issueOrgPickToken } from '@/mcp/oauth/orgPick'
import { generateAccessToken as generateTpvAccessToken, generateRefreshToken as generateTpvRefreshToken } from '@/security'

const SECRETO = process.env.ACCESS_TOKEN_SECRET as string

function correr(token: string) {
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => res), clearCookie: jest.fn(() => res) }
  const next = jest.fn()
  const req: any = { headers: { authorization: `Bearer ${token}` }, cookies: {}, get: () => undefined }
  return Promise.resolve(authenticateTokenMiddleware(req, res, next)).then(() => ({ req, res, next }))
}
const rechazado = (r: { res: any; next: jest.Mock }) =>
  r.res.status.mock.calls.some((c: unknown[]) => c[0] === 401) ||
  r.next.mock.calls.some((c: unknown[]) => (c[0] as any)?.statusCode === 401)

const deLaApi = () =>
  jwt.sign({ sub: 'staff-1', orgId: 'org-1', venueId: 'v-1', role: 'OWNER' }, SECRETO, { algorithm: 'HS256', expiresIn: '10m' })

describe('esTokenDeLaApi', () => {
  it('acepta el token de la API (sin audiencia) y el de clientes de la API (avoqado-clients)', () => {
    expect(esTokenDeLaApi({ sub: 's' })).toBe(true)
    expect(esTokenDeLaApi({ sub: 's', aud: 'avoqado-clients' })).toBe(true)
  })
  it('🔴 rechaza audiencias ajenas y los tokens de cliente/consumidor', () => {
    expect(esTokenDeLaApi({ sub: 's', aud: 'avoqado-mcp' })).toBe(false)
    expect(esTokenDeLaApi({ sub: 's', aud: ['avoqado-mcp'] })).toBe(false)
    expect(esTokenDeLaApi({ sub: 's', aud: 'avoqado-mcp-org-pick' })).toBe(false)
    expect(esTokenDeLaApi({ sub: 's', type: 'customer' })).toBe(false)
    expect(esTokenDeLaApi({ sub: 's', type: 'consumer' })).toBe(false)
    expect(esTokenDeLaApi({ sub: 's', aud: 'avoqado-clients', type: 'refresh' })).toBe(false)
    expect(esTokenDeLaApi({ sub: 's', aud: ['avoqado-clients', 'avoqado-mcp'] })).toBe(false)
    expect(esTokenDeLaApi(null)).toBe(false)
  })
})

describe('authenticateTokenMiddleware · token de otro sistema', () => {
  it('🔴 un token del MCP (aunque tenga firma válida) NO autentica en la API', async () => {
    const r = await correr(issueMcpToken('staff-1', 'org-1', 600, 'cliente', ['mcp:read']))
    expect(rechazado(r)).toBe(true)
    expect(r.req.authContext).toBeUndefined()
  })

  it('🔴 un token de cliente del portal público NO autentica en la API', async () => {
    const r = await correr(jwt.sign({ sub: 'cust-1', venueId: 'v-1', type: 'customer' }, SECRETO, { algorithm: 'HS256', expiresIn: '10m' }))
    expect(rechazado(r)).toBe(true)
    expect(r.req.authContext).toBeUndefined()
  })

  it('🔴 el token del selector de organización del MCP NO autentica en la API', async () => {
    const r = await correr(issueOrgPickToken('staff-1'))
    expect(rechazado(r)).toBe(true)
  })

  it('🔴 el refresh de la TPV (misma llave, 7 días) NO sirve como acceso', async () => {
    const r = await correr(generateTpvRefreshToken({ userId: 'staff-1', orgId: 'org-1', venueId: 'v-1', role: 'OWNER' } as any))
    expect(rechazado(r)).toBe(true)
  })

  it('el token de acceso de la TPV (audiencia avoqado-clients) sigue entrando', async () => {
    const r = await correr(generateTpvAccessToken({ userId: 'staff-1', orgId: 'org-1', venueId: 'v-1', role: 'OWNER' } as any))
    expect(rechazado(r)).toBe(false)
    expect(r.req.authContext?.userId).toBe('staff-1')
  })

  it('el token de la API sigue entrando (regresión)', async () => {
    const r = await correr(deLaApi())
    expect(rechazado(r)).toBe(false)
    expect(r.next).toHaveBeenCalledWith()
    expect(r.req.authContext?.userId).toBe('staff-1')
  })
})
