/**
 * API tests for Phase 3 dashboard endpoints + the connection-detail endpoint.
 *
 * Covered:
 *   - GET  /api/v1/dashboard/venues/:venueId/google-calendar/busy-blocks
 *   - GET  /api/v1/dashboard/venues/:venueId/google-calendar/outbox/dead-letter
 *   - POST /api/v1/dashboard/venues/:venueId/google-calendar/outbox/:rowId/retry
 *   - GET  /api/v1/google-calendar/connections/:id
 *
 * Auth strategy mirrors `google-calendar.api.test.ts`: the test JWT carries
 * the venue + role, `checkPermission` is mocked to a deterministic pass/fail
 * (since the unit-under-test is the controller behavior, not the permission
 * resolver — that has its own tests).
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

// Stub express-session middleware so test cookies don't matter.
jest.mock('@/config/session', () => ({
  __esModule: true,
  default: (_req: any, _res: any, next: any) => next(),
}))

// Permission middleware — by default grant access. Individual tests can
// override `permissionGate.shouldAllow` to simulate forbidden cases.
const permissionGate = { shouldAllow: true, deniedFor: new Set<string>() }

jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (perm: string) => (req: any, res: any, next: any) => {
    if (!permissionGate.shouldAllow || permissionGate.deniedFor.has(perm)) {
      return res.status(403).json({ error: 'Forbidden', message: `Permission '${perm}' required` })
    }
    return next()
  },
}))

// Access service used by the connection-detail handler in google-calendar.controller.ts.
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

let app: Express
let accessService: { getUserAccess: jest.Mock }

beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  process.env.ACCESS_TOKEN_SECRET = TEST_SECRET

  jest.resetModules()
  const mod = await import('@/app')
  app = mod.default

  accessService = (await import('@/services/access/access.service')) as any
})

beforeEach(() => {
  permissionGate.shouldAllow = true
  permissionGate.deniedFor.clear()
  // Hard-reset getUserAccess so leftover mockResolvedValueOnce queues from
  // prior tests (where the controller short-circuited before calling it —
  // e.g., the "own personal connection" path) don't bleed into the next test.
  accessService.getUserAccess.mockReset()
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

const authedGet = (url: string) =>
  request(app)
    .get(url)
    .set('Cookie', [`accessToken=${makeToken()}`])
const authedPost = (url: string) =>
  request(app)
    .post(url)
    .set('Cookie', [`accessToken=${makeToken()}`])

// ============================================================
// GET /busy-blocks
// ============================================================
describe('GET /api/v1/dashboard/venues/:venueId/google-calendar/busy-blocks', () => {
  const FROM = '2026-05-16T00:00:00.000Z'
  const TO = '2026-05-17T00:00:00.000Z'

  it('returns 401 without auth', async () => {
    const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/busy-blocks?from=${FROM}&to=${TO}`)
    expect(res.status).toBe(401)
  })

  it('returns 400 when from is missing', async () => {
    const res = await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/busy-blocks?to=${TO}`)
    expect(res.status).toBe(400)
  })

  it('returns 400 when to is missing', async () => {
    const res = await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/busy-blocks?from=${FROM}`)
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid ISO date', async () => {
    const res = await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/busy-blocks?from=garbage&to=${TO}`)
    expect(res.status).toBe(400)
  })

  it('returns 400 when to <= from', async () => {
    const res = await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/busy-blocks?from=${TO}&to=${FROM}`)
    expect(res.status).toBe(400)
  })

  it('rejects ranges longer than 90 days with 400', async () => {
    const far = '2026-09-01T00:00:00.000Z' // ~108 days after FROM
    const res = await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/busy-blocks?from=${FROM}&to=${far}`)
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/90 días/)
  })

  it('returns 403 when caller lacks calendar:view_status', async () => {
    permissionGate.deniedFor.add('calendar:view_status')
    const res = await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/busy-blocks?from=${FROM}&to=${TO}`)
    expect(res.status).toBe(403)
  })

  it('queries venue-master blocks by range overlap and returns them', async () => {
    ;(prismaMock.externalBusyBlock.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 'blk-1',
        startsAt: new Date('2026-05-16T15:00:00.000Z'),
        endsAt: new Date('2026-05-16T16:00:00.000Z'),
        allDay: false,
        title: 'Planificación',
        isPrivate: false,
        externalSource: 'GOOGLE',
        connection: { id: 'conn-v', googleAccountEmail: 'venue@example.com', scope: 'VENUE' },
      },
    ])

    const res = await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/busy-blocks?from=${FROM}&to=${TO}`)
    expect(res.status).toBe(200)
    expect(res.body.blocks).toHaveLength(1)
    expect(res.body.blocks[0].id).toBe('blk-1')
    expect(res.body.blocks[0].title).toBe('Planificación')
    expect(res.body.blocks[0].connection.scope).toBe('VENUE')

    const where = (prismaMock.externalBusyBlock.findMany as jest.Mock).mock.calls[0][0].where
    expect(where.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ venueId: VENUE_ID, startsAt: { lt: expect.any(Date) }, endsAt: { gt: expect.any(Date) } }),
      ]),
    )
    // No staffId clause when staffId not provided.
    expect(where.OR).toHaveLength(1)
  })

  it('ORs in staff-personal blocks when staffId is provided', async () => {
    ;(prismaMock.externalBusyBlock.findMany as jest.Mock).mockResolvedValueOnce([])
    await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/busy-blocks?from=${FROM}&to=${TO}&staffId=staff-42`)
    const where = (prismaMock.externalBusyBlock.findMany as jest.Mock).mock.calls[0][0].where
    expect(where.OR).toHaveLength(2)
    expect(where.OR).toEqual(
      expect.arrayContaining([expect.objectContaining({ venueId: VENUE_ID }), expect.objectContaining({ staffId: 'staff-42' })]),
    )
  })

  it('hides title when block is private', async () => {
    ;(prismaMock.externalBusyBlock.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 'blk-priv',
        startsAt: new Date('2026-05-16T15:00:00.000Z'),
        endsAt: new Date('2026-05-16T16:00:00.000Z'),
        allDay: false,
        title: 'Sensitive Title',
        isPrivate: true,
        externalSource: 'GOOGLE',
        connection: { id: 'c', googleAccountEmail: 'e@x.com', scope: 'STAFF_PERSONAL' },
      },
    ])
    const res = await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/busy-blocks?from=${FROM}&to=${TO}`)
    expect(res.status).toBe(200)
    expect(res.body.blocks[0].title).toBeNull()
    expect(res.body.blocks[0].isPrivate).toBe(true)
  })
})

// ============================================================
// GET /outbox/dead-letter
// ============================================================
describe('GET /api/v1/dashboard/venues/:venueId/google-calendar/outbox/dead-letter', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/dead-letter`)
    expect(res.status).toBe(401)
  })

  it('returns 403 when caller lacks calendar:view_status', async () => {
    permissionGate.deniedFor.add('calendar:view_status')
    const res = await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/dead-letter`)
    expect(res.status).toBe(403)
  })

  it('filters by status=DEAD_LETTER and venueId, returns mapped rows', async () => {
    ;(prismaMock.calendarSyncOutbox.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 'row-1',
        operation: 'CREATE',
        createdAt: new Date('2026-05-15T12:00:00.000Z'),
        attempts: 7,
        lastError: 'Google API error: insufficient permissions',
        reservation: {
          id: 'res-1',
          confirmationCode: 'RES-A3X7K2',
          startsAt: new Date('2026-05-20T18:00:00.000Z'),
          guestName: 'Juan Pérez',
          customer: null,
        },
        classSession: null,
        targetConnection: { id: 'conn-1', googleAccountEmail: 'staff@x.com', scope: 'STAFF_PERSONAL' },
      },
    ])

    const res = await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/dead-letter`)

    expect(res.status).toBe(200)
    expect(res.body.rows).toHaveLength(1)
    const row = res.body.rows[0]
    expect(row.id).toBe('row-1')
    expect(row.source.kind).toBe('reservation')
    expect(row.source.confirmationCode).toBe('RES-A3X7K2')
    expect(row.source.displayName).toBe('Juan Pérez')
    expect(row.target.scope).toBe('STAFF_PERSONAL')
    expect(res.body.nextCursor).toBeNull()

    const findArgs = (prismaMock.calendarSyncOutbox.findMany as jest.Mock).mock.calls[0][0]
    expect(findArgs.where).toEqual({ venueId: VENUE_ID, status: 'DEAD_LETTER' })
  })

  it('falls back to customer name when guestName is empty', async () => {
    ;(prismaMock.calendarSyncOutbox.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 'row-2',
        operation: 'UPDATE',
        createdAt: new Date(),
        attempts: 5,
        lastError: 'rate limit',
        reservation: {
          id: 'res-2',
          confirmationCode: 'RES-X',
          startsAt: new Date(),
          guestName: null,
          customer: { firstName: 'Ana', lastName: 'García' },
        },
        classSession: null,
        targetConnection: { id: 'conn-1', googleAccountEmail: 'e@x.com', scope: 'VENUE' },
      },
    ])
    const res = await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/dead-letter`)
    expect(res.status).toBe(200)
    expect(res.body.rows[0].source.displayName).toBe('Ana García')
  })

  it('maps class-session source correctly', async () => {
    ;(prismaMock.calendarSyncOutbox.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 'row-3',
        operation: 'CREATE',
        createdAt: new Date(),
        attempts: 6,
        lastError: 'err',
        reservation: null,
        classSession: {
          id: 'cs-1',
          startsAt: new Date('2026-06-01T10:00:00.000Z'),
          product: { name: 'Yoga matutino' },
        },
        targetConnection: { id: 'c', googleAccountEmail: 'e@x.com', scope: 'VENUE' },
      },
    ])
    const res = await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/dead-letter`)
    expect(res.body.rows[0].source).toEqual(expect.objectContaining({ kind: 'classSession', id: 'cs-1', title: 'Yoga matutino' }))
  })

  it('returns nextCursor + page when result hits limit+1', async () => {
    const fakeRows = Array.from({ length: 3 }, (_, i) => ({
      id: `row-${i}`,
      operation: 'CREATE',
      createdAt: new Date(),
      attempts: 7,
      lastError: 'err',
      reservation: null,
      classSession: null,
      targetConnection: null,
    }))
    ;(prismaMock.calendarSyncOutbox.findMany as jest.Mock).mockResolvedValueOnce(fakeRows)

    const res = await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/dead-letter?limit=2`)
    expect(res.status).toBe(200)
    expect(res.body.rows).toHaveLength(2)
    expect(res.body.nextCursor).toBe('row-1')

    const findArgs = (prismaMock.calendarSyncOutbox.findMany as jest.Mock).mock.calls[0][0]
    expect(findArgs.take).toBe(3) // limit + 1
  })

  it('clamps limit to the max (100)', async () => {
    ;(prismaMock.calendarSyncOutbox.findMany as jest.Mock).mockResolvedValueOnce([])
    await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/dead-letter?limit=999`)
    const findArgs = (prismaMock.calendarSyncOutbox.findMany as jest.Mock).mock.calls[0][0]
    expect(findArgs.take).toBe(101) // 100 + 1
  })

  it('passes cursor + skip when cursor is provided', async () => {
    ;(prismaMock.calendarSyncOutbox.findMany as jest.Mock).mockResolvedValueOnce([])
    await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/dead-letter?cursor=row-99`)
    const findArgs = (prismaMock.calendarSyncOutbox.findMany as jest.Mock).mock.calls[0][0]
    expect(findArgs.cursor).toEqual({ id: 'row-99' })
    expect(findArgs.skip).toBe(1)
  })

  it('returns 400 for invalid limit', async () => {
    const res = await authedGet(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/dead-letter?limit=abc`)
    expect(res.status).toBe(400)
  })
})

// ============================================================
// POST /outbox/:rowId/retry
// ============================================================
describe('POST /api/v1/dashboard/venues/:venueId/google-calendar/outbox/:rowId/retry', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/row-1/retry`)
    expect(res.status).toBe(401)
  })

  it('returns 403 when caller lacks calendar:manage_venue', async () => {
    permissionGate.deniedFor.add('calendar:manage_venue')
    const res = await authedPost(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/row-1/retry`)
    expect(res.status).toBe(403)
  })

  it('returns 404 when the row is unknown', async () => {
    ;(prismaMock.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValueOnce(null)
    const res = await authedPost(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/missing/retry`)
    expect(res.status).toBe(404)
  })

  it('returns 404 when the row belongs to a different venue', async () => {
    ;(prismaMock.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'row-1',
      venueId: 'venue-other',
      status: 'DEAD_LETTER',
    })
    const res = await authedPost(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/row-1/retry`)
    expect(res.status).toBe(404)
  })

  it('returns 409 when the row is NOT in DEAD_LETTER', async () => {
    ;(prismaMock.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'row-1',
      venueId: VENUE_ID,
      status: 'PENDING',
    })
    const res = await authedPost(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/row-1/retry`)
    expect(res.status).toBe(409)
    expect(prismaMock.calendarSyncOutbox.update).not.toHaveBeenCalled()
  })

  it('resets row to PENDING with attempts=0 and returns 200', async () => {
    ;(prismaMock.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'row-1',
      venueId: VENUE_ID,
      status: 'DEAD_LETTER',
    })
    ;(prismaMock.calendarSyncOutbox.update as jest.Mock).mockResolvedValueOnce({
      id: 'row-1',
      status: 'PENDING',
      attempts: 0,
      scheduledAt: new Date(),
      lastError: null,
    })

    const res = await authedPost(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/row-1/retry`)

    expect(res.status).toBe(200)
    expect(res.body.row.status).toBe('PENDING')
    expect(res.body.row.attempts).toBe(0)

    const updateArgs = (prismaMock.calendarSyncOutbox.update as jest.Mock).mock.calls[0][0]
    expect(updateArgs.where).toEqual({ id: 'row-1' })
    expect(updateArgs.data).toEqual(
      expect.objectContaining({
        status: 'PENDING',
        attempts: 0,
        lastError: null,
        scheduledAt: expect.any(Date),
      }),
    )
  })
})

// ============================================================
// GET /connections/:id (detail)
// ============================================================
describe('GET /api/v1/google-calendar/connections/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/v1/google-calendar/connections/conn-1')
    expect(res.status).toBe(401)
  })

  it('returns 404 for unknown id', async () => {
    ;(prismaMock.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValueOnce(null)
    const res = await authedGet('/api/v1/google-calendar/connections/missing')
    expect(res.status).toBe(404)
  })

  it('allows the owner of a personal connection to view it (own personal — no view_status required)', async () => {
    accessService.getUserAccess.mockResolvedValueOnce({
      ...mockUserAccessFixture,
      corePermissions: [], // No view_status — but still own personal.
    })
    ;(prismaMock.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'conn-personal',
      scope: 'STAFF_PERSONAL',
      venueId: null,
      staffId: USER_ID,
      googleAccountEmail: 'me@example.com',
      selectedCalendarId: 'cal-1',
      selectedCalendarSummary: 'Mi calendario',
      selectedCalendarTimeZone: 'America/Mexico_City',
      status: 'CONNECTED',
      statusReason: null,
      lastSyncedAt: new Date(),
      lastHorizonEnd: new Date(),
      connectedAt: new Date(),
      disconnectedAt: null,
    })
    ;(prismaMock.calendarSyncOutbox.count as jest.Mock).mockResolvedValueOnce(2).mockResolvedValueOnce(0)
    ;(prismaMock.googleCalendarChannel.findFirst as jest.Mock).mockResolvedValueOnce({
      expiresAt: new Date(),
      status: 'ACTIVE',
    })

    const res = await authedGet('/api/v1/google-calendar/connections/conn-personal')

    expect(res.status).toBe(200)
    expect(res.body.connection.id).toBe('conn-personal')
    expect(res.body.connection.pendingCount).toBe(2)
    expect(res.body.connection.deadLetterCount).toBe(0)
    expect(res.body.connection.channel.status).toBe('ACTIVE')
    // Should NOT expose ciphertext / syncToken — they're not selected.
    expect(res.body.connection.refreshTokenCiphertext).toBeUndefined()
    expect(res.body.connection.syncToken).toBeUndefined()
  })

  it('returns 403 when caller is not the owner and lacks calendar:view_status', async () => {
    accessService.getUserAccess.mockResolvedValueOnce({
      ...mockUserAccessFixture,
      corePermissions: [], // No view_status
    })
    ;(prismaMock.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'conn-other',
      scope: 'STAFF_PERSONAL',
      venueId: null,
      staffId: 'someone-else',
      googleAccountEmail: 'them@example.com',
      selectedCalendarId: 'cal-x',
      selectedCalendarSummary: 'Theirs',
      selectedCalendarTimeZone: 'America/Mexico_City',
      status: 'CONNECTED',
      statusReason: null,
      lastSyncedAt: null,
      lastHorizonEnd: null,
      connectedAt: new Date(),
      disconnectedAt: null,
    })
    const res = await authedGet('/api/v1/google-calendar/connections/conn-other')
    expect(res.status).toBe(403)
  })

  it('allows a venue admin (calendar:view_status) to view another staff personal connection', async () => {
    ;(prismaMock.googleCalendarConnection.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'conn-other',
      scope: 'STAFF_PERSONAL',
      venueId: null,
      staffId: 'someone-else',
      googleAccountEmail: 'them@example.com',
      selectedCalendarId: 'cal-x',
      selectedCalendarSummary: 'Theirs',
      selectedCalendarTimeZone: 'America/Mexico_City',
      status: 'CONNECTED',
      statusReason: null,
      lastSyncedAt: null,
      lastHorizonEnd: null,
      connectedAt: new Date(),
      disconnectedAt: null,
    })
    ;(prismaMock.calendarSyncOutbox.count as jest.Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(0)
    ;(prismaMock.googleCalendarChannel.findFirst as jest.Mock).mockResolvedValueOnce(null)

    const res = await authedGet('/api/v1/google-calendar/connections/conn-other')
    expect(res.status).toBe(200)
    expect(res.body.connection.channel).toBeNull()
  })
})

// ============================================================
// REGRESSION TESTS
// ============================================================
describe('REGRESSION — Phase 3 endpoints', () => {
  it('REGRESSION: all 4 endpoints require authentication', async () => {
    const FROM = '2026-05-16T00:00:00.000Z'
    const TO = '2026-05-17T00:00:00.000Z'

    let res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/busy-blocks?from=${FROM}&to=${TO}`)
    expect(res.status).toBe(401)

    res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/dead-letter`)
    expect(res.status).toBe(401)

    res = await request(app).post(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/row-1/retry`)
    expect(res.status).toBe(401)

    res = await request(app).get('/api/v1/google-calendar/connections/conn-1')
    expect(res.status).toBe(401)
  })

  it('REGRESSION: retry endpoint NEVER mutates a non-DEAD_LETTER row', async () => {
    for (const status of ['PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'SKIPPED']) {
      ;(prismaMock.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'row-1',
        venueId: VENUE_ID,
        status,
      })
      ;(prismaMock.calendarSyncOutbox.update as jest.Mock).mockClear()
      const res = await authedPost(`/api/v1/dashboard/venues/${VENUE_ID}/google-calendar/outbox/row-1/retry`)
      expect(res.status).toBe(409)
      expect(prismaMock.calendarSyncOutbox.update).not.toHaveBeenCalled()
    }
  })

  it('REGRESSION: busy-blocks always scopes venue-master clause to route :venueId (no cross-tenant leak)', async () => {
    const FROM = '2026-05-16T00:00:00.000Z'
    const TO = '2026-05-17T00:00:00.000Z'
    ;(prismaMock.externalBusyBlock.findMany as jest.Mock).mockResolvedValueOnce([])
    await authedGet(`/api/v1/dashboard/venues/venue-CORRECT/google-calendar/busy-blocks?from=${FROM}&to=${TO}`)
    const where = (prismaMock.externalBusyBlock.findMany as jest.Mock).mock.calls[0][0].where
    const venueClause = where.OR.find((c: any) => c.venueId)
    expect(venueClause.venueId).toBe('venue-CORRECT')
  })
})
