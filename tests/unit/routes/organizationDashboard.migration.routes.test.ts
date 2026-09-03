/**
 * Route-level test for the org-namespace terminal-migration endpoints (Task 6):
 *   POST /dashboard/organizations/:orgId/terminals/:terminalId/migrate-preflight
 *   POST /dashboard/organizations/:orgId/terminals/:terminalId/migrate-execute
 *
 * Mirrors the pattern used in tests/unit/routes/simCustody.admin.routes.test.ts and
 * tests/unit/routes/terminalLocation.routes.test.ts: bare express app + supertest,
 * authContext injected via a test header, auth/authz + the service mocked, but the
 * REAL router + REAL Zod schemas (orgMigratePreflightSchema/orgMigrateExecuteSchema)
 * exercised end to end.
 *
 * Why this file exists: neither the schema-level test
 * (orgTerminals.migration.schema.test.ts — proves Zod doesn't strip migrateMerchant)
 * nor the wrapper-level test (orgTerminals.migration.test.ts — calls
 * migratePreflightForOrg/migrateExecuteForOrg directly, bypassing Express) exercises
 * the actual destructuring/forwarding line in organizationDashboard.routes.ts
 * (`const { toVenueId, migrateMerchant } = req.body` → forwarded to the `*ForOrg`
 * call). This file drives a REAL HTTP request through the REAL route so a future
 * refactor that drops migrateMerchant from that destructuring — or forgets to
 * forward it — fails a test here.
 */

import express from 'express'
import request from 'supertest'

// 1. Auth: inject authContext from a custom test header (SUPERADMIN bypasses both
//    checkOrgAccess and requireOrgOwner with zero DB calls — see organizationDashboard.routes.ts)
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) req.authContext = JSON.parse(ctx as string)
    next()
  },
}))

// 2. Service: mock ONLY the two functions this test exercises. Other exports of this
//    module are untouched by these two routes at request time (only referenced inside
//    other handlers, never invoked unless that route is hit).
const mockMigratePreflightForOrg = jest.fn()
const mockMigrateExecuteForOrg = jest.fn()
const mockMigrateDiscardForOrg = jest.fn()
jest.mock('@/services/organization-dashboard/orgTerminals.service', () => ({
  __esModule: true,
  migratePreflightForOrg: (...args: unknown[]) => mockMigratePreflightForOrg(...args),
  migrateExecuteForOrg: (...args: unknown[]) => mockMigrateExecuteForOrg(...args),
  migrateDiscardForOrg: (...args: unknown[]) => mockMigrateDiscardForOrg(...args),
}))

// ─── Import router AFTER mocks (real router, real Zod schemas, real validateRequest) ──
import organizationDashboardRoutes from '@/routes/dashboard/organizationDashboard.routes'

function makeApp() {
  const app = express()
  app.use(express.json())
  // Mirror the real mount point: dashboard.routes.ts does router.use('/organizations', ...)
  // under the /dashboard prefix.
  app.use('/dashboard/organizations', organizationDashboardRoutes)
  // Minimal error handler so BadRequestError (Zod validation failures) surfaces its
  // real statusCode instead of Express's generic 500 fallback.
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ success: false, message: err.message })
  })
  return app
}

const ORG_ID = 'org-1'
const TERMINAL_ID = 'term-1'
const TO_VENUE_ID = 'venue-new'

// SUPERADMIN bypasses checkOrgAccess AND requireOrgOwner without touching prisma —
// see organizationDashboard.routes.ts:49 and :86. Keeps this route test focused on
// the migrateMerchant wiring, not the ownership-gate logic (already covered by
// orgTerminals.migration.test.ts's `requireOrgOwner middleware` describe block).
const superadminCtx = { userId: 'staff-1', orgId: ORG_ID, venueId: 'venue-x', role: 'SUPERADMIN' }

function authHeader(ctx: object): Record<string, string> {
  return { 'x-test-auth-context': JSON.stringify(ctx) }
}

describe('POST /dashboard/organizations/:orgId/terminals/:terminalId/migrate-preflight', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMigratePreflightForOrg.mockResolvedValue({ canProceed: true })
  })

  it('forwards migrateMerchant:true from the real HTTP body to migratePreflightForOrg', async () => {
    const res = await request(makeApp())
      .post(`/dashboard/organizations/${ORG_ID}/terminals/${TERMINAL_ID}/migrate-preflight`)
      .set(authHeader(superadminCtx))
      .send({ toVenueId: TO_VENUE_ID, migrateMerchant: true })

    expect(res.status).toBe(200)
    expect(mockMigratePreflightForOrg).toHaveBeenCalledWith(ORG_ID, TERMINAL_ID, TO_VENUE_ID, true)
  })

  it('REGRESIÓN: migrateMerchant ausente en el body llega como undefined al service', async () => {
    const res = await request(makeApp())
      .post(`/dashboard/organizations/${ORG_ID}/terminals/${TERMINAL_ID}/migrate-preflight`)
      .set(authHeader(superadminCtx))
      .send({ toVenueId: TO_VENUE_ID })

    expect(res.status).toBe(200)
    expect(mockMigratePreflightForOrg).toHaveBeenCalledWith(ORG_ID, TERMINAL_ID, TO_VENUE_ID, undefined)
  })

  it('rechaza migrateMerchant no-booleano con 400 ANTES de llegar al service (Zod real, no mockeado)', async () => {
    const res = await request(makeApp())
      .post(`/dashboard/organizations/${ORG_ID}/terminals/${TERMINAL_ID}/migrate-preflight`)
      .set(authHeader(superadminCtx))
      .send({ toVenueId: TO_VENUE_ID, migrateMerchant: 'sí' })

    expect(res.status).toBe(400)
    expect(mockMigratePreflightForOrg).not.toHaveBeenCalled()
  })
})

// Asana 1218069201250971 (2026-09-01): the org OWNER's way out of a MIGRATION_IN_PROGRESS
// the device will never execute. Params-only route, same guards as migrate-cancel.
describe('POST /dashboard/organizations/:orgId/terminals/:terminalId/migrate-discard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMigrateDiscardForOrg.mockResolvedValue({ discarded: 1, commandIds: ['cmd-1'] })
  })

  it('reaches migrateDiscardForOrg with the org, the terminal and the acting staff', async () => {
    const res = await request(makeApp())
      .post(`/dashboard/organizations/${ORG_ID}/terminals/${TERMINAL_ID}/migrate-discard`)
      .set(authHeader(superadminCtx))
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ discarded: 1, commandIds: ['cmd-1'] })
    expect(mockMigrateDiscardForOrg).toHaveBeenCalledWith(ORG_ID, TERMINAL_ID, expect.objectContaining({ staffId: 'staff-1' }))
  })

  // P3 #3 de Codex: los casos de arriba entran como SUPERADMIN, que se salta
  // `requireOrgOwner` — sus assertions seguirían pasando si alguien quitara ese guard de la
  // ruta. Esta prueba mira la cadena de middlewares REAL del router y la compara con la de
  // `migrate-cancel`, que es la ruta hermana ya revisada.
  it('monta EXACTAMENTE los mismos guards que migrate-cancel (si alguien quita requireOrgOwner, falla aquí)', () => {
    const stack = (organizationDashboardRoutes as any).stack as any[]
    const nombres = (sufijo: string) =>
      stack
        .filter(l => l.route?.path?.endsWith(sufijo))
        .flatMap(l => l.route.stack.map((h: any) => h.name))
        .filter((n: string) => n && n !== '<anonymous>')

    const discard = nombres('/migrate-discard')
    expect(discard).toContain('requireOrgOwner')
    expect(discard).toEqual(nombres('/migrate-cancel'))
  })

  it('surfaces the service refusal (e.g. younger than 24 h) as a 400 with its message', async () => {
    const { BadRequestError } = jest.requireActual('@/errors/AppError')
    mockMigrateDiscardForOrg.mockRejectedValue(new BadRequestError('El borrado se envió hace menos de 24 horas.'))

    const res = await request(makeApp())
      .post(`/dashboard/organizations/${ORG_ID}/terminals/${TERMINAL_ID}/migrate-discard`)
      .set(authHeader(superadminCtx))
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.message).toContain('24 horas')
  })
})

describe('POST /dashboard/organizations/:orgId/terminals/:terminalId/migrate-execute', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMigrateExecuteForOrg.mockResolvedValue({ commandId: 'cmd-1' })
  })

  it('forwards migrateMerchant:true (plus assignedMerchantIds) from the real HTTP body to migrateExecuteForOrg', async () => {
    const res = await request(makeApp())
      .post(`/dashboard/organizations/${ORG_ID}/terminals/${TERMINAL_ID}/migrate-execute`)
      .set(authHeader(superadminCtx))
      .send({ toVenueId: TO_VENUE_ID, assignedMerchantIds: ['merch-1'], migrateMerchant: true })

    expect(res.status).toBe(200)
    expect(mockMigrateExecuteForOrg).toHaveBeenCalledWith(
      ORG_ID,
      TERMINAL_ID,
      TO_VENUE_ID,
      expect.objectContaining({ staffId: 'staff-1' }),
      ['merch-1'],
      true,
    )
  })

  it('REGRESIÓN: migrateMerchant ausente en el body llega como undefined al service', async () => {
    const res = await request(makeApp())
      .post(`/dashboard/organizations/${ORG_ID}/terminals/${TERMINAL_ID}/migrate-execute`)
      .set(authHeader(superadminCtx))
      .send({ toVenueId: TO_VENUE_ID })

    expect(res.status).toBe(200)
    expect(mockMigrateExecuteForOrg).toHaveBeenCalledWith(
      ORG_ID,
      TERMINAL_ID,
      TO_VENUE_ID,
      expect.objectContaining({ staffId: 'staff-1' }),
      undefined,
      undefined,
    )
  })

  it('rechaza migrateMerchant no-booleano con 400 ANTES de llegar al service (Zod real, no mockeado)', async () => {
    const res = await request(makeApp())
      .post(`/dashboard/organizations/${ORG_ID}/terminals/${TERMINAL_ID}/migrate-execute`)
      .set(authHeader(superadminCtx))
      .send({ toVenueId: TO_VENUE_ID, migrateMerchant: 'sí' })

    expect(res.status).toBe(400)
    expect(mockMigrateExecuteForOrg).not.toHaveBeenCalled()
  })
})
