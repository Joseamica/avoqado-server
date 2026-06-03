import { createHash } from 'crypto'

// Mock prisma BEFORE importing the store (store imports prismaClient at module load).
const db = {
  mcpAuthCode: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  mcpRefreshToken: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
}
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: db }))

import { createAuthCode, consumeAuthCode, createRefreshToken, consumeRefreshToken } from '../../../src/mcp/oauth/tokenStore'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

beforeEach(() => jest.clearAllMocks())

describe('auth codes', () => {
  it('stores the HASH of the code, never the plaintext', async () => {
    db.mcpAuthCode.create.mockResolvedValue({})
    const { code } = await createAuthCode({
      clientId: 'c1',
      staffId: 's1',
      activeOrg: 'o1',
      codeChallenge: 'cc',
      redirectUri: 'http://x',
      scopes: [],
      resource: undefined,
    })
    const arg = db.mcpAuthCode.create.mock.calls[0][0].data
    expect(arg.codeHash).toBe(sha(code))
    expect(JSON.stringify(arg)).not.toContain(code)
  })

  it('consumes a valid, unexpired, unused code exactly once', async () => {
    const row = {
      codeHash: sha('abc'),
      clientId: 'c1',
      staffId: 's1',
      activeOrg: 'o1',
      codeChallenge: 'cc',
      redirectUri: 'http://x',
      scopes: [],
      resource: null,
      expiresAt: new Date(Date.now() + 10000),
      consumedAt: null,
    }
    db.mcpAuthCode.findUnique.mockResolvedValue(row)
    db.mcpAuthCode.update.mockResolvedValue({})
    const res = await consumeAuthCode('abc')
    expect(res?.staffId).toBe('s1')
    expect(db.mcpAuthCode.update).toHaveBeenCalledWith(expect.objectContaining({ where: { codeHash: sha('abc') } }))
  })

  it('rejects an expired code', async () => {
    db.mcpAuthCode.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() - 1), consumedAt: null })
    await expect(consumeAuthCode('abc')).resolves.toBeNull()
  })

  it('rejects an already-consumed code', async () => {
    db.mcpAuthCode.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() + 10000), consumedAt: new Date() })
    await expect(consumeAuthCode('abc')).resolves.toBeNull()
  })
})

describe('refresh tokens', () => {
  it('stores the hash and consumes a valid token', async () => {
    db.mcpRefreshToken.create.mockResolvedValue({})
    const { token } = await createRefreshToken({ clientId: 'c1', staffId: 's1', activeOrg: 'o1', scopes: [] })
    expect(db.mcpRefreshToken.create.mock.calls[0][0].data.tokenHash).toBe(sha(token))

    db.mcpRefreshToken.findUnique.mockResolvedValue({
      tokenHash: sha(token),
      clientId: 'c1',
      staffId: 's1',
      activeOrg: 'o1',
      scopes: [],
      expiresAt: new Date(Date.now() + 10000),
      revokedAt: null,
    })
    const res = await consumeRefreshToken(token)
    expect(res?.staffId).toBe('s1')
  })

  it('rejects a revoked token', async () => {
    db.mcpRefreshToken.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() + 1000), revokedAt: new Date() })
    await expect(consumeRefreshToken('x')).resolves.toBeNull()
  })
})
