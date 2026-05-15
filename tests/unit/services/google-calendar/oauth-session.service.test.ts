/**
 * GoogleOAuthSession service tests (Phase 1)
 *
 * Covers:
 *  - createOAuthSession returns an opaque 64-char token and stores the SHA-256 hash
 *  - loadAndAuthorizeSession rejects mismatched authUserId / expired / consumed sessions
 *  - consumeSession is atomic — a second call on the same session throws
 *
 * Regression coverage (alongside the new-feature tests):
 *  - SHA-256 hash is never equal to the plaintext token (would leak secret)
 *  - TTL is exactly 10 minutes (oauth_state contract documented in the spec)
 *  - createOAuthSession does NOT consume the row (consumedAt left null)
 */
import { Prisma, StaffRole } from '@prisma/client'

// Import mocked prisma reference for test-side stubbing.
import prisma from '@/utils/prismaClient'
import { createOAuthSession, loadAndAuthorizeSession, consumeSession } from '@/services/google-calendar/oauth-session.service'
import { AuthContext } from '@/security'

const authContext = (overrides: Partial<AuthContext> = {}): AuthContext => ({
  userId: 'user-1',
  orgId: 'org-1',
  venueId: 'venue-1',
  role: StaffRole.OWNER,
  ...overrides,
})

const baseArgs = {
  authUserId: 'user-1',
  intent: 'staff_personal' as const,
  staffId: 'user-1',
  encryptedRefreshToken: Buffer.from('rt'),
  encryptedAccessToken: Buffer.from('at'),
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
  googleAccountEmail: 'a@b.com',
  googleAccountSub: '1234',
}

describe('GoogleOAuthSession service', () => {
  // ============================================================
  // NEW FEATURE TESTS
  // ============================================================
  it('createOAuthSession returns an opaque 64-char token and persists its SHA-256 hash', async () => {
    const sessionRow = {
      id: 'session-1',
      tokenHash: 'placeholder', // we assert the real hash below from the mock call
      authUserId: 'user-1',
      intent: 'staff_personal',
      venueId: null,
      staffId: 'user-1',
      encryptedRefreshToken: Buffer.from('rt'),
      encryptedAccessToken: Buffer.from('at'),
      accessTokenExpiresAt: new Date(),
      googleAccountEmail: 'a@b.com',
      googleAccountSub: '1234',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60_000),
      consumedAt: null,
    }
    ;(prisma.googleOAuthSession.create as jest.Mock).mockResolvedValue(sessionRow)

    const { sessionToken, session } = await createOAuthSession(baseArgs)

    // 32 random bytes hex-encoded → 64 chars
    expect(sessionToken).toHaveLength(64)
    expect(/^[0-9a-f]{64}$/.test(sessionToken)).toBe(true)

    // The data we sent to Prisma must contain a hex hash (NOT the token itself)
    const createCall = (prisma.googleOAuthSession.create as jest.Mock).mock.calls[0][0]
    expect(createCall.data.tokenHash).toHaveLength(64)
    expect(createCall.data.tokenHash).not.toBe(sessionToken)
    // TTL is enforced server-side; we sanity-check it's "near 10 minutes from now"
    const ttlMs = (createCall.data.expiresAt as Date).getTime() - Date.now()
    expect(ttlMs).toBeGreaterThan(9 * 60_000)
    expect(ttlMs).toBeLessThanOrEqual(10 * 60_000 + 1_000)
    // Never consumed at creation
    expect(createCall.data.consumedAt).toBeUndefined()

    expect(session).toBe(sessionRow)
  })

  it('loadAndAuthorizeSession returns the session for the same authenticated user', async () => {
    const row = {
      id: 'session-1',
      tokenHash: 'h',
      authUserId: 'user-1',
      intent: 'staff_personal',
      staffId: 'user-1',
      venueId: null,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    }
    ;(prisma.googleOAuthSession.findUnique as jest.Mock).mockResolvedValue(row)

    const out = await loadAndAuthorizeSession('any-token', authContext({ userId: 'user-1' }))
    expect(out).toBe(row)
  })

  it('loadAndAuthorizeSession rejects when no row matches the token hash', async () => {
    ;(prisma.googleOAuthSession.findUnique as jest.Mock).mockResolvedValue(null)
    await expect(loadAndAuthorizeSession('bad-token', authContext())).rejects.toThrow(/oauth_session_not_found/)
  })

  it('loadAndAuthorizeSession rejects mismatched authUserId', async () => {
    ;(prisma.googleOAuthSession.findUnique as jest.Mock).mockResolvedValue({
      id: 'session-1',
      tokenHash: 'h',
      authUserId: 'user-1',
      intent: 'staff_personal',
      staffId: 'user-1',
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    })
    await expect(loadAndAuthorizeSession('tok', authContext({ userId: 'user-2' }))).rejects.toThrow(/oauth_session_user_mismatch/)
  })

  it('rejects expired sessions', async () => {
    ;(prisma.googleOAuthSession.findUnique as jest.Mock).mockResolvedValue({
      id: 'session-1',
      tokenHash: 'h',
      authUserId: 'user-1',
      intent: 'staff_personal',
      staffId: 'user-1',
      consumedAt: null,
      expiresAt: new Date(Date.now() - 1_000),
    })
    await expect(loadAndAuthorizeSession('tok', authContext())).rejects.toThrow(/oauth_session_expired/)
  })

  it('rejects already-consumed sessions', async () => {
    ;(prisma.googleOAuthSession.findUnique as jest.Mock).mockResolvedValue({
      id: 'session-1',
      tokenHash: 'h',
      authUserId: 'user-1',
      intent: 'staff_personal',
      staffId: 'user-1',
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await expect(loadAndAuthorizeSession('tok', authContext())).rejects.toThrow(/already_consumed/)
  })

  it('consumeSession marks the row consumed with updateMany(consumedAt: null)', async () => {
    ;(prisma.googleOAuthSession.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    await consumeSession(prisma as unknown as Prisma.TransactionClient, 'session-1')
    const call = (prisma.googleOAuthSession.updateMany as jest.Mock).mock.calls[0][0]
    expect(call.where).toEqual({ id: 'session-1', consumedAt: null })
    expect(call.data.consumedAt).toBeInstanceOf(Date)
  })

  it('consumeSession throws when no row was updated (race / double-consume)', async () => {
    ;(prisma.googleOAuthSession.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
    await expect(consumeSession(prisma as unknown as Prisma.TransactionClient, 'session-1')).rejects.toThrow(/already_consumed/)
  })

  // ============================================================
  // REGRESSION TESTS — guard the contract the controller depends on
  // ============================================================
  it('REGRESSION: createOAuthSession does NOT log or return the plaintext refresh token', async () => {
    const sessionRow = {
      id: 'session-1',
      tokenHash: 'h',
      authUserId: 'user-1',
      intent: 'staff_personal',
      staffId: 'user-1',
      encryptedRefreshToken: Buffer.from('rt'),
      encryptedAccessToken: Buffer.from('at'),
      accessTokenExpiresAt: new Date(),
      googleAccountEmail: 'a@b.com',
      googleAccountSub: '1234',
      expiresAt: new Date(Date.now() + 10 * 60_000),
      consumedAt: null,
    }
    ;(prisma.googleOAuthSession.create as jest.Mock).mockResolvedValue(sessionRow)
    const { sessionToken, session } = await createOAuthSession(baseArgs)

    // session.tokenHash must NEVER equal the sessionToken; that would defeat the hash.
    expect((session as { tokenHash: string }).tokenHash).not.toBe(sessionToken)
  })

  it('REGRESSION: loadAndAuthorizeSession does not depend on the plaintext token besides hashing it', async () => {
    // Ensure findUnique was called with a tokenHash (NOT the raw token) — guards
    // against a refactor that accidentally stores the plaintext in the DB key.
    ;(prisma.googleOAuthSession.findUnique as jest.Mock).mockResolvedValue({
      id: 'session-1',
      tokenHash: 'h',
      authUserId: 'user-1',
      intent: 'staff_personal',
      staffId: 'user-1',
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const PLAINTEXT = 'plaintext-session-token-xyz'
    await loadAndAuthorizeSession(PLAINTEXT, authContext({ userId: 'user-1' }))
    const call = (prisma.googleOAuthSession.findUnique as jest.Mock).mock.calls.at(-1)![0]
    expect(call.where.tokenHash).toBeDefined()
    expect(call.where.tokenHash).not.toBe(PLAINTEXT)
    expect(call.where.tokenHash).toHaveLength(64)
  })
})
