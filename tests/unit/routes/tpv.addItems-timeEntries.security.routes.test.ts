/**
 * PATCH /tpv/venues/:venueId/orders/:orderId/items and POST
 * /tpv/venues/:venueId/time-entries/clock-in|clock-out — open findings #2, #3.
 *
 * Before this fix these routes carried ONLY authenticateTokenMiddleware:
 *   - #3 IDOR: nothing checked that the `:venueId` in the URL matched the token's
 *     venue, so a token from venue A could act on venue B.
 *   - #2 table ownership: with VenueSettings.enforceTableOwnership ON, a terminal
 *     that did not own the table's order could still add rounds to it as long as
 *     it had internet — the offline sync reducer (`assertOwnership` in
 *     sync.mobile.service.ts) already enforced this rule, so online and offline
 *     disagreed (backwards: the rule applied WITHOUT network but not WITH it).
 *
 * Same technique as tpv.table-order.routes.featureGate.test.ts: mounts the REAL
 * tpv.routes.ts router with the REAL validateVenueAccess and REAL
 * checkTableOwnership middlewares — only auth (header-injected authContext),
 * prisma, validateRequest, and the controllers are mocked. This proves the WIRING
 * actually gates requests, not just that the exported symbols exist somewhere in
 * the chain.
 */

import express from 'express'
import request from 'supertest'

// 1. Auth: inject authContext from a test header (tpv.routes.ts references
//    authenticateTokenMiddleware inline per-route, no parent router.use).
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) req.authContext = JSON.parse(ctx as string)
    next()
  },
}))

// 2. validateRequest: bypass Zod body-shape validation — out of scope here,
//    covered by src/schemas/tpv.schema.ts's own tests.
jest.mock('@/middlewares/validation', () => ({
  validateRequest: () => (_req: any, _res: any, next: any) => next(),
}))

// 3. prisma: only the models validateVenueAccess (none — pure) / checkTableOwnership
//    actually touch (isTableOwnershipEnforced, order ownership lookup,
//    staffCanManageAllTables' SUPERADMIN bypass + custom-permission override).
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueSettings: { findUnique: jest.fn() },
    order: { findFirst: jest.fn() },
    staffVenue: { findFirst: jest.fn(), findUnique: jest.fn() },
    venueRolePermission: { findUnique: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

// 4. Controllers under these routes: not under test — any request that reaches
//    them succeeds with a marker body, so we can tell "gated" from "reached".
jest.mock('@/controllers/tpv/order.tpv.controller', () => ({
  ...jest.requireActual('@/controllers/tpv/order.tpv.controller'),
  addItemsToOrder: (_req: any, res: any) => res.status(200).json({ handler: 'addItemsToOrder' }),
}))
jest.mock('@/controllers/tpv/time-entry.tpv.controller', () => ({
  ...jest.requireActual('@/controllers/tpv/time-entry.tpv.controller'),
  clockIn: (_req: any, res: any) => res.status(200).json({ handler: 'clockIn' }),
  clockOut: (_req: any, res: any) => res.status(200).json({ handler: 'clockOut' }),
}))

// ─── Import router AFTER the mocks ─────────────────────────────────────────────
import prisma from '@/utils/prismaClient'
import tpvRouter from '@/routes/tpv.routes'

const venueSettingsFindUnique = (prisma as any).venueSettings.findUnique as jest.Mock
const orderFindFirst = (prisma as any).order.findFirst as jest.Mock
const staffVenueFindFirst = (prisma as any).staffVenue.findFirst as jest.Mock
const venueRolePermissionFindUnique = (prisma as any).venueRolePermission.findUnique as jest.Mock

const VENUE_A = 'venue-A'
const VENUE_B = 'venue-B'
const ORDER_ID = 'order-1'
const WAITER = 'staff-waiter'
const TABLE_OWNER = 'staff-table-owner'

function authHeader(ctx: object): Record<string, string> {
  return { 'x-test-auth-context': JSON.stringify(ctx) }
}

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/tpv', tpvRouter)
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.statusCode || 500).json({ error: err?.message || 'error' }))
  return app
}

const waiterAtVenueA = { userId: WAITER, orgId: 'org-1', venueId: VENUE_A, role: 'WAITER' }

beforeEach(() => {
  jest.clearAllMocks()
  staffVenueFindFirst.mockResolvedValue(null) // not a platform SUPERADMIN
  venueRolePermissionFindUnique.mockResolvedValue(null) // no custom override → role defaults apply
})

describe('PATCH /venues/:venueId/orders/:orderId/items — venue IDOR (open finding #3)', () => {
  it('venue-A token on a venue-B URL → 403 from validateVenueAccess, table-ownership DB never even queried', async () => {
    const res = await request(createApp())
      .patch(`/tpv/venues/${VENUE_B}/orders/${ORDER_ID}/items`)
      .set(authHeader(waiterAtVenueA))
      .send({ items: [] })

    expect(res.status).toBe(403)
    expect(res.body.message).toBe('No tienes acceso a este venue')
    expect(venueSettingsFindUnique).not.toHaveBeenCalled()
    expect(orderFindFirst).not.toHaveBeenCalled()
  })

  it('same-venue token → passes validateVenueAccess and reaches the controller', async () => {
    venueSettingsFindUnique.mockResolvedValue({ enforceTableOwnership: false })

    const res = await request(createApp())
      .patch(`/tpv/venues/${VENUE_A}/orders/${ORDER_ID}/items`)
      .set(authHeader(waiterAtVenueA))
      .send({ items: [] })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: 'addItemsToOrder' })
  })
})

describe('PATCH /venues/:venueId/orders/:orderId/items — table ownership (open finding #2)', () => {
  it('enforceTableOwnership OFF (default) → a non-owner still reaches the controller (no behavior change for FREE/no-switch venues)', async () => {
    venueSettingsFindUnique.mockResolvedValue({ enforceTableOwnership: false })
    orderFindFirst.mockResolvedValue({ tableId: 'table-1', servedById: TABLE_OWNER, servedBy: { firstName: 'Ana', lastName: 'Owner' } })

    const res = await request(createApp())
      .patch(`/tpv/venues/${VENUE_A}/orders/${ORDER_ID}/items`)
      .set(authHeader(waiterAtVenueA))
      .send({ items: [] })

    expect(res.status).toBe(200)
    // Switch is off → checkTableOwnership no-ops WITHOUT even reading the order.
    expect(orderFindFirst).not.toHaveBeenCalled()
  })

  it('enforceTableOwnership ON + order owned by ANOTHER waiter → 403 TABLE_OWNED_BY_OTHER, controller never reached', async () => {
    venueSettingsFindUnique.mockResolvedValue({ enforceTableOwnership: true })
    orderFindFirst.mockResolvedValue({ tableId: 'table-1', servedById: TABLE_OWNER, servedBy: { firstName: 'Ana', lastName: 'Owner' } })

    const res = await request(createApp())
      .patch(`/tpv/venues/${VENUE_A}/orders/${ORDER_ID}/items`)
      .set(authHeader(waiterAtVenueA))
      .send({ items: [] })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('TABLE_OWNED_BY_OTHER')
  })

  it('enforceTableOwnership ON + order owned by the SAME waiter → reaches the controller', async () => {
    venueSettingsFindUnique.mockResolvedValue({ enforceTableOwnership: true })
    orderFindFirst.mockResolvedValue({ tableId: 'table-1', servedById: WAITER, servedBy: { firstName: 'W', lastName: 'Aiter' } })

    const res = await request(createApp())
      .patch(`/tpv/venues/${VENUE_A}/orders/${ORDER_ID}/items`)
      .set(authHeader(waiterAtVenueA))
      .send({ items: [] })

    expect(res.status).toBe(200)
  })

  it('enforceTableOwnership ON + mostrador sale (no tableId) → rule does not apply, reaches the controller', async () => {
    venueSettingsFindUnique.mockResolvedValue({ enforceTableOwnership: true })
    orderFindFirst.mockResolvedValue({ tableId: null, servedById: TABLE_OWNER, servedBy: null })

    const res = await request(createApp())
      .patch(`/tpv/venues/${VENUE_A}/orders/${ORDER_ID}/items`)
      .set(authHeader(waiterAtVenueA))
      .send({ items: [] })

    expect(res.status).toBe(200)
  })
})

describe.each([
  ['clock-in', 'clockIn'],
  ['clock-out', 'clockOut'],
])('POST /venues/:venueId/time-entries/%s — venue IDOR (open finding #3)', (path, handlerName) => {
  it('venue-A token on a venue-B URL → 403 from validateVenueAccess', async () => {
    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_B}/time-entries/${path}`)
      .set(authHeader(waiterAtVenueA))
      .send({ staffId: WAITER, pin: '1234' })

    expect(res.status).toBe(403)
    expect(res.body.message).toBe('No tienes acceso a este venue')
  })

  it('same-venue token → reaches the controller', async () => {
    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_A}/time-entries/${path}`)
      .set(authHeader(waiterAtVenueA))
      .send({ staffId: WAITER, pin: '1234' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: handlerName })
  })
})
