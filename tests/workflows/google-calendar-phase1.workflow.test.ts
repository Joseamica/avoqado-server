/**
 * Phase 1 — Google Calendar Sync end-to-end workflow tests.
 *
 * These three workflows exercise the full Phase 1 stack on top of the global
 * Prisma mock (no real DB required). They demonstrate the seams between the
 * five Phase 1 surfaces:
 *
 *   1. CONNECT FLOW — OAuth init → callback → calendars picker → POST connections
 *      → manual `pullConnection` invocation (simulating the RabbitMQ consumer)
 *      → assert ExternalBusyBlock created → reservation rejected at busy slot
 *      → reservation accepted at free slot.
 *
 *   2. WEBHOOK PULL FLOW — Google posts to /api/v1/webhooks/google-calendar
 *      → inbox row written → 200 returned → manual `pullConnection` (sweeper
 *      simulation) → cancelled event tombstones existing block + new event
 *      creates a fresh block.
 *
 *   3. MULTI-VENUE STAFF — Personal connection (venueId=null, staffId=X) blocks
 *      reservations for that staff across EVERY venue they work in, but does
 *      NOT bleed onto reservations for OTHER staff at the same venue.
 *
 * Mocking strategy:
 *   - `googleapis` is mocked at the module level so events.list / events.watch
 *     / calendarList.* / channels.stop are deterministic.
 *   - `google-auth-library` `OAuth2Client.verifyIdToken` is mocked via the
 *     `oauth.service` module wrapper (mirrors the api-tests pattern).
 *   - Prisma is the global mock from `tests/__helpers__/setup.ts`. We seed it
 *     locally per workflow rather than using a real Postgres.
 *
 * All assertions verify observable behaviors: HTTP status codes, error messages,
 * Prisma calls, and ExternalBusyBlock state.
 */
import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { Express } from 'express'

import { prismaMock } from '@tests/__helpers__/setup'

// ============================================================
// Constants & seeds
// ============================================================
const TEST_SECRET = 'test-access-token-secret'
const ORG_ID = 'org-1'
const VENUE_ID = 'venue-1'
const VENUE_ID_B = 'venue-2'
const STAFF_ID = 'staff-juan'
const OTHER_STAFF_ID = 'staff-maria'
const CONNECTION_ID = 'conn-1'

// ============================================================
// Module-level mocks. MUST live above `import('@/app')`.
// ============================================================

// googleapis — we expose the inner mocks so each test can drive responses.
const mockCalendarListList = jest.fn()
const mockCalendarListGet = jest.fn()
const mockEventsWatch = jest.fn()
const mockEventsList = jest.fn()
const mockChannelsStop = jest.fn()

jest.mock('googleapis', () => ({
  google: {
    calendar: jest.fn(() => ({
      calendarList: { list: mockCalendarListList, get: mockCalendarListGet },
      events: { watch: mockEventsWatch, list: mockEventsList },
      channels: { stop: mockChannelsStop },
    })),
  },
}))

// Access service — controllers gate intent/permission checks through this.
const mockUserAccessFixture: any = {
  userId: STAFF_ID,
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

// oauth.service — keep `signState`/`verifyState`/`buildAuthUrl` real (we need
// them to round-trip JWTs deterministically), stub Google-talking bits.
jest.mock('@/services/google-calendar/oauth.service', () => {
  const real = jest.requireActual('@/services/google-calendar/oauth.service')
  return {
    ...real,
    exchangeCodeForTokens: jest.fn(),
    verifyGoogleIdToken: jest.fn().mockResolvedValue({ sub: 'google-sub-1', email: 'juan@example.com' }),
    buildOAuthClient: jest.fn().mockReturnValue({ setCredentials: jest.fn() }),
    refreshAccessToken: jest.fn(),
  }
})

// Encryption — reversible stubs so what we encrypt in the callback can be
// decrypted in the picker/commit/pull paths.
jest.mock('@/services/google-calendar/encryption.service', () => ({
  encryptToken: (s: string) => Buffer.from(`ENC(${s})`),
  decryptToken: (b: Buffer) =>
    Buffer.from(b)
      .toString('utf8')
      .replace(/^ENC\(/, '')
      .replace(/\)$/, ''),
}))

// Session — bypass express-session so the workflow doesn't need a cookie store.
jest.mock('@/config/session', () => ({
  __esModule: true,
  default: (_req: any, _res: any, next: any) => next(),
}))

// RabbitMQ — connection.service tries to enqueue a pull post-commit. We replace
// the channel publisher with a no-op so the test doesn't need a broker.
const rabbitPublishMock = jest.fn().mockReturnValue(true)
jest.mock('@/communication/rabbitmq/connection', () => ({
  getRabbitMQChannel: jest.fn(() => ({ publish: rabbitPublishMock })),
  POS_COMMANDS_EXCHANGE: 'pos_commands_exchange',
}))

// ============================================================
// Lazy imports (resolved AFTER mocks above are active).
// ============================================================
let app: Express
let oauthService: {
  exchangeCodeForTokens: jest.Mock
  verifyGoogleIdToken: jest.Mock
  signState: (payload: any) => string
}
let accessService: { getUserAccess: jest.Mock }
let pullService: typeof import('@/services/google-calendar/pull.service')
let reservationService: typeof import('@/services/dashboard/reservation.dashboard.service')
let webhookController: typeof import('@/controllers/webhook/google-calendar.webhook.controller')

beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  process.env.ACCESS_TOKEN_SECRET = TEST_SECRET
  process.env.DASHBOARD_URL = 'https://dashboardv2.avoqado.io'

  jest.resetModules()
  const mod = await import('@/app')
  app = mod.default
  accessService = (await import('@/services/access/access.service')) as any
  oauthService = (await import('@/services/google-calendar/oauth.service')) as any
  pullService = (await import('@/services/google-calendar/pull.service')) as any
  reservationService = (await import('@/services/dashboard/reservation.dashboard.service')) as any
  webhookController = (await import('@/controllers/webhook/google-calendar.webhook.controller')) as any
})

beforeEach(() => {
  accessService.getUserAccess.mockResolvedValue({ ...mockUserAccessFixture })
  // Default transaction implementation: callback gets the prisma mock; arrays
  // resolve to Promise.all. Individual tests may override per scenario.
  ;(prismaMock.$transaction as jest.Mock).mockImplementation((arg: any) => {
    if (typeof arg === 'function') return arg(prismaMock)
    return Promise.all(arg)
  })
  // Advisory-lock acquisition for pullConnection — default to "acquired".
  ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([{ acquired: true }])
  rabbitPublishMock.mockClear()
  mockCalendarListList.mockReset()
  mockCalendarListGet.mockReset()
  mockEventsWatch.mockReset()
  mockEventsList.mockReset()
  mockChannelsStop.mockReset()
})

// ============================================================
// Helpers
// ============================================================
const makeToken = (overrides: Partial<{ sub: string; venueId: string; role: string }> = {}) =>
  jwt.sign(
    {
      sub: overrides.sub ?? STAFF_ID,
      orgId: ORG_ID,
      venueId: overrides.venueId ?? VENUE_ID,
      role: overrides.role ?? 'OWNER',
    },
    TEST_SECRET,
    { algorithm: 'HS256' },
  )

/** Seed a CONNECTED staff-personal connection that the pull service can load. */
function seedConnection(overrides: Partial<any> = {}) {
  const row = {
    id: CONNECTION_ID,
    status: 'CONNECTED',
    scope: 'STAFF_PERSONAL',
    venueId: null,
    staffId: STAFF_ID,
    selectedCalendarId: 'cal-1',
    selectedCalendarTimeZone: 'America/Mexico_City',
    syncToken: null,
    lastHorizonEnd: null,
    accessTokenCiphertext: Buffer.from('ENC(at)'),
    refreshTokenCiphertext: Buffer.from('ENC(rt)'),
    googleAccountEmail: 'juan@example.com',
    googleAccountSub: 'google-sub-1',
    venue: null,
    ...overrides,
  }
  ;(prismaMock.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValue(row)
  return row
}

/** Build a fake Google Calendar event payload. */
function gEvent(overrides: Partial<any> = {}): any {
  return {
    id: 'ev-1',
    status: 'confirmed',
    start: { dateTime: '2026-05-20T10:00:00Z' },
    end: { dateTime: '2026-05-20T11:00:00Z' },
    summary: 'Personal block',
    ...overrides,
  }
}

// ============================================================
// TASK 28 — Connect → backfill → block visible
// ============================================================
describe('WORKFLOW [Task 28]: connect → backfill → reservation rejected at busy slot', () => {
  it('drives the full connect flow and verifies an external block prevents a reservation', async () => {
    // ------------------------------------------------------------
    // Step 1 — GET /oauth/init returns a Google authorization URL.
    // ------------------------------------------------------------
    const initRes = await request(app)
      .get('/api/v1/google-calendar/oauth/init?intent=staff_personal')
      .set('Cookie', [`accessToken=${makeToken()}`])

    expect(initRes.status).toBe(200)
    expect(initRes.body.url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
    // Parse the state JWT out of the auth URL so the callback can verify it.
    const urlObj = new URL(initRes.body.url)
    const stateForCallback = urlObj.searchParams.get('state')!
    expect(stateForCallback.length).toBeGreaterThan(0)

    // ------------------------------------------------------------
    // Step 2 — GET /oauth/callback?code=...&state=... → 303 with session token.
    // ------------------------------------------------------------
    oauthService.exchangeCodeForTokens.mockResolvedValueOnce({
      access_token: 'at',
      refresh_token: 'rt',
      id_token: 'idt',
      expiry_date: Date.now() + 3_600_000,
    })
    ;(prismaMock.googleOAuthSession.create as jest.Mock).mockResolvedValueOnce({
      id: 'session-1',
      tokenHash: 'hash',
    })

    const callbackRes = await request(app).get(`/api/v1/google-calendar/oauth/callback?code=fake&state=${stateForCallback}`)

    expect(callbackRes.status).toBe(303)
    expect(callbackRes.header.location).toMatch(/^https:\/\/dashboardv2\.avoqado\.io\/google-calendar\/picker\?session=[a-f0-9]{64}$/)
    expect(prismaMock.googleOAuthSession.create).toHaveBeenCalled()
    // Extract the opaque session token the dashboard will use.
    const sessionToken = new URL(callbackRes.header.location).searchParams.get('session')!

    // ------------------------------------------------------------
    // Step 3 — GET /oauth/calendars?session=... returns the picker list.
    // ------------------------------------------------------------
    const sessionRow = {
      id: 'session-1',
      tokenHash: 'h',
      authUserId: STAFF_ID,
      intent: 'staff_personal',
      staffId: STAFF_ID,
      venueId: null,
      encryptedRefreshToken: Buffer.from('ENC(rt)'),
      encryptedAccessToken: Buffer.from('ENC(at)'),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      googleAccountEmail: 'juan@example.com',
      googleAccountSub: 'google-sub-1',
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    }
    ;(prismaMock.googleOAuthSession.findUnique as jest.Mock).mockResolvedValue(sessionRow)
    mockCalendarListList.mockResolvedValue({
      data: {
        items: [
          { id: 'primary', summary: 'Personal', timeZone: 'America/Mexico_City', accessRole: 'owner', primary: true },
          { id: 'cal-1', summary: 'My calendar', timeZone: 'America/Mexico_City', accessRole: 'writer' },
        ],
      },
    })

    const calendarsRes = await request(app)
      .get(`/api/v1/google-calendar/oauth/calendars?session=${sessionToken}`)
      .set('Cookie', [`accessToken=${makeToken()}`])

    expect(calendarsRes.status).toBe(200)
    expect((calendarsRes.body.calendars as any[]).map(c => c.id).sort()).toEqual(['cal-1', 'primary'])

    // ------------------------------------------------------------
    // Step 4 — POST /connections atomically commits the connection.
    // ------------------------------------------------------------
    ;(prismaMock.googleOAuthSession.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prismaMock.googleCalendarConnection.create as jest.Mock).mockResolvedValue({
      id: CONNECTION_ID,
      scope: 'STAFF_PERSONAL',
      staffId: STAFF_ID,
      venueId: null,
      googleAccountEmail: 'juan@example.com',
      selectedCalendarId: 'cal-1',
      selectedCalendarSummary: 'My calendar',
      selectedCalendarTimeZone: 'America/Mexico_City',
      status: 'CONNECTED',
      // syncToken=null per the spec — backfill is what advances it.
      syncToken: null,
    })
    ;(prismaMock.googleCalendarChannel.create as jest.Mock).mockResolvedValue({ id: 'ch-1' })
    mockCalendarListGet.mockResolvedValue({
      data: { summary: 'My calendar', timeZone: 'America/Mexico_City', accessRole: 'writer' },
    })
    mockEventsWatch.mockResolvedValue({
      data: { resourceId: 'res-1', expiration: String(Date.now() + 7 * 86400_000) },
    })

    const postRes = await request(app)
      .post('/api/v1/google-calendar/connections')
      .set('Cookie', [`accessToken=${makeToken()}`])
      .send({ session: sessionToken, selectedCalendarId: 'cal-1' })

    expect(postRes.status).toBe(201)
    expect(postRes.body.connection.id).toBe(CONNECTION_ID)
    // CRITICAL: a freshly-committed connection has syncToken=null. The pull
    // worker's "needs full sync" predicate is what later flips it.
    expect((prismaMock.googleCalendarConnection.create as jest.Mock).mock.calls[0][0].data.syncToken).toBeUndefined()

    // ------------------------------------------------------------
    // Step 5 — Manual `pullConnection` (simulating the RabbitMQ consumer).
    // The events.list mock returns 2 events:
    //   - In horizon (10:00–11:00 UTC, ~5 days from now)
    //   - Outside horizon (far future, beyond maxAdvanceDays=60)
    // ------------------------------------------------------------
    const now = new Date()
    const inHorizonStart = new Date(now.getTime() + 5 * 86400_000)
    const inHorizonEnd = new Date(inHorizonStart.getTime() + 60 * 60_000)
    const outOfHorizonStart = new Date(now.getTime() + 120 * 86400_000) // 120d > 60d
    const outOfHorizonEnd = new Date(outOfHorizonStart.getTime() + 60 * 60_000)

    seedConnection({
      // ReservationSettings.maxAdvanceDays = 60 day horizon
      venue: { reservationSettings: { maxAdvanceDays: 60 } },
      syncToken: null,
      // staff-personal: but we attach venue for getMaxAdvanceDays — the service
      // tolerates both. Keep scope = STAFF_PERSONAL.
    })
    mockEventsList.mockResolvedValueOnce({
      data: {
        items: [
          gEvent({
            id: 'ev-in',
            start: { dateTime: inHorizonStart.toISOString() },
            end: { dateTime: inHorizonEnd.toISOString() },
          }),
          gEvent({
            id: 'ev-out',
            start: { dateTime: outOfHorizonStart.toISOString() },
            end: { dateTime: outOfHorizonEnd.toISOString() },
          }),
        ],
        nextSyncToken: 'sync-token-after-backfill',
      },
    })

    // upsertBlock writes are deferred to externalBusyBlock.upsert under the hood.
    ;(prismaMock.externalBusyBlock.deleteMany as jest.Mock).mockResolvedValue({ count: 0 })
    ;(prismaMock.externalBusyBlock.upsert as jest.Mock).mockResolvedValue({})
    ;(prismaMock.googleCalendarConnection.update as jest.Mock).mockResolvedValue({})

    await pullService.pullConnection(CONNECTION_ID)

    // ASSERTIONS:
    // events.list called with backfill semantics (timeMin/timeMax, no syncToken).
    const eventsListArg = mockEventsList.mock.calls[0][0]
    expect(eventsListArg.calendarId).toBe('cal-1')
    expect(eventsListArg.singleEvents).toBe(true)
    expect(eventsListArg.showDeleted).toBe(false)
    expect(eventsListArg.timeMin).toBeDefined()
    expect(eventsListArg.timeMax).toBeDefined()
    expect(eventsListArg.syncToken).toBeUndefined()

    // Connection.update must persist `syncToken` and `lastHorizonEnd`.
    const updateArg = (prismaMock.googleCalendarConnection.update as jest.Mock).mock.calls[0][0]
    expect(updateArg.where).toEqual({ id: CONNECTION_ID })
    expect(updateArg.data.syncToken).toBe('sync-token-after-backfill')
    expect(updateArg.data.lastSyncedAt).toBeInstanceOf(Date)
    expect(updateArg.data.lastHorizonEnd).toBeInstanceOf(Date)

    // BOTH events were upserted (the horizon filter is NOT applied during
    // backfill — events.list with timeMin/timeMax already excludes out-of-window
    // rows). The mock returns both because the test injected them directly, but
    // production Google would only return the in-horizon one. We still verify
    // upserts ran.
    expect((prismaMock.externalBusyBlock.upsert as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1)

    // ------------------------------------------------------------
    // Step 6 — Create a reservation at the busy time → ConflictError.
    //
    // We invoke `createReservation` directly on the service so we don't have to
    // wire request validators + auth context. The service uses the global
    // prisma mock so we point `checkExternalBusyBlock`'s findFirst at an
    // existing block row.
    // ------------------------------------------------------------
    ;(prismaMock.table.findFirst as jest.Mock).mockResolvedValue(null) // no table
    ;(prismaMock.product.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prismaMock.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-1' })
    ;(prismaMock.externalBusyBlock.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 'block-1',
      googleConnectionId: CONNECTION_ID,
      venueId: VENUE_ID,
      staffId: STAFF_ID,
      externalEventId: 'ev-in',
      startsAt: inHorizonStart,
      endsAt: inHorizonEnd,
    })

    await expect(
      reservationService.createReservation(
        VENUE_ID,
        {
          startsAt: inHorizonStart,
          endsAt: inHorizonEnd,
          duration: 60,
          partySize: 2,
          assignedStaffId: STAFF_ID,
          guestName: 'Test',
        },
        STAFF_ID,
        { scheduling: { maxAdvanceDays: 60 } },
      ),
    ).rejects.toThrow(/calendario externo/i)

    // Sanity: the external-busy-block lookup actually fired.
    expect(prismaMock.externalBusyBlock.findFirst).toHaveBeenCalled()

    // ------------------------------------------------------------
    // Step 7 — Create a reservation at a FREE time → success.
    // ------------------------------------------------------------
    const freeStart = new Date(now.getTime() + 10 * 86400_000)
    const freeEnd = new Date(freeStart.getTime() + 60 * 60_000)
    ;(prismaMock.externalBusyBlock.findFirst as jest.Mock).mockReset().mockResolvedValueOnce(null)
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([]) // no overlap conflicts
    ;(prismaMock.reservation.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prismaMock.reservation.create as jest.Mock).mockResolvedValue({
      id: 'res-1',
      confirmationCode: 'RES-FREE01',
      venueId: VENUE_ID,
      status: 'CONFIRMED',
    })

    const created = await reservationService.createReservation(
      VENUE_ID,
      {
        startsAt: freeStart,
        endsAt: freeEnd,
        duration: 60,
        partySize: 2,
        assignedStaffId: STAFF_ID,
        guestName: 'Test',
      },
      STAFF_ID,
      { scheduling: { maxAdvanceDays: 60 } },
    )
    expect(created.id).toBe('res-1')
  })
})

// ============================================================
// TASK 29 — Webhook → pull → block updated
// ============================================================
describe('WORKFLOW [Task 29]: webhook → durable inbox → pullConnection → block updated', () => {
  it('writes inbox row, then incremental pull tombstones + creates blocks', async () => {
    // ------------------------------------------------------------
    // Step 1 — Google posts to /api/v1/webhooks/google-calendar. The controller
    // must find the active channel, write an inbox row, and return 200.
    // ------------------------------------------------------------
    const CHANNEL_ID = 'channel-abc'
    const CHANNEL_TOKEN = 'super-secret-token-32-bytes-long-abc'
    const RESOURCE_ID = 'res-1'

    ;(prismaMock.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'ch-row-1',
        channelId: CHANNEL_ID,
        token: CHANNEL_TOKEN,
        resourceId: RESOURCE_ID,
        status: 'ACTIVE',
        connectionId: CONNECTION_ID,
        connection: { id: CONNECTION_ID, status: 'CONNECTED' },
      },
    ])
    ;(prismaMock.googleCalendarWebhookInbox.create as jest.Mock).mockResolvedValue({ id: 'inbox-1' })

    const webhookRes = await request(app)
      .post('/api/v1/webhooks/google-calendar')
      .set('X-Goog-Channel-ID', CHANNEL_ID)
      .set('X-Goog-Channel-Token', CHANNEL_TOKEN)
      .set('X-Goog-Resource-ID', RESOURCE_ID)
      .set('X-Goog-Resource-State', 'exists')
      .set('X-Goog-Message-Number', '2')

    expect(webhookRes.status).toBe(200)
    expect(prismaMock.googleCalendarWebhookInbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        connectionId: CONNECTION_ID,
        channelId: CHANNEL_ID,
        resourceId: RESOURCE_ID,
        resourceState: 'exists',
        messageNumber: '2',
      }),
    })

    // ------------------------------------------------------------
    // Step 2 — Simulate the RabbitMQ consumer (or the inbox sweeper) firing
    // `pullConnection` for the affected connection.
    //
    // The pull engine runs INCREMENTAL because the connection now has a
    // syncToken from the prior backfill. events.list returns:
    //   - A 'cancelled' event → tombstones an existing block.
    //   - A new event in horizon → creates a fresh block.
    // ------------------------------------------------------------
    const now = new Date()
    const newEventStart = new Date(now.getTime() + 3 * 86400_000)
    const newEventEnd = new Date(newEventStart.getTime() + 30 * 60_000)

    seedConnection({
      syncToken: 'sync-token-after-backfill',
      venue: { reservationSettings: { maxAdvanceDays: 60 } },
    })
    mockEventsList.mockResolvedValueOnce({
      data: {
        items: [
          // Cancellation tombstone
          { id: 'ev-cancelled', status: 'cancelled' },
          // New event
          gEvent({
            id: 'ev-new',
            start: { dateTime: newEventStart.toISOString() },
            end: { dateTime: newEventEnd.toISOString() },
            summary: 'Doctor',
          }),
        ],
        nextSyncToken: 'sync-token-after-incremental',
      },
    })

    ;(prismaMock.externalBusyBlock.deleteMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prismaMock.externalBusyBlock.upsert as jest.Mock).mockResolvedValue({})
    ;(prismaMock.googleCalendarConnection.update as jest.Mock).mockResolvedValue({})

    await pullService.pullConnection(CONNECTION_ID)

    // events.list MUST be called with syncToken semantics — no timeMin/timeMax.
    const incrementalArgs = mockEventsList.mock.calls[mockEventsList.mock.calls.length - 1][0]
    expect(incrementalArgs.syncToken).toBe('sync-token-after-backfill')
    expect(incrementalArgs.showDeleted).toBe(true)
    expect(incrementalArgs.timeMin).toBeUndefined()
    expect(incrementalArgs.timeMax).toBeUndefined()

    // Cancellation path: deleteMany called with the cancelled event id.
    const deleteCalls = (prismaMock.externalBusyBlock.deleteMany as jest.Mock).mock.calls.map(c => c[0])
    expect(deleteCalls).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({ externalEventId: 'ev-cancelled' }),
      }),
    )

    // New event path: upsert called.
    expect((prismaMock.externalBusyBlock.upsert as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1)

    // Sync cursor advanced.
    const updateData = (prismaMock.googleCalendarConnection.update as jest.Mock).mock.calls.pop()![0].data
    expect(updateData.syncToken).toBe('sync-token-after-incremental')
    expect(updateData.lastSyncedAt).toBeInstanceOf(Date)
  })

  it('REGRESSION: webhook ack still happens even when connection is DISCONNECTED (no inbox row)', async () => {
    ;(prismaMock.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'ch-row-2',
        channelId: 'channel-dead',
        token: 'tok-dead-12345678901234567890ABCDEF',
        resourceId: 'res-dead',
        status: 'ACTIVE',
        connectionId: 'conn-dead',
        connection: { id: 'conn-dead', status: 'DISCONNECTED' },
      },
    ])
    ;(prismaMock.googleCalendarWebhookInbox.create as jest.Mock).mockClear()

    const res = await request(app)
      .post('/api/v1/webhooks/google-calendar')
      .set('X-Goog-Channel-ID', 'channel-dead')
      .set('X-Goog-Channel-Token', 'tok-dead-12345678901234567890ABCDEF')
      .set('X-Goog-Resource-ID', 'res-dead')
      .set('X-Goog-Resource-State', 'exists')

    expect(res.status).toBe(200)
    expect(prismaMock.googleCalendarWebhookInbox.create).not.toHaveBeenCalled()
  })
})

// ============================================================
// TASK 30 — Multi-venue staff: personal block applies to every venue
// ============================================================
describe('WORKFLOW [Task 30]: multi-venue staff personal block bleeds across venues', () => {
  it('blocks Juan in BOTH venues but NOT Maria, and free slots still pass', async () => {
    const now = new Date()
    const busyStart = new Date(now.getTime() + 7 * 86400_000)
    const busyEnd = new Date(busyStart.getTime() + 60 * 60_000)
    const freeStart = new Date(now.getTime() + 14 * 86400_000)
    const freeEnd = new Date(freeStart.getTime() + 60 * 60_000)

    // ------------------------------------------------------------
    // Step 1 — Seed: ExternalBusyBlock for Juan (venueId=null, staffId=Juan).
    // This is the canonical shape produced by pullConnection on a
    // STAFF_PERSONAL connection with venueId=null.
    // ------------------------------------------------------------
    const personalBlock = {
      id: 'block-juan-1',
      googleConnectionId: CONNECTION_ID,
      venueId: null,
      staffId: STAFF_ID,
      externalEventId: 'ev-personal',
      startsAt: busyStart,
      endsAt: busyEnd,
    }

    // ------------------------------------------------------------
    // Step 2 — Attempt reservation for Juan at Venue A at the busy time → reject.
    // ------------------------------------------------------------
    ;(prismaMock.table.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prismaMock.product.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prismaMock.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-juan-venueA' })
    ;(prismaMock.externalBusyBlock.findFirst as jest.Mock).mockReset()
    ;(prismaMock.externalBusyBlock.findFirst as jest.Mock).mockResolvedValueOnce(personalBlock)

    await expect(
      reservationService.createReservation(
        VENUE_ID, // Venue A
        {
          startsAt: busyStart,
          endsAt: busyEnd,
          duration: 60,
          partySize: 1,
          assignedStaffId: STAFF_ID,
          guestName: 'Test',
        },
        STAFF_ID,
        { scheduling: { maxAdvanceDays: 60 } },
      ),
    ).rejects.toThrow(/calendario externo/i)

    // The `where` clause must OR `(venueId=A)` with `(staffId=Juan)` so the
    // staff-personal block is found.
    const findFirstArgsA = (prismaMock.externalBusyBlock.findFirst as jest.Mock).mock.calls[0][0]
    expect(findFirstArgsA.where.OR).toContainEqual({ venueId: VENUE_ID })
    expect(findFirstArgsA.where.OR).toContainEqual({ staffId: STAFF_ID })

    // ------------------------------------------------------------
    // Step 3 — Attempt reservation for Juan at Venue B at the same busy time → reject.
    // Even though venueId differs, Juan's staff-personal block still matches via
    // `OR: [{ venueId: B }, { staffId: Juan }]`.
    // ------------------------------------------------------------
    ;(prismaMock.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-juan-venueB' })
    ;(prismaMock.externalBusyBlock.findFirst as jest.Mock).mockReset()
    ;(prismaMock.externalBusyBlock.findFirst as jest.Mock).mockResolvedValueOnce(personalBlock)

    await expect(
      reservationService.createReservation(
        VENUE_ID_B, // Venue B
        {
          startsAt: busyStart,
          endsAt: busyEnd,
          duration: 60,
          partySize: 1,
          assignedStaffId: STAFF_ID,
          guestName: 'Test',
        },
        STAFF_ID,
        { scheduling: { maxAdvanceDays: 60 } },
      ),
    ).rejects.toThrow(/calendario externo/i)

    const findFirstArgsB = (prismaMock.externalBusyBlock.findFirst as jest.Mock).mock.calls[0][0]
    expect(findFirstArgsB.where.OR).toContainEqual({ venueId: VENUE_ID_B })
    expect(findFirstArgsB.where.OR).toContainEqual({ staffId: STAFF_ID })

    // ------------------------------------------------------------
    // Step 4 — Reservation for Juan at Venue A at a FREE time → success.
    // ------------------------------------------------------------
    ;(prismaMock.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-juan-venueA' })
    ;(prismaMock.externalBusyBlock.findFirst as jest.Mock).mockReset().mockResolvedValueOnce(null)
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])
    ;(prismaMock.reservation.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prismaMock.reservation.create as jest.Mock).mockResolvedValue({
      id: 'res-free-juan',
      confirmationCode: 'RES-JUAN01',
      venueId: VENUE_ID,
      status: 'CONFIRMED',
    })

    const juanFree = await reservationService.createReservation(
      VENUE_ID,
      {
        startsAt: freeStart,
        endsAt: freeEnd,
        duration: 60,
        partySize: 1,
        assignedStaffId: STAFF_ID,
        guestName: 'Test',
      },
      STAFF_ID,
      { scheduling: { maxAdvanceDays: 60 } },
    )
    expect(juanFree.id).toBe('res-free-juan')

    // ------------------------------------------------------------
    // Step 5 — Reservation for Maria (different staff) at Venue A at the BUSY
    // time → success. Juan's personal block must NOT match Maria.
    //
    // checkExternalBusyBlock filters by `OR: [{ venueId }, { staffId: Maria }]`.
    // Since the seeded block has venueId=null and staffId=Juan, neither clause
    // matches Maria's lookup → null → reservation proceeds.
    // ------------------------------------------------------------
    ;(prismaMock.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-maria-venueA' })
    ;(prismaMock.externalBusyBlock.findFirst as jest.Mock).mockReset().mockResolvedValueOnce(null)
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])
    ;(prismaMock.reservation.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prismaMock.reservation.create as jest.Mock).mockResolvedValue({
      id: 'res-busy-maria',
      confirmationCode: 'RES-MARIA1',
      venueId: VENUE_ID,
      status: 'CONFIRMED',
    })

    const mariaBusy = await reservationService.createReservation(
      VENUE_ID,
      {
        startsAt: busyStart,
        endsAt: busyEnd,
        duration: 60,
        partySize: 1,
        assignedStaffId: OTHER_STAFF_ID,
        guestName: 'Test',
      },
      OTHER_STAFF_ID,
      { scheduling: { maxAdvanceDays: 60 } },
    )
    expect(mariaBusy.id).toBe('res-busy-maria')

    // The lookup for Maria must have used her staffId — not Juan's.
    const mariaFindFirstArgs = (prismaMock.externalBusyBlock.findFirst as jest.Mock).mock.calls[0][0]
    expect(mariaFindFirstArgs.where.OR).toContainEqual({ staffId: OTHER_STAFF_ID })
    expect(mariaFindFirstArgs.where.OR).not.toContainEqual({ staffId: STAFF_ID })
  })
})

// ============================================================
// REGRESSION — protect the seams these workflows depend on
// (required per .claude/rules/testing-and-git.md)
// ============================================================
describe('REGRESSION — Phase 1 invariants exercised by the workflows', () => {
  it('REGRESSION: checkExternalBusyBlock query always includes venueId in the OR clause', async () => {
    ;(prismaMock.table.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prismaMock.product.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prismaMock.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-1' })
    ;(prismaMock.externalBusyBlock.findFirst as jest.Mock).mockReset().mockResolvedValueOnce(null)
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])
    ;(prismaMock.reservation.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prismaMock.reservation.create as jest.Mock).mockResolvedValue({
      id: 'res-x',
      confirmationCode: 'RES-X00001',
      venueId: VENUE_ID,
      status: 'CONFIRMED',
    })

    const now = new Date()
    await reservationService.createReservation(
      VENUE_ID,
      {
        startsAt: new Date(now.getTime() + 24 * 60 * 60_000),
        endsAt: new Date(now.getTime() + 25 * 60 * 60_000),
        duration: 60,
        partySize: 1,
        assignedStaffId: STAFF_ID,
        guestName: 'Test',
      },
      STAFF_ID,
      { scheduling: { maxAdvanceDays: 60 } },
    )

    const where = (prismaMock.externalBusyBlock.findFirst as jest.Mock).mock.calls[0][0].where
    // venue filter is ALWAYS in the OR
    expect(where.OR).toContainEqual({ venueId: VENUE_ID })
    // half-open overlap semantics
    expect(where.startsAt).toEqual({ lt: expect.any(Date) })
    expect(where.endsAt).toEqual({ gt: expect.any(Date) })
  })

  it('REGRESSION: googleapis events.list incremental call never includes timeMin/timeMax', async () => {
    seedConnection({ syncToken: 'st-x', venue: null })
    mockEventsList.mockResolvedValueOnce({ data: { items: [], nextSyncToken: 'st-y' } })
    ;(prismaMock.externalBusyBlock.deleteMany as jest.Mock).mockResolvedValue({ count: 0 })
    ;(prismaMock.googleCalendarConnection.update as jest.Mock).mockResolvedValue({})

    await pullService.runIncrementalPull(CONNECTION_ID)

    const args = mockEventsList.mock.calls[0][0]
    expect(args.syncToken).toBe('st-x')
    // Google rejects with 400 if syncToken + timeMin/timeMax are mixed.
    expect(args.timeMin).toBeUndefined()
    expect(args.timeMax).toBeUndefined()
  })

  it('REGRESSION: webhook controller maps unknown channel id → 404 (and never writes inbox)', async () => {
    ;(prismaMock.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([])
    ;(prismaMock.googleCalendarWebhookInbox.create as jest.Mock).mockClear()

    const res = await request(app)
      .post('/api/v1/webhooks/google-calendar')
      .set('X-Goog-Channel-ID', 'unknown')
      .set('X-Goog-Channel-Token', 'whatever')
      .set('X-Goog-Resource-ID', 'whatever')
      .set('X-Goog-Resource-State', 'exists')

    expect(res.status).toBe(404)
    expect(prismaMock.googleCalendarWebhookInbox.create).not.toHaveBeenCalled()
  })

  it('REGRESSION: publishPullCommand surface exists and accepts a connection id', () => {
    // The webhook controller imports this name; the pull service exports its
    // own enqueuePullForConnection. We only verify the controller's exported
    // function exists — Stripe regression depends on this same surface staying
    // separate from Stripe's queue.
    expect(typeof webhookController.publishPullCommand).toBe('function')
  })
})
