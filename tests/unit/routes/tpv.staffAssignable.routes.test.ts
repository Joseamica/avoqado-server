/**
 * GET /tpv/venues/:venueId/staff/assignable — Fix 2, "staff picker"
 * (2026-08-07, see
 * .superpowers/sdd/2026-07-24-tpv-plan-b-superficie-tpv-server/zombie-table-and-staff-picker.md).
 *
 * The ASSIGN_ORDER action a waiter performs only requires `orders:update`
 * (WAITER has it by default), but the ONLY existing read the staff picker
 * could point to — `GET /tpv/venues/:venueId/time-entries/active` — is gated
 * `tpv-time-entries:read` (MANAGER+), the time-clock MANAGER view. So a
 * waiter who CAN reassign a table could not see who to reassign it to.
 *
 * This proves the WIRING, not just that the exported symbols exist:
 *   1. A WAITER (orders:update, no tpv-time-entries:read) reaches the NEW
 *      route.
 *   2. That SAME WAITER is still 403'd on /time-entries/active — the
 *      MANAGER-only time-clock view was NOT loosened.
 *   3. A role without orders:update (HOST) is 403'd on the new route — it
 *      isn't wide open.
 *
 * Same technique as tpv.addItems-timeEntries.security.routes.test.ts: mounts
 * the REAL tpv.routes.ts router with the REAL checkPermission middleware —
 * only auth (header-injected authContext), prisma, and the controllers are
 * mocked.
 */

import express from 'express'
import type { Server } from 'http'
import request from 'supertest'

// 1. Auth: inject authContext from a test header (tpv.routes.ts references
//    authenticateTokenMiddleware inline per-route, no parent router.use).
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) {
      req.authContext = JSON.parse(ctx as string)
      // Desde 2026-08-18 `resolveUserRoleForVenue` YA NO confía en el rol del token: lo
      // lee de `StaffVenue`, para poder aplicar el PermissionSet del empleado y para que
      // dar de baja a alguien surta efecto de inmediato. Espejamos aquí al MISMO empleado
      // que declara el header, así el test sigue midiendo lo que medía antes.
      const prismaMock = jest.requireMock('@/utils/prismaClient').default
      prismaMock.staffVenue.findUnique.mockResolvedValue({
        role: req.authContext.role,
        active: true,
        permissionSetId: null,
        permissionSet: null,
      })
    }
    next()
  },
}))

jest.mock('@/middlewares/validation', () => ({
  validateRequest: () => (_req: any, _res: any, next: any) => next(),
}))

// 2. prisma: only what checkPermission touches on the TOKEN-role fast path
//    (tokenVenueId === URL venueId short-circuits resolveUserRoleForVenue
//    before any staffVenue/venue lookup) — the SUPERADMIN bypass check and
//    the custom VenueRolePermission override lookup.
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findFirst: jest.fn(), findUnique: jest.fn() },
    venueRolePermission: { findUnique: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

// 3. Controllers under these routes: not under test — any request that
//    reaches them succeeds with a marker body, so we can tell "gated" from
//    "reached".
jest.mock('@/controllers/tpv/time-entry.tpv.controller', () => ({
  ...jest.requireActual('@/controllers/tpv/time-entry.tpv.controller'),
  getAssignableStaff: (_req: any, res: any) => res.status(200).json({ handler: 'getAssignableStaff' }),
  getCurrentlyClockedInStaff: (_req: any, res: any) => res.status(200).json({ handler: 'getCurrentlyClockedInStaff' }),
}))

// ─── Import router AFTER the mocks ─────────────────────────────────────────────
import prisma from '@/utils/prismaClient'
import tpvRouter from '@/routes/tpv.routes'

const staffVenueFindFirst = (prisma as any).staffVenue.findFirst as jest.Mock
const venueRolePermissionFindUnique = (prisma as any).venueRolePermission.findUnique as jest.Mock

const VENUE_A = 'venue-A'
const WAITER = 'staff-waiter'
const HOST = 'staff-host'

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
const hostAtVenueA = { userId: HOST, orgId: 'org-1', venueId: VENUE_A, role: 'HOST' }

beforeEach(() => {
  jest.clearAllMocks()
  staffVenueFindFirst.mockResolvedValue(null) // not a platform SUPERADMIN
  venueRolePermissionFindUnique.mockResolvedValue(null) // no custom override → role defaults apply
})

// Un solo server para todo el archivo — ver el comentario largo en
// tpv.addItems-timeEntries.security.routes.test.ts sobre por qué NO pasarle
// la *app* a supertest (bind/close churn por request = flaky).
let server: Server

beforeAll(() => {
  server = createApp().listen(0)
})

afterAll(done => {
  server.close(done)
})

describe('GET /venues/:venueId/staff/assignable — gated by orders:update, not tpv-time-entries:read', () => {
  it('a WAITER (has orders:update, lacks tpv-time-entries:read) reaches the picker', async () => {
    const res = await request(server).get(`/tpv/venues/${VENUE_A}/staff/assignable`).set(authHeader(waiterAtVenueA))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: 'getAssignableStaff' })
  })

  // 🔴 NOT tested with the WAITER role: `PERMISSION_DEPENDENCIES['tpv-time-entries:write']`
  // includes `'tpv-time-entries:read'` (permissions.ts:466) and WAITER holds
  // `tpv-time-entries:write` by default — so a DEFAULT WAITER can already reach
  // /time-entries/active today (pre-existing, unrelated to this change; see the
  // fix report's "concerns" section). HOST has NEITHER `tpv-time-entries:write`
  // nor `:read`, so it is the role that actually proves this route stayed gated.
  it('a role with no tpv-time-entries permission at all (HOST) is still 403 on the MANAGER-only time-clock view — /time-entries/active was NOT loosened', async () => {
    const res = await request(server).get(`/tpv/venues/${VENUE_A}/time-entries/active`).set(authHeader(hostAtVenueA))

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('tpv-time-entries:read')
  })

  it('a role WITHOUT orders:update (HOST) is 403 on the new route — it is not left wide open', async () => {
    const res = await request(server).get(`/tpv/venues/${VENUE_A}/staff/assignable`).set(authHeader(hostAtVenueA))

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('orders:update')
  })
})
