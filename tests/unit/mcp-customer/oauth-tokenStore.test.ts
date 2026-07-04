import { createHash } from 'crypto'

// Mock prisma BEFORE importing the store (store imports prismaClient at module load).
const db = {
  mcpAuthCode: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  mcpRefreshToken: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
}
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: db }))

import { createAuthCode, consumeAuthCode, createRefreshToken, consumeRefreshToken } from '../../../src/mcp/oauth/tokenStore'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

beforeEach(() => jest.clearAllMocks())

const authRow = (over: Record<string, unknown> = {}) => ({
  codeHash: sha('abc'),
  clientId: 'c1',
  staffId: 's1',
  activeOrg: 'o1',
  codeChallenge: 'cc',
  redirectUri: 'http://x',
  scopes: [],
  resource: null,
  ...over,
})

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

  it('claims the code ATOMICALLY (updateMany gated on consumedAt:null), then reads it', async () => {
    db.mcpAuthCode.updateMany.mockResolvedValue({ count: 1 }) // we won the claim
    db.mcpAuthCode.findUnique.mockResolvedValue(authRow())
    const res = await consumeAuthCode('abc')
    expect(res?.staffId).toBe('s1')
    // the guard MUST require consumedAt:null + not-expired in the SAME statement (no read-then-write race)
    const where = db.mcpAuthCode.updateMany.mock.calls[0][0].where
    expect(where.codeHash).toBe(sha('abc'))
    expect(where.consumedAt).toBeNull()
    expect(where.expiresAt.gt).toBeInstanceOf(Date)
  })

  it('returns null WITHOUT reading the row when the claim matches nothing (expired/used/missing)', async () => {
    db.mcpAuthCode.updateMany.mockResolvedValue({ count: 0 })
    await expect(consumeAuthCode('abc')).resolves.toBeNull()
    expect(db.mcpAuthCode.findUnique).not.toHaveBeenCalled() // no stale read on a lost claim
  })

  it('REPLAY: two concurrent exchanges of the same code — only ONE wins, the other gets null', async () => {
    // First claim wins (count 1), second finds it already consumed (count 0) — the atomic guard's job.
    db.mcpAuthCode.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    db.mcpAuthCode.findUnique.mockResolvedValue(authRow())
    const [a, b] = await Promise.all([consumeAuthCode('abc'), consumeAuthCode('abc')])
    const wins = [a, b].filter(Boolean)
    expect(wins).toHaveLength(1) // exactly one exchange gets the code; the replay is refused
  })
})

describe('refresh tokens', () => {
  it('stores the hash on create', async () => {
    db.mcpRefreshToken.create.mockResolvedValue({})
    const { token } = await createRefreshToken({ clientId: 'c1', staffId: 's1', activeOrg: 'o1', scopes: [] })
    expect(db.mcpRefreshToken.create.mock.calls[0][0].data.tokenHash).toBe(sha(token))
  })

  it('consumes ATOMICALLY: updateMany gated on revokedAt:null flips it, then reads the row', async () => {
    db.mcpRefreshToken.updateMany.mockResolvedValue({ count: 1 })
    db.mcpRefreshToken.findUnique.mockResolvedValue({ clientId: 'c1', staffId: 's1', activeOrg: 'o1', scopes: [] })
    const res = await consumeRefreshToken('x')
    expect(res?.staffId).toBe('s1')
    const where = db.mcpRefreshToken.updateMany.mock.calls[0][0].where
    expect(where.revokedAt).toBeNull()
    expect(where.expiresAt.gt).toBeInstanceOf(Date)
  })

  it('rejects a revoked/expired token (claim matches nothing) without a stale read', async () => {
    db.mcpRefreshToken.updateMany.mockResolvedValue({ count: 0 })
    await expect(consumeRefreshToken('x')).resolves.toBeNull()
    expect(db.mcpRefreshToken.findUnique).not.toHaveBeenCalled()
  })

  it('REPLAY: two concurrent refreshes of the same token — only ONE wins', async () => {
    db.mcpRefreshToken.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    db.mcpRefreshToken.findUnique.mockResolvedValue({ clientId: 'c1', staffId: 's1', activeOrg: 'o1', scopes: [] })
    const [a, b] = await Promise.all([consumeRefreshToken('x'), consumeRefreshToken('x')])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })
})
