/**
 * Route-level tests for the admin bulk SIM-custody endpoints (Task 6):
 *   POST /organizations/:orgId/sim-custody/reassign-promoter
 *   POST /organizations/:orgId/sim-custody/reassign-supervisor
 *   POST /organizations/:orgId/sim-custody/change-category
 *
 * Covers:
 *   (a) 403 without the required permission
 *   (b) 400 on invalid body (Zod schema)
 *   (c) 200 on valid input — service called with correct args, BulkResult returned
 *   (d) 403 + moduleRequired when SERIALIZED_INVENTORY module is off
 *
 * Uses supertest + a mini Express app mounting the sim-custody router.
 * All middleware and the custody service are mocked.
 */

import express from 'express'
import request from 'supertest'

// ─── Mocks declared BEFORE router import ──────────────────────────────────────

// 1. Auth: inject authContext from a custom test header
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) req.authContext = JSON.parse(ctx as string)
    next()
  },
}))

// 2. checkPermission: the mock reads 'x-test-allow-permission' header.
//    If it equals the required permission string → next(); else → 403.
const mockCheckPermission = jest.fn()
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (perm: string) => (req: any, res: any, next: any) => {
    mockCheckPermission(perm)
    const allowed = req.headers['x-test-allow-permission']
    if (allowed === perm || allowed === '*') return next()
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Sin permiso' })
  },
}))

// 3. Module gate: controlled via 'x-test-module-enabled' header
const mockIsModuleEnabled = jest.fn()
jest.mock('@/services/modules/module.service', () => ({
  moduleService: {
    isModuleEnabled: (...args: unknown[]) => mockIsModuleEnabled(...args),
  },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

// 4. Idempotency middleware: always passthrough in unit tests
jest.mock('@/middlewares/simCustodyIdempotency.middleware', () => ({
  simCustodyIdempotency: () => (_req: any, _res: any, next: any) => next(),
}))

// 5. Rate limiter: passthrough
jest.mock('express-rate-limit', () => () => (_req: any, _res: any, next: any) => next())

// 6. Custody service
const mockReassignPromoter = jest.fn()
const mockReassignSupervisor = jest.fn()
const mockChangeCategory = jest.fn()
jest.mock('@/services/serialized-inventory/custody.service', () => ({
  simCustodyService: {
    reassignPromoter: (...args: unknown[]) => mockReassignPromoter(...args),
    reassignSupervisor: (...args: unknown[]) => mockReassignSupervisor(...args),
    changeCategory: (...args: unknown[]) => mockChangeCategory(...args),
  },
}))

// 7. Silence any sim-custody notifications
jest.mock('@/services/serialized-inventory/custody.notifications', () => ({
  notifySimCustody: jest.fn(),
}))

// ─── Import router AFTER mocks ─────────────────────────────────────────────────
import simCustodyRouter from '@/routes/dashboard/simCustody.dashboard.routes'

// ─── App factory ──────────────────────────────────────────────────────────────

function createApp() {
  const app = express()
  app.use(express.json())
  // Mirror the mount point used in dashboard.routes.ts
  app.use('/dashboard/organizations/:orgId', simCustodyRouter)
  return app
}

// ─── Test constants ────────────────────────────────────────────────────────────

const ORG_ID = 'org-test-123'
const VENUE_ID = 'venue-test-456'
const USER_ID = 'user-test-001'
const PROMOTER_A = 'staff-promoter-A'
const PROMOTER_B = 'staff-promoter-B'
const SUPERVISOR_B = 'staff-supervisor-B'
const CATEGORY_ID = 'cat-test-789'

const ownerCtx = { userId: USER_ID, orgId: ORG_ID, venueId: VENUE_ID, role: 'OWNER' }

function authHeader(ctx: object): Record<string, string> {
  return { 'x-test-auth-context': JSON.stringify(ctx) }
}

const BULK_RESULT = {
  summary: { total: 2, succeeded: 2, failed: 0 },
  results: [
    { serialNumber: 'SIM-001', status: 'ok', event: 'REASSIGN_PROMOTER' },
    { serialNumber: 'SIM-002', status: 'ok', event: 'REASSIGN_PROMOTER' },
  ],
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /sim-custody/reassign-promoter', () => {
  let app: express.Express

  beforeEach(() => {
    jest.clearAllMocks()
    app = createApp()
    // Default: module enabled
    mockIsModuleEnabled.mockResolvedValue(true)
    mockReassignPromoter.mockResolvedValue(BULK_RESULT)
  })

  // (a) Permission gate
  describe('(a) Permission checks', () => {
    it('returns 403 when caller lacks sim-custody:reassign', async () => {
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-promoter`)
        .set(authHeader(ownerCtx))
        // no x-test-allow-permission header → forbidden
        .send({ toPromoterStaffId: PROMOTER_B, serialNumbers: ['SIM-001'] })

      expect(res.status).toBe(403)
      expect(mockReassignPromoter).not.toHaveBeenCalled()
    })

    it('calls checkPermission with "sim-custody:reassign"', async () => {
      await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-promoter`)
        .set({ ...authHeader(ownerCtx), 'x-test-allow-permission': 'sim-custody:reassign' })
        .send({ toPromoterStaffId: PROMOTER_B, serialNumbers: ['SIM-001'] })

      expect(mockCheckPermission).toHaveBeenCalledWith('sim-custody:reassign')
    })
  })

  // (b) Body validation
  describe('(b) Body validation (Zod)', () => {
    const allowHeaders = { ...authHeader(ownerCtx), 'x-test-allow-permission': 'sim-custody:reassign' }

    it('returns 400 when toPromoterStaffId is missing', async () => {
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-promoter`)
        .set(allowHeaders)
        .send({ serialNumbers: ['SIM-001'] })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('VALIDATION_ERROR')
      expect(mockReassignPromoter).not.toHaveBeenCalled()
    })

    it('returns 400 when serialNumbers is empty', async () => {
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-promoter`)
        .set(allowHeaders)
        .send({ toPromoterStaffId: PROMOTER_B, serialNumbers: [] })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('VALIDATION_ERROR')
    })

    it('returns 400 when serialNumbers exceeds 500', async () => {
      const tooMany = Array.from({ length: 501 }, (_, i) => `SIM-${i}`)
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-promoter`)
        .set(allowHeaders)
        .send({ toPromoterStaffId: PROMOTER_B, serialNumbers: tooMany })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('VALIDATION_ERROR')
    })
  })

  // (c) Happy path
  describe('(c) Valid input → service call + BulkResult', () => {
    it('calls reassignPromoter with correct args and returns the BulkResult', async () => {
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-promoter`)
        .set({ ...authHeader(ownerCtx), 'x-test-allow-permission': 'sim-custody:reassign' })
        .send({ toPromoterStaffId: PROMOTER_B, serialNumbers: ['SIM-001', 'SIM-002'] })

      expect(res.status).toBe(200)
      expect(res.body).toEqual(BULK_RESULT)
      expect(mockReassignPromoter).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: { staffId: USER_ID, organizationId: ORG_ID, role: 'OWNER' },
          toPromoterStaffId: PROMOTER_B,
          serialNumbers: ['SIM-001', 'SIM-002'],
        }),
      )
    })
  })

  // (d) Module gate
  describe('(d) SERIALIZED_INVENTORY module off → 403 moduleRequired', () => {
    it('returns 403 with moduleRequired:true when module is disabled', async () => {
      mockIsModuleEnabled.mockResolvedValue(false)

      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-promoter`)
        .set({ ...authHeader(ownerCtx), 'x-test-allow-permission': '*' })
        .send({ toPromoterStaffId: PROMOTER_B, serialNumbers: ['SIM-001'] })

      expect(res.status).toBe(403)
      expect(res.body.moduleRequired).toBe(true)
      expect(mockReassignPromoter).not.toHaveBeenCalled()
    })

    it('checks the module using the venueId from authContext', async () => {
      mockIsModuleEnabled.mockResolvedValue(true)

      await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-promoter`)
        .set({ ...authHeader(ownerCtx), 'x-test-allow-permission': 'sim-custody:reassign' })
        .send({ toPromoterStaffId: PROMOTER_B, serialNumbers: ['SIM-001'] })

      expect(mockIsModuleEnabled).toHaveBeenCalledWith(VENUE_ID, 'SERIALIZED_INVENTORY')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /sim-custody/reassign-supervisor', () => {
  let app: express.Express

  const SUP_BULK_RESULT = {
    summary: { total: 2, succeeded: 2, failed: 0 },
    results: [
      { serialNumber: 'SIM-001', status: 'ok', event: 'REASSIGNED_SUPERVISOR_TO_SUPERVISOR' },
      { serialNumber: 'SIM-002', status: 'ok', event: 'REASSIGNED_SUPERVISOR_TO_SUPERVISOR' },
    ],
  }

  beforeEach(() => {
    jest.clearAllMocks()
    app = createApp()
    mockIsModuleEnabled.mockResolvedValue(true)
    mockReassignSupervisor.mockResolvedValue(SUP_BULK_RESULT)
  })

  // (a) Permission gate
  describe('(a) Permission checks', () => {
    it('returns 403 when caller lacks sim-custody:reassign-supervisor', async () => {
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-supervisor`)
        .set(authHeader(ownerCtx))
        .send({ toSupervisorStaffId: SUPERVISOR_B, serialNumbers: ['SIM-001'] })

      expect(res.status).toBe(403)
      expect(mockReassignSupervisor).not.toHaveBeenCalled()
    })

    it('calls checkPermission with "sim-custody:reassign-supervisor"', async () => {
      await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-supervisor`)
        .set({ ...authHeader(ownerCtx), 'x-test-allow-permission': 'sim-custody:reassign-supervisor' })
        .send({ toSupervisorStaffId: SUPERVISOR_B, serialNumbers: ['SIM-001'] })

      expect(mockCheckPermission).toHaveBeenCalledWith('sim-custody:reassign-supervisor')
    })

    it('does NOT accept the promotor-level permission (separate authority)', async () => {
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-supervisor`)
        .set({ ...authHeader(ownerCtx), 'x-test-allow-permission': 'sim-custody:reassign' })
        .send({ toSupervisorStaffId: SUPERVISOR_B, serialNumbers: ['SIM-001'] })

      expect(res.status).toBe(403)
      expect(mockReassignSupervisor).not.toHaveBeenCalled()
    })
  })

  // (b) Body validation
  describe('(b) Body validation (Zod)', () => {
    const allowHeaders = { ...authHeader(ownerCtx), 'x-test-allow-permission': 'sim-custody:reassign-supervisor' }

    it('returns 400 when toSupervisorStaffId is missing', async () => {
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-supervisor`)
        .set(allowHeaders)
        .send({ serialNumbers: ['SIM-001'] })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('VALIDATION_ERROR')
      expect(mockReassignSupervisor).not.toHaveBeenCalled()
    })

    it('returns 400 when serialNumbers is empty', async () => {
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-supervisor`)
        .set(allowHeaders)
        .send({ toSupervisorStaffId: SUPERVISOR_B, serialNumbers: [] })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('VALIDATION_ERROR')
    })

    it('returns 400 when serialNumbers exceeds 500', async () => {
      const tooMany = Array.from({ length: 501 }, (_, i) => `SIM-${i}`)
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-supervisor`)
        .set(allowHeaders)
        .send({ toSupervisorStaffId: SUPERVISOR_B, serialNumbers: tooMany })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('VALIDATION_ERROR')
    })
  })

  // (c) Happy path — the real PlayTelecom case: 100 ICCIDs in one call
  describe('(c) Valid input → service call + BulkResult', () => {
    it('calls reassignSupervisor with correct args and returns the BulkResult', async () => {
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-supervisor`)
        .set({ ...authHeader(ownerCtx), 'x-test-allow-permission': 'sim-custody:reassign-supervisor' })
        .send({ toSupervisorStaffId: SUPERVISOR_B, serialNumbers: ['SIM-001', 'SIM-002'] })

      expect(res.status).toBe(200)
      expect(res.body).toEqual(SUP_BULK_RESULT)
      expect(mockReassignSupervisor).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: { staffId: USER_ID, organizationId: ORG_ID, role: 'OWNER' },
          toSupervisorStaffId: SUPERVISOR_B,
          serialNumbers: ['SIM-001', 'SIM-002'],
        }),
      )
    })

    it('accepts a 100-serial bulk payload in ONE request', async () => {
      const hundred = Array.from({ length: 100 }, (_, i) => `895214006369218${String(i).padStart(4, '0')}F`)
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-supervisor`)
        .set({ ...authHeader(ownerCtx), 'x-test-allow-permission': 'sim-custody:reassign-supervisor' })
        .send({ toSupervisorStaffId: SUPERVISOR_B, serialNumbers: hundred })

      expect(res.status).toBe(200)
      expect(mockReassignSupervisor).toHaveBeenCalledWith(expect.objectContaining({ serialNumbers: hundred }))
    })
  })

  // (d) Tenant boundary
  describe('(d) Tenant isolation', () => {
    it('returns TENANT_MISMATCH when authContext.orgId differs from the URL org', async () => {
      const otherOrgCtx = { ...ownerCtx, orgId: 'org-someone-else' }
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-supervisor`)
        .set({ ...authHeader(otherOrgCtx), 'x-test-allow-permission': '*' })
        .send({ toSupervisorStaffId: SUPERVISOR_B, serialNumbers: ['SIM-001'] })

      expect(res.body.error).toBe('TENANT_MISMATCH')
      expect(mockReassignSupervisor).not.toHaveBeenCalled()
    })
  })

  // (e) Module gate
  describe('(e) SERIALIZED_INVENTORY module off → 403 moduleRequired', () => {
    it('returns 403 with moduleRequired:true when module is disabled', async () => {
      mockIsModuleEnabled.mockResolvedValue(false)

      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-supervisor`)
        .set({ ...authHeader(ownerCtx), 'x-test-allow-permission': '*' })
        .send({ toSupervisorStaffId: SUPERVISOR_B, serialNumbers: ['SIM-001'] })

      expect(res.status).toBe(403)
      expect(res.body.moduleRequired).toBe(true)
      expect(mockReassignSupervisor).not.toHaveBeenCalled()
    })

    it('checks the module using the venueId from authContext', async () => {
      await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/reassign-supervisor`)
        .set({ ...authHeader(ownerCtx), 'x-test-allow-permission': 'sim-custody:reassign-supervisor' })
        .send({ toSupervisorStaffId: SUPERVISOR_B, serialNumbers: ['SIM-001'] })

      expect(mockIsModuleEnabled).toHaveBeenCalledWith(VENUE_ID, 'SERIALIZED_INVENTORY')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /sim-custody/change-category', () => {
  let app: express.Express

  const CAT_BULK_RESULT = {
    summary: { total: 1, succeeded: 1, failed: 0 },
    results: [{ serialNumber: 'SIM-001', status: 'ok', event: 'CATEGORY_CHANGED' }],
  }

  beforeEach(() => {
    jest.clearAllMocks()
    app = createApp()
    mockIsModuleEnabled.mockResolvedValue(true)
    mockChangeCategory.mockResolvedValue(CAT_BULK_RESULT)
  })

  // (a) Permission gate
  describe('(a) Permission checks', () => {
    it('returns 403 when caller lacks serialized-inventory:change-category', async () => {
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/change-category`)
        .set(authHeader(ownerCtx))
        .send({ categoryId: CATEGORY_ID, serialNumbers: ['SIM-001'] })

      expect(res.status).toBe(403)
      expect(mockChangeCategory).not.toHaveBeenCalled()
    })

    it('calls checkPermission with "serialized-inventory:change-category"', async () => {
      await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/change-category`)
        .set({ ...authHeader(ownerCtx), 'x-test-allow-permission': 'serialized-inventory:change-category' })
        .send({ categoryId: CATEGORY_ID, serialNumbers: ['SIM-001'] })

      expect(mockCheckPermission).toHaveBeenCalledWith('serialized-inventory:change-category')
    })
  })

  // (b) Body validation
  describe('(b) Body validation (Zod)', () => {
    const allowHeaders = {
      ...authHeader(ownerCtx),
      'x-test-allow-permission': 'serialized-inventory:change-category',
    }

    it('returns 400 when categoryId is missing', async () => {
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/change-category`)
        .set(allowHeaders)
        .send({ serialNumbers: ['SIM-001'] })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('VALIDATION_ERROR')
      expect(mockChangeCategory).not.toHaveBeenCalled()
    })

    it('returns 400 when serialNumbers is empty', async () => {
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/change-category`)
        .set(allowHeaders)
        .send({ categoryId: CATEGORY_ID, serialNumbers: [] })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('VALIDATION_ERROR')
    })

    it('returns 400 when serialNumbers exceeds 500', async () => {
      const tooMany = Array.from({ length: 501 }, (_, i) => `SIM-${i}`)
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/change-category`)
        .set(allowHeaders)
        .send({ categoryId: CATEGORY_ID, serialNumbers: tooMany })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('VALIDATION_ERROR')
    })
  })

  // (c) Happy path
  describe('(c) Valid input → service call + BulkResult', () => {
    it('calls changeCategory with correct args and returns the BulkResult', async () => {
      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/change-category`)
        .set({ ...authHeader(ownerCtx), 'x-test-allow-permission': 'serialized-inventory:change-category' })
        .send({ categoryId: CATEGORY_ID, serialNumbers: ['SIM-001'] })

      expect(res.status).toBe(200)
      expect(res.body).toEqual(CAT_BULK_RESULT)
      expect(mockChangeCategory).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: { staffId: USER_ID, organizationId: ORG_ID, role: 'OWNER' },
          categoryId: CATEGORY_ID,
          serialNumbers: ['SIM-001'],
        }),
      )
    })
  })

  // (d) Module gate
  describe('(d) SERIALIZED_INVENTORY module off → 403 moduleRequired', () => {
    it('returns 403 with moduleRequired:true when module is disabled', async () => {
      mockIsModuleEnabled.mockResolvedValue(false)

      const res = await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/change-category`)
        .set({ ...authHeader(ownerCtx), 'x-test-allow-permission': '*' })
        .send({ categoryId: CATEGORY_ID, serialNumbers: ['SIM-001'] })

      expect(res.status).toBe(403)
      expect(res.body.moduleRequired).toBe(true)
      expect(mockChangeCategory).not.toHaveBeenCalled()
    })

    it('checks the module using the venueId from authContext', async () => {
      await request(app)
        .post(`/dashboard/organizations/${ORG_ID}/sim-custody/change-category`)
        .set({ ...authHeader(ownerCtx), 'x-test-allow-permission': 'serialized-inventory:change-category' })
        .send({ categoryId: CATEGORY_ID, serialNumbers: ['SIM-001'] })

      expect(mockIsModuleEnabled).toHaveBeenCalledWith(VENUE_ID, 'SERIALIZED_INVENTORY')
    })
  })
})

// ─── Regression: existing routes unaffected ──────────────────────────────────

describe('Regression: existing sim-custody routes still mounted', () => {
  let app: express.Express

  beforeEach(() => {
    jest.clearAllMocks()
    app = createApp()
  })

  it('POST /assign-to-promoter still returns 403 without permission (not broken by new routes)', async () => {
    const res = await request(app)
      .post(`/dashboard/organizations/${ORG_ID}/sim-custody/assign-to-promoter`)
      .set(authHeader(ownerCtx))
      .send({ promoterStaffId: PROMOTER_A, serialNumbers: ['SIM-001'] })

    // No x-test-allow-permission → checkPermission returns 403
    expect(res.status).toBe(403)
  })
})
