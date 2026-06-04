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
beforeEach(() => jest.clearAllMocks())

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
  expect(verified.extra).toEqual({ staffId: 's1', activeOrg: 'o1' })
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
