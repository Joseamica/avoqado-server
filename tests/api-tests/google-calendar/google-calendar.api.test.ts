/**
 * API tests for /api/v1/google-calendar/* endpoints (Phase 1).
 *
 * Covers all five routes:
 *   - GET    /oauth/init
 *   - GET    /oauth/callback           (UNAUTHENTICATED — Google's redirect target)
 *   - GET    /oauth/calendars
 *   - POST   /connections
 *   - GET    /connections
 *   - DELETE /connections/:id
 *
 * Auth strategy in this file:
 *   - The test JWT carries `role: OWNER` so authenticateTokenMiddleware passes.
 *   - `@/services/access/access.service.getUserAccess` is mocked to return a
 *     fixture that grants the calendar:* permissions we need per test. We
 *     bypass `hasPermission` indirectly by controlling the corePermissions
 *     array on the fixture (since the real `hasPermission` exported from the
 *     same module reads from this fixture).
 *
 * Regression coverage (per .claude/rules/testing-and-git.md) lives in the
 * "REGRESSION" describe block at the bottom of the file.
 */
import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { Express } from 'express'

import { prismaMock } from '@tests/__helpers__/setup'

const TEST_SECRET = 'test-access-token-secret'
const USER_ID = 'user-1'
const VENUE_ID = 'venue-1'
const ORG_ID = 'org-1'

// ============================================================
// Test-level mocks set BEFORE @/app import
// ============================================================

// googleapis: stubbed per-test where we exercise calendarList/events.watch.
const mockCalendarListList = jest.fn()
const mockCalendarListGet = jest.fn()
const mockEventsWatch = jest.fn()
const mockChannelsStop = jest.fn()

jest.mock('googleapis', () => {
  return {
    google: {
      calendar: jest.fn(() => ({
        calendarList: { list: mockCalendarListList, get: mockCalendarListGet },
        events: { watch: mockEventsWatch },
        channels: { stop: mockChannelsStop },
      })),
    },
  }
})

// Access service: mocked at the module level. `getUserAccess` returns the
// fixture we configure per-test; `hasPermission` is the real implementation
// (which reads from corePermissions on the same fixture).
const mockUserAccessFixture: any = {
  userId: USER_ID,
  venueId: VENUE_ID,
  organizationId: ORG_ID,
  role: 'OWNER',
  corePermissions: ['calendar:connect_self', 'calendar:manage_venue', 'calendar:disconnect_staff', 'calendar:view_status'],
  whiteLabelEnabled: false,
  enabledFeatures: [],
  featureAccess: {},
  featureMetadata: {},
}

jest.mock('@/services/access/access.service', () => {
  const real = jest.requireActual('@/services/access/access.service')
  return {
    ...real,
    getUserAccess: jest.fn(),
  }
})

// id_token verification — bypass JWKS in tests.
jest.mock('@/services/google-calendar/oauth.service', () => {
  const real = jest.requireActual('@/services/google-calendar/oauth.service')
  return {
    ...real,
    exchangeCodeForTokens: jest.fn(),
    verifyGoogleIdToken: jest.fn().mockResolvedValue({ sub: 'google-sub-1', email: 'me@example.com' }),
    buildOAuthClient: jest.fn().mockReturnValue({ setCredentials: jest.fn() }),
  }
})

// Encryption helpers — keep them deterministic and reversible so the
// real connection service can decrypt what it encrypted.
jest.mock('@/services/google-calendar/encryption.service', () => ({
  encryptToken: (s: string) => Buffer.from(`ENC(${s})`),
  decryptToken: (b: Buffer) =>
    Buffer.from(b)
      .toString('utf8')
      .replace(/^ENC\(/, '')
      .replace(/\)$/, ''),
}))

// Stable createOAuthSession spy — we'd otherwise need to fully mock prisma to
// the session create call. The real service is fine but in API tests we want
// deterministic behavior.
jest.mock('@/services/google-calendar/oauth-session.service', () => {
  const real = jest.requireActual('@/services/google-calendar/oauth-session.service')
  return real
})

// Session middleware — stub out express-session so cookies don't matter.
jest.mock('@/config/session', () => ({
  __esModule: true,
  default: (_req: any, _res: any, next: any) => next(),
}))

let app: Express

let accessService: {
  getUserAccess: jest.Mock
}
let oauthService: {
  exchangeCodeForTokens: jest.Mock
  verifyGoogleIdToken: jest.Mock
  signState: (payload: any) => string
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  process.env.ACCESS_TOKEN_SECRET = TEST_SECRET
  process.env.DASHBOARD_URL = 'https://dashboardv2.avoqado.io'

  jest.resetModules()
  const mod = await import('@/app')
  app = mod.default

  // Resolve mocked module references AFTER app boot so we hit the same
  // module instance the controller imports.
  accessService = (await import('@/services/access/access.service')) as any
  oauthService = (await import('@/services/google-calendar/oauth.service')) as any
})

beforeEach(() => {
  accessService.getUserAccess.mockResolvedValue({ ...mockUserAccessFixture })
})

const makeToken = (overrides: Partial<{ sub: string; venueId: string; role: string }> = {}) =>
  jwt.sign(
    {
      sub: overrides.sub ?? USER_ID,
      orgId: ORG_ID,
      venueId: overrides.venueId ?? VENUE_ID,
      role: overrides.role ?? 'OWNER',
    },
    TEST_SECRET,
    { algorithm: 'HS256' },
  )

// ============================================================
// GET /oauth/init
// ============================================================
describe('GET /api/v1/google-calendar/oauth/init', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/v1/google-calendar/oauth/init?intent=staff_personal')
    expect(res.status).toBe(401)
  })

  it('returns 400 for missing intent', async () => {
    const res = await request(app)
      .get('/api/v1/google-calendar/oauth/init')
      .set('Cookie', [`accessToken=${makeToken()}`])
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid intent', async () => {
    const res = await request(app)
      .get('/api/v1/google-calendar/oauth/init?intent=foo')
      .set('Cookie', [`accessToken=${makeToken()}`])
    expect(res.status).toBe(400)
  })

  it('returns 200 with a Google authorization URL for staff_personal', async () => {
    const res = await request(app)
      .get('/api/v1/google-calendar/oauth/init?intent=staff_personal')
      .set('Cookie', [`accessToken=${makeToken()}`])
    expect(res.status).toBe(200)
    expect(res.body.url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
    expect(res.body.url).toContain('access_type=offline')
    expect(res.body.url).toContain('include_granted_scopes=true')
    expect(res.body.url).toContain('state=')
    expect(res.body.url).not.toContain('prompt=consent') // first-time URL never forces consent
  })

  it('returns 200 with URL for venue_master', async () => {
    const res = await request(app)
      .get('/api/v1/google-calendar/oauth/init?intent=venue_master')
      .set('Cookie', [`accessToken=${makeToken()}`])
    expect(res.status).toBe(200)
    expect(res.body.url).toMatch(/^https:\/\/accounts\.google\.com/)
  })

  it('returns 403 when caller lacks calendar:manage_venue for venue_master intent', async () => {
    accessService.getUserAccess.mockResolvedValueOnce({
      ...mockUserAccessFixture,
      role: 'WAITER',
      corePermissions: ['calendar:connect_self'],
    })
    const res = await request(app)
      .get('/api/v1/google-calendar/oauth/init?intent=venue_master')
      .set('Cookie', [`accessToken=${makeToken({ role: 'WAITER' })}`])
    expect(res.status).toBe(403)
  })

  it('returns 403 when caller lacks calendar:connect_self for staff_personal intent', async () => {
    accessService.getUserAccess.mockResolvedValueOnce({
      ...mockUserAccessFixture,
      role: 'HOST',
      corePermissions: [],
    })
    const res = await request(app)
      .get('/api/v1/google-calendar/oauth/init?intent=staff_personal')
      .set('Cookie', [`accessToken=${makeToken({ role: 'HOST' })}`])
    expect(res.status).toBe(403)
  })
})

// ============================================================
// GET /oauth/callback (UNAUTHENTICATED)
// ============================================================
describe('GET /api/v1/google-calendar/oauth/callback', () => {
  let state: string
  beforeEach(() => {
    state = oauthService.signState({
      intent: 'staff_personal',
      authUserId: USER_ID,
      staffId: USER_ID,
      csrfNonce: 'a'.repeat(64),
    })
    ;(prismaMock.googleOAuthSession.create as jest.Mock).mockResolvedValue({
      id: 'session-1',
      tokenHash: 'hash',
    })
  })

  it('returns 400 when state is missing', async () => {
    const res = await request(app).get('/api/v1/google-calendar/oauth/callback?code=abc')
    expect(res.status).toBe(400)
  })

  it('returns 400 when state JWT is invalid', async () => {
    const res = await request(app).get('/api/v1/google-calendar/oauth/callback?code=abc&state=garbage')
    expect(res.status).toBe(400)
  })

  it('303-redirects to dashboard picker on success', async () => {
    oauthService.exchangeCodeForTokens.mockResolvedValueOnce({
      access_token: 'at',
      refresh_token: 'rt',
      id_token: 'idt',
      expiry_date: Date.now() + 3_600_000,
    })

    const res = await request(app).get(`/api/v1/google-calendar/oauth/callback?code=abc&state=${state}`)

    expect(res.status).toBe(303)
    expect(res.header.location).toMatch(/^https:\/\/dashboardv2\.avoqado\.io\/google-calendar\/picker\?session=[a-f0-9]{64}$/)
    expect(prismaMock.googleOAuthSession.create).toHaveBeenCalled()
  })

  it('does NOT require an auth token (Google redirects cookieless)', async () => {
    oauthService.exchangeCodeForTokens.mockResolvedValueOnce({
      access_token: 'at',
      refresh_token: 'rt',
      id_token: 'idt',
      expiry_date: Date.now() + 3_600_000,
    })
    const res = await request(app).get(`/api/v1/google-calendar/oauth/callback?code=abc&state=${state}`)
    // 303 success, not 401.
    expect(res.status).toBe(303)
  })

  it('retries with prompt=consent when refresh_token is missing', async () => {
    oauthService.exchangeCodeForTokens.mockResolvedValueOnce({
      access_token: 'at',
      id_token: 'idt',
      expiry_date: Date.now() + 3_600_000,
      // refresh_token deliberately missing — Google's re-consent behavior
    })

    const res = await request(app).get(`/api/v1/google-calendar/oauth/callback?code=abc&state=${state}`)

    expect(res.status).toBe(303)
    expect(res.header.location).toMatch(/^https:\/\/accounts\.google\.com\//)
    expect(res.header.location).toContain('prompt=consent')
    // No session was created on the retry path.
    expect(prismaMock.googleOAuthSession.create).not.toHaveBeenCalled()
  })
})

// ============================================================
// GET /oauth/calendars
// ============================================================
describe('GET /api/v1/google-calendar/oauth/calendars', () => {
  const sessionRow = {
    id: 'session-1',
    tokenHash: 'h',
    authUserId: USER_ID,
    intent: 'staff_personal',
    staffId: USER_ID,
    venueId: null,
    encryptedRefreshToken: Buffer.from('ENC(rt)'),
    encryptedAccessToken: Buffer.from('ENC(at)'),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    googleAccountEmail: 'me@example.com',
    googleAccountSub: 'google-sub-1',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
  }

  beforeEach(() => {
    ;(prismaMock.googleOAuthSession.findUnique as jest.Mock).mockResolvedValue(sessionRow)
    mockCalendarListList.mockResolvedValue({
      data: {
        items: [
          { id: 'primary', summary: 'Personal', timeZone: 'America/Mexico_City', accessRole: 'owner', primary: true },
          { id: 'shared@group', summary: 'Familia', timeZone: 'America/Mexico_City', accessRole: 'reader' },
          { id: 'team@group', summary: 'Team', timeZone: 'America/Mexico_City', accessRole: 'writer' },
        ],
      },
    })
  })

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/v1/google-calendar/oauth/calendars?session=foo')
    expect(res.status).toBe(401)
  })

  it('returns 400 when session param missing', async () => {
    const res = await request(app)
      .get('/api/v1/google-calendar/oauth/calendars')
      .set('Cookie', [`accessToken=${makeToken()}`])
    expect(res.status).toBe(400)
  })

  it('returns 404 when session not found', async () => {
    ;(prismaMock.googleOAuthSession.findUnique as jest.Mock).mockResolvedValueOnce(null)
    const res = await request(app)
      .get('/api/v1/google-calendar/oauth/calendars?session=unknown')
      .set('Cookie', [`accessToken=${makeToken()}`])
    expect(res.status).toBe(404)
  })

  it('returns 403 when session was started by a different user', async () => {
    ;(prismaMock.googleOAuthSession.findUnique as jest.Mock).mockResolvedValueOnce({
      ...sessionRow,
      authUserId: 'other-user',
    })
    const res = await request(app)
      .get('/api/v1/google-calendar/oauth/calendars?session=stolen')
      .set('Cookie', [`accessToken=${makeToken()}`])
    expect(res.status).toBe(403)
  })

  it('returns only owner|writer calendars for staff_personal intent', async () => {
    const res = await request(app)
      .get('/api/v1/google-calendar/oauth/calendars?session=ok')
      .set('Cookie', [`accessToken=${makeToken()}`])
    expect(res.status).toBe(200)
    const ids = (res.body.calendars as Array<{ id: string }>).map(c => c.id).sort()
    expect(ids).toEqual(['primary', 'team@group'])
  })

  it('returns owner|writer|reader calendars for venue_master intent', async () => {
    ;(prismaMock.googleOAuthSession.findUnique as jest.Mock).mockResolvedValueOnce({
      ...sessionRow,
      intent: 'venue_master',
      venueId: VENUE_ID,
      staffId: null,
    })
    const res = await request(app)
      .get('/api/v1/google-calendar/oauth/calendars?session=venue-tok')
      .set('Cookie', [`accessToken=${makeToken()}`])
    expect(res.status).toBe(200)
    expect((res.body.calendars as Array<{ id: string }>).length).toBe(3)
  })
})

// ============================================================
// POST /connections
// ============================================================
describe('POST /api/v1/google-calendar/connections', () => {
  const sessionRow = {
    id: 'session-1',
    tokenHash: 'h',
    authUserId: USER_ID,
    intent: 'staff_personal',
    staffId: USER_ID,
    venueId: null,
    encryptedRefreshToken: Buffer.from('ENC(rt)'),
    encryptedAccessToken: Buffer.from('ENC(at)'),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    googleAccountEmail: 'me@example.com',
    googleAccountSub: 'google-sub-1',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
  }

  beforeEach(() => {
    ;(prismaMock.googleOAuthSession.findUnique as jest.Mock).mockResolvedValue(sessionRow)
    ;(prismaMock.googleOAuthSession.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prismaMock.$transaction as jest.Mock).mockImplementation((cb: any) => (typeof cb === 'function' ? cb(prismaMock) : Promise.all(cb)))
    ;(prismaMock.googleCalendarConnection.create as jest.Mock).mockResolvedValue({
      id: 'conn-1',
      scope: 'STAFF_PERSONAL',
      staffId: USER_ID,
      venueId: null,
      googleAccountEmail: 'me@example.com',
      selectedCalendarId: 'cal-1',
      selectedCalendarSummary: 'My calendar',
      selectedCalendarTimeZone: 'America/Mexico_City',
      status: 'CONNECTED',
    })
    ;(prismaMock.googleCalendarChannel.create as jest.Mock).mockResolvedValue({
      id: 'ch-1',
    })
    mockCalendarListGet.mockResolvedValue({
      data: { summary: 'My calendar', timeZone: 'America/Mexico_City', accessRole: 'owner' },
    })
    mockEventsWatch.mockResolvedValue({
      data: {
        resourceId: 'resource-1',
        expiration: String(Date.now() + 7 * 86400_000),
      },
    })
  })

  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/v1/google-calendar/connections').send({ session: 'tok', selectedCalendarId: 'cal-1' })
    expect(res.status).toBe(401)
  })

  it('returns 400 when session is missing', async () => {
    const res = await request(app)
      .post('/api/v1/google-calendar/connections')
      .set('Cookie', [`accessToken=${makeToken()}`])
      .send({ selectedCalendarId: 'cal-1' })
    expect(res.status).toBe(400)
  })

  it('returns 400 when selectedCalendarId is missing', async () => {
    const res = await request(app)
      .post('/api/v1/google-calendar/connections')
      .set('Cookie', [`accessToken=${makeToken()}`])
      .send({ session: 'tok' })
    expect(res.status).toBe(400)
  })

  it('creates the connection atomically with channel and returns 201', async () => {
    const res = await request(app)
      .post('/api/v1/google-calendar/connections')
      .set('Cookie', [`accessToken=${makeToken()}`])
      .send({ session: 'tok', selectedCalendarId: 'cal-1' })

    expect(res.status).toBe(201)
    expect(res.body.connection.id).toBe('conn-1')
    expect(res.body.connection.scope).toBe('STAFF_PERSONAL')

    // Inside the transaction we ran: consumeSession + create connection + create channel.
    expect(prismaMock.googleOAuthSession.updateMany).toHaveBeenCalled()
    expect(prismaMock.googleCalendarConnection.create).toHaveBeenCalled()
    expect(prismaMock.googleCalendarChannel.create).toHaveBeenCalled()
  })

  it('returns 422 when accessRole is reader for staff_personal intent', async () => {
    mockCalendarListGet.mockResolvedValueOnce({
      data: { summary: 'Read-only', timeZone: 'America/Mexico_City', accessRole: 'reader' },
    })
    const res = await request(app)
      .post('/api/v1/google-calendar/connections')
      .set('Cookie', [`accessToken=${makeToken()}`])
      .send({ session: 'tok', selectedCalendarId: 'cal-readonly' })
    expect(res.status).toBe(422)
    // No DB writes happened.
    expect(prismaMock.googleCalendarConnection.create).not.toHaveBeenCalled()
    expect(prismaMock.googleCalendarChannel.create).not.toHaveBeenCalled()
  })

  it('returns 409 when session was already consumed (concurrent commit won)', async () => {
    ;(prismaMock.googleOAuthSession.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 })
    const res = await request(app)
      .post('/api/v1/google-calendar/connections')
      .set('Cookie', [`accessToken=${makeToken()}`])
      .send({ session: 'tok', selectedCalendarId: 'cal-1' })
    expect(res.status).toBe(409)
  })

  it('returns 403 when session was started by a different user', async () => {
    ;(prismaMock.googleOAuthSession.findUnique as jest.Mock).mockResolvedValueOnce({
      ...sessionRow,
      authUserId: 'someone-else',
    })
    const res = await request(app)
      .post('/api/v1/google-calendar/connections')
      .set('Cookie', [`accessToken=${makeToken()}`])
      .send({ session: 'tok', selectedCalendarId: 'cal-1' })
    expect(res.status).toBe(403)
  })
})

// ============================================================
// GET /connections
// ============================================================
describe('GET /api/v1/google-calendar/connections', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/v1/google-calendar/connections')
    expect(res.status).toBe(401)
  })

  it('returns the caller venue + personal connections', async () => {
    ;(prismaMock.googleCalendarConnection.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'conn-personal',
        scope: 'STAFF_PERSONAL',
        venueId: null,
        staffId: USER_ID,
        googleAccountEmail: 'me@example.com',
        selectedCalendarId: 'cal-1',
        selectedCalendarSummary: 'My',
        selectedCalendarTimeZone: 'America/Mexico_City',
        status: 'CONNECTED',
        statusReason: null,
        lastSyncedAt: null,
        connectedAt: new Date(),
        disconnectedAt: null,
      },
    ])
    const res = await request(app)
      .get('/api/v1/google-calendar/connections')
      .set('Cookie', [`accessToken=${makeToken()}`])
    expect(res.status).toBe(200)
    expect(res.body.connections).toHaveLength(1)
    expect(res.body.connections[0].id).toBe('conn-personal')

    const where = (prismaMock.googleCalendarConnection.findMany as jest.Mock).mock.calls[0][0].where
    expect(where.OR).toContainEqual({ staffId: USER_ID })
    expect(where.OR).toContainEqual({ venueId: VENUE_ID, scope: 'VENUE' })
  })

  it('select does NOT expose refreshTokenCiphertext or syncToken', async () => {
    ;(prismaMock.googleCalendarConnection.findMany as jest.Mock).mockResolvedValue([])
    await request(app)
      .get('/api/v1/google-calendar/connections')
      .set('Cookie', [`accessToken=${makeToken()}`])
    const select = (prismaMock.googleCalendarConnection.findMany as jest.Mock).mock.calls[0][0].select
    expect(select.refreshTokenCiphertext).toBeUndefined()
    expect(select.accessTokenCiphertext).toBeUndefined()
    expect(select.syncToken).toBeUndefined()
  })
})

// ============================================================
// DELETE /connections/:id
// ============================================================
describe('DELETE /api/v1/google-calendar/connections/:id', () => {
  beforeEach(() => {
    mockChannelsStop.mockResolvedValue({})
    ;(prismaMock.$transaction as jest.Mock).mockImplementation((arr: any) => (Array.isArray(arr) ? Promise.all(arr) : arr(prismaMock)))
  })

  it('returns 401 without auth', async () => {
    const res = await request(app).delete('/api/v1/google-calendar/connections/conn-1')
    expect(res.status).toBe(401)
  })

  it('returns 404 for unknown id', async () => {
    ;(prismaMock.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValueOnce(null)
    const res = await request(app)
      .delete('/api/v1/google-calendar/connections/conn-missing')
      .set('Cookie', [`accessToken=${makeToken()}`])
    expect(res.status).toBe(404)
  })

  it('allows the owner of a personal connection to disconnect (own personal)', async () => {
    ;(prismaMock.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'conn-1',
      scope: 'STAFF_PERSONAL',
      staffId: USER_ID,
      venueId: null,
      accessTokenCiphertext: Buffer.from('ENC(at)'),
      refreshTokenCiphertext: Buffer.from('ENC(rt)'),
      channels: [{ channelId: 'ch1', resourceId: 'r1', status: 'ACTIVE' }],
    })

    const res = await request(app)
      .delete('/api/v1/google-calendar/connections/conn-1')
      .set('Cookie', [`accessToken=${makeToken()}`])

    expect(res.status).toBe(204)
    expect(prismaMock.externalBusyBlock.deleteMany).toHaveBeenCalledWith({
      where: { googleConnectionId: 'conn-1' },
    })
    expect(prismaMock.googleCalendarChannel.updateMany).toHaveBeenCalled()
    expect(prismaMock.googleCalendarConnection.update).toHaveBeenCalled()
  })

  it('allows an OWNER with calendar:manage_venue to disconnect a venue master', async () => {
    ;(prismaMock.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'conn-2',
      scope: 'VENUE',
      staffId: null,
      venueId: VENUE_ID,
      accessTokenCiphertext: Buffer.from('ENC(at)'),
      refreshTokenCiphertext: Buffer.from('ENC(rt)'),
      channels: [],
    })

    const res = await request(app)
      .delete('/api/v1/google-calendar/connections/conn-2')
      .set('Cookie', [`accessToken=${makeToken()}`])

    expect(res.status).toBe(204)
  })

  it('returns 403 when caller is not the owner and lacks calendar:disconnect_staff', async () => {
    accessService.getUserAccess.mockResolvedValueOnce({
      ...mockUserAccessFixture,
      corePermissions: ['calendar:connect_self'], // no disconnect_staff
    })
    ;(prismaMock.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'conn-3',
      scope: 'STAFF_PERSONAL',
      staffId: 'someone-else',
      venueId: null,
      accessTokenCiphertext: Buffer.from('ENC(at)'),
      refreshTokenCiphertext: Buffer.from('ENC(rt)'),
      channels: [],
    })

    const res = await request(app)
      .delete('/api/v1/google-calendar/connections/conn-3')
      .set('Cookie', [`accessToken=${makeToken()}`])

    expect(res.status).toBe(403)
    expect(prismaMock.googleCalendarConnection.update).not.toHaveBeenCalled()
  })

  it('proceeds when stopChannel throws (token may be revoked at Google)', async () => {
    mockChannelsStop.mockRejectedValueOnce(new Error('token_revoked'))
    ;(prismaMock.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'conn-4',
      scope: 'STAFF_PERSONAL',
      staffId: USER_ID,
      venueId: null,
      accessTokenCiphertext: Buffer.from('ENC(at)'),
      refreshTokenCiphertext: Buffer.from('ENC(rt)'),
      channels: [{ channelId: 'ch1', resourceId: 'r1', status: 'ACTIVE' }],
    })

    const res = await request(app)
      .delete('/api/v1/google-calendar/connections/conn-4')
      .set('Cookie', [`accessToken=${makeToken()}`])

    expect(res.status).toBe(204)
    // Despite stopChannel failure, we still cleared blocks and marked DISCONNECTED.
    expect(prismaMock.externalBusyBlock.deleteMany).toHaveBeenCalled()
    expect(prismaMock.googleCalendarConnection.update).toHaveBeenCalled()
  })
})

// ============================================================
// REGRESSION TESTS (required per .claude/rules/testing-and-git.md)
// ============================================================
describe('REGRESSION — guard rails the rest of Phase 1 depends on', () => {
  it('REGRESSION: /oauth/callback is the ONLY endpoint that bypasses authentication', async () => {
    // /oauth/init
    let res = await request(app).get('/api/v1/google-calendar/oauth/init?intent=staff_personal')
    expect(res.status).toBe(401)
    // /oauth/calendars
    res = await request(app).get('/api/v1/google-calendar/oauth/calendars?session=x')
    expect(res.status).toBe(401)
    // POST /connections
    res = await request(app).post('/api/v1/google-calendar/connections').send({ session: 'x', selectedCalendarId: 'cal' })
    expect(res.status).toBe(401)
    // GET /connections
    res = await request(app).get('/api/v1/google-calendar/connections')
    expect(res.status).toBe(401)
    // DELETE /connections/:id
    res = await request(app).delete('/api/v1/google-calendar/connections/cid')
    expect(res.status).toBe(401)
    // /oauth/callback — no auth, just bad params → 400
    res = await request(app).get('/api/v1/google-calendar/oauth/callback?code=')
    expect(res.status).toBe(400)
  })

  it('REGRESSION: GET /oauth/init URL always includes access_type=offline (refresh_token guarantee)', async () => {
    const res = await request(app)
      .get('/api/v1/google-calendar/oauth/init?intent=staff_personal')
      .set('Cookie', [`accessToken=${makeToken()}`])
    expect(res.body.url).toContain('access_type=offline')
  })

  it('REGRESSION: /oauth/callback creates the session ONLY after refresh_token is present', async () => {
    // First: omitted refresh_token → retry redirect, NO session row.
    const state = oauthService.signState({
      intent: 'staff_personal',
      authUserId: USER_ID,
      staffId: USER_ID,
      csrfNonce: 'a'.repeat(64),
    })
    oauthService.exchangeCodeForTokens.mockResolvedValueOnce({
      access_token: 'at',
      id_token: 'idt',
      expiry_date: Date.now() + 3_600_000,
    })
    const res1 = await request(app).get(`/api/v1/google-calendar/oauth/callback?code=abc&state=${state}`)
    expect(res1.status).toBe(303)
    expect(prismaMock.googleOAuthSession.create).not.toHaveBeenCalled()

    // Second: refresh_token present → session created.
    oauthService.exchangeCodeForTokens.mockResolvedValueOnce({
      access_token: 'at',
      refresh_token: 'rt',
      id_token: 'idt',
      expiry_date: Date.now() + 3_600_000,
    })
    ;(prismaMock.googleOAuthSession.create as jest.Mock).mockResolvedValueOnce({ id: 'session-2', tokenHash: 'h' })

    const res2 = await request(app).get(`/api/v1/google-calendar/oauth/callback?code=abc&state=${state}`)
    expect(res2.status).toBe(303)
    expect(prismaMock.googleOAuthSession.create).toHaveBeenCalled()
  })
})
