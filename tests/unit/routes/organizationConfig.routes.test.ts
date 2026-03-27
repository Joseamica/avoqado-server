/**
 * Organization Config Routes Tests
 *
 * Tests the org-level configuration endpoints:
 * 1. Auth/permissions (requireOrgOwner middleware)
 * 2. Org Goals CRUD
 * 3. Org Categories CRUD
 *
 * Uses supertest with a mini Express app that mounts the router.
 * Prisma is mocked via the global setup (__helpers__/setup.ts).
 */

import express from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'

// Mock authenticateTokenMiddleware — injects authContext from req header or defaults
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    // Test sets authContext via a custom header (JSON-stringified)
    const ctx = req.headers['x-test-auth-context']
    if (ctx) {
      req.authContext = JSON.parse(ctx as string)
    }
    next()
  },
}))

// Mock goal-resolution service
jest.mock('@/services/dashboard/commission/goal-resolution.service', () => ({
  getOrgGoals: jest.fn(),
  createOrgGoal: jest.fn(),
  updateOrgGoal: jest.fn(),
  deleteOrgGoal: jest.fn(),
}))

// Mock organization dashboard service
jest.mock('@/services/organization-dashboard/organizationDashboard.service', () => ({
  organizationDashboardService: {
    getOrgAttendanceConfig: jest.fn(),
    upsertOrgAttendanceConfig: jest.fn(),
    deleteOrgAttendanceConfig: jest.fn(),
    getOrgTpvDefaults: jest.fn(),
    upsertOrgTpvDefaults: jest.fn(),
    getOrgTpvStats: jest.fn(),
  },
}))

import organizationConfigRouter from '@/routes/dashboard/organizationConfig.routes'
import * as goalResolutionService from '@/services/dashboard/commission/goal-resolution.service'

// ─── App setup ──────────────────────────────────────────────────────────────────

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/dashboard/organizations/:orgId', organizationConfigRouter)
  return app
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

const ORG_ID = 'org-test-123'
const VENUE_ID = 'venue-test-456'
const GOAL_ID = 'goal-test-789'
const CATEGORY_ID = 'cat-test-101'
const USER_ID = 'user-test-001'

const ownerContext = {
  userId: USER_ID,
  orgId: ORG_ID,
  venueId: VENUE_ID,
  role: 'OWNER',
}

const superadminContext = {
  userId: USER_ID,
  orgId: ORG_ID,
  venueId: VENUE_ID,
  role: 'SUPERADMIN',
}

const cashierContext = {
  userId: USER_ID,
  orgId: ORG_ID,
  venueId: VENUE_ID,
  role: 'CASHIER',
}

function authHeader(ctx: object): [string, string] {
  return ['x-test-auth-context', JSON.stringify(ctx)]
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('Organization Config Routes', () => {
  let app: express.Express

  beforeEach(() => {
    app = createApp()
  })

  // ═══════════════════════════════════════════════════════════════════════════════
  // AUTH / PERMISSIONS (requireOrgOwner middleware)
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Auth / Permissions', () => {
    it('should return 403 for non-OWNER users (e.g. CASHIER)', async () => {
      // CASHIER is not SUPERADMIN, and has no OWNER StaffVenue in the org
      prismaMock.staffVenue.findFirst.mockResolvedValue(null)

      const res = await request(app)
        .get(`/dashboard/organizations/${ORG_ID}/org-goals`)
        .set(...authHeader(cashierContext))

      expect(res.status).toBe(403)
      expect(res.body.success).toBe(false)
      expect(res.body.message).toContain('Owner access required')
    })

    it('should allow OWNER access', async () => {
      // requireOrgOwner checks StaffVenue with OWNER role in org
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-owner' })
      // The GET /org-goals handler then looks up a venue in the org
      prismaMock.venue.findFirst.mockResolvedValue({ id: VENUE_ID })
      ;(goalResolutionService.getOrgGoals as jest.Mock).mockResolvedValue([])

      const res = await request(app)
        .get(`/dashboard/organizations/${ORG_ID}/org-goals`)
        .set(...authHeader(ownerContext))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })

    it('should allow SUPERADMIN access (bypasses owner check)', async () => {
      // SUPERADMIN bypasses the StaffVenue lookup entirely
      prismaMock.venue.findFirst.mockResolvedValue({ id: VENUE_ID })
      ;(goalResolutionService.getOrgGoals as jest.Mock).mockResolvedValue([])

      const res = await request(app)
        .get(`/dashboard/organizations/${ORG_ID}/org-goals`)
        .set(...authHeader(superadminContext))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      // StaffVenue.findFirst should NOT be called for SUPERADMIN
      expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════════
  // ORG GOALS CRUD
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Org Goals CRUD', () => {
    // All goal tests use SUPERADMIN to bypass the owner check
    const header = authHeader(superadminContext)

    beforeEach(() => {
      prismaMock.venue.findFirst.mockResolvedValue({ id: VENUE_ID })
    })

    describe('GET /org-goals', () => {
      it('should return goals array', async () => {
        const mockGoals = [{ id: GOAL_ID, goal: 50000, goalType: 'AMOUNT', period: 'MONTHLY', active: true }]
        ;(goalResolutionService.getOrgGoals as jest.Mock).mockResolvedValue(mockGoals)

        const res = await request(app)
          .get(`/dashboard/organizations/${ORG_ID}/org-goals`)
          .set(...header)

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
        expect(res.body.data).toEqual(mockGoals)
        expect(goalResolutionService.getOrgGoals).toHaveBeenCalledWith(VENUE_ID)
      })

      it('should return 404 when org has no venues', async () => {
        prismaMock.venue.findFirst.mockResolvedValue(null)

        const res = await request(app)
          .get(`/dashboard/organizations/${ORG_ID}/org-goals`)
          .set(...header)

        expect(res.status).toBe(404)
        expect(res.body.success).toBe(false)
        expect(res.body.error).toBe('not_found')
      })
    })

    describe('POST /org-goals', () => {
      it('should create a goal', async () => {
        const newGoal = { id: 'new-goal', goal: 100000, goalType: 'AMOUNT', period: 'MONTHLY' }
        ;(goalResolutionService.createOrgGoal as jest.Mock).mockResolvedValue(newGoal)

        const res = await request(app)
          .post(`/dashboard/organizations/${ORG_ID}/org-goals`)
          .set(...header)
          .send({ goal: 100000, goalType: 'AMOUNT', period: 'MONTHLY' })

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
        expect(res.body.data).toEqual(newGoal)
        expect(goalResolutionService.createOrgGoal).toHaveBeenCalledWith(VENUE_ID, {
          goal: 100000,
          goalType: 'AMOUNT',
          period: 'MONTHLY',
        })
      })

      it('should default goalType to AMOUNT and period to MONTHLY', async () => {
        ;(goalResolutionService.createOrgGoal as jest.Mock).mockResolvedValue({ id: 'g1' })

        await request(app)
          .post(`/dashboard/organizations/${ORG_ID}/org-goals`)
          .set(...header)
          .send({ goal: 5000 })

        expect(goalResolutionService.createOrgGoal).toHaveBeenCalledWith(VENUE_ID, {
          goal: 5000,
          goalType: 'AMOUNT',
          period: 'MONTHLY',
        })
      })
    })

    describe('PATCH /org-goals/:goalId', () => {
      it('should update a goal', async () => {
        const updatedGoal = { id: GOAL_ID, goal: 75000, goalType: 'AMOUNT', period: 'MONTHLY', active: true }
        ;(goalResolutionService.updateOrgGoal as jest.Mock).mockResolvedValue(updatedGoal)

        const res = await request(app)
          .patch(`/dashboard/organizations/${ORG_ID}/org-goals/${GOAL_ID}`)
          .set(...header)
          .send({ goal: 75000 })

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
        expect(res.body.data).toEqual(updatedGoal)
        expect(goalResolutionService.updateOrgGoal).toHaveBeenCalledWith(VENUE_ID, GOAL_ID, expect.objectContaining({ goal: 75000 }))
      })
    })

    describe('DELETE /org-goals/:goalId', () => {
      it('should delete a goal', async () => {
        ;(goalResolutionService.deleteOrgGoal as jest.Mock).mockResolvedValue(undefined)

        const res = await request(app)
          .delete(`/dashboard/organizations/${ORG_ID}/org-goals/${GOAL_ID}`)
          .set(...header)

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
        expect(res.body.data.message).toBe('Org goal deleted')
        expect(goalResolutionService.deleteOrgGoal).toHaveBeenCalledWith(VENUE_ID, GOAL_ID)
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════════
  // ORG CATEGORIES CRUD
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Org Categories CRUD', () => {
    const header = authHeader(superadminContext)

    describe('GET /org-categories', () => {
      it('should return categories array', async () => {
        const mockCategories = [
          { id: 'cat-1', name: 'Electrónica', sortOrder: 0, organizationId: ORG_ID },
          { id: 'cat-2', name: 'Accesorios', sortOrder: 1, organizationId: ORG_ID },
        ]
        prismaMock.itemCategory.findMany.mockResolvedValue(mockCategories)

        const res = await request(app)
          .get(`/dashboard/organizations/${ORG_ID}/org-categories`)
          .set(...header)

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
        expect(res.body.data.categories).toEqual(mockCategories)
        expect(prismaMock.itemCategory.findMany).toHaveBeenCalledWith({
          where: { organizationId: ORG_ID },
          orderBy: { sortOrder: 'asc' },
        })
      })
    })

    describe('POST /org-categories', () => {
      it('should create a category with auto-incrementing sortOrder', async () => {
        prismaMock.itemCategory.aggregate.mockResolvedValue({ _max: { sortOrder: 2 } })
        const createdCat = {
          id: CATEGORY_ID,
          name: 'Nueva Categoría',
          description: null,
          suggestedPrice: null,
          organizationId: ORG_ID,
          sortOrder: 3,
        }
        prismaMock.itemCategory.create.mockResolvedValue(createdCat)

        const res = await request(app)
          .post(`/dashboard/organizations/${ORG_ID}/org-categories`)
          .set(...header)
          .send({ name: 'Nueva Categoría' })

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
        expect(res.body.data).toEqual(createdCat)
        expect(prismaMock.itemCategory.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            name: 'Nueva Categoría',
            organizationId: ORG_ID,
            sortOrder: 3,
          }),
        })
      })

      it('should start sortOrder at 0 when no categories exist', async () => {
        prismaMock.itemCategory.aggregate.mockResolvedValue({ _max: { sortOrder: null } })
        prismaMock.itemCategory.create.mockResolvedValue({ id: 'cat-new', sortOrder: 0 })

        await request(app)
          .post(`/dashboard/organizations/${ORG_ID}/org-categories`)
          .set(...header)
          .send({ name: 'Primera' })

        expect(prismaMock.itemCategory.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ sortOrder: 0 }),
        })
      })

      it('should reject empty name with 400', async () => {
        const res = await request(app)
          .post(`/dashboard/organizations/${ORG_ID}/org-categories`)
          .set(...header)
          .send({ name: '   ' })

        expect(res.status).toBe(400)
        expect(res.body.success).toBe(false)
        expect(res.body.error).toBe('validation')
      })

      it('should reject missing name with 400', async () => {
        const res = await request(app)
          .post(`/dashboard/organizations/${ORG_ID}/org-categories`)
          .set(...header)
          .send({})

        expect(res.status).toBe(400)
        expect(res.body.success).toBe(false)
      })
    })

    describe('PUT /org-categories/:categoryId', () => {
      it('should update a category', async () => {
        const updatedCat = {
          id: CATEGORY_ID,
          name: 'Actualizada',
          description: 'Desc nueva',
          organizationId: ORG_ID,
        }
        prismaMock.itemCategory.update.mockResolvedValue(updatedCat)

        const res = await request(app)
          .put(`/dashboard/organizations/${ORG_ID}/org-categories/${CATEGORY_ID}`)
          .set(...header)
          .send({ name: 'Actualizada', description: 'Desc nueva' })

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
        expect(res.body.data).toEqual(updatedCat)
        expect(prismaMock.itemCategory.update).toHaveBeenCalledWith({
          where: { id: CATEGORY_ID, organizationId: ORG_ID },
          data: expect.objectContaining({ name: 'Actualizada' }),
        })
      })
    })

    describe('DELETE /org-categories/:categoryId', () => {
      it('should delete a category', async () => {
        prismaMock.itemCategory.delete.mockResolvedValue({ id: CATEGORY_ID })

        const res = await request(app)
          .delete(`/dashboard/organizations/${ORG_ID}/org-categories/${CATEGORY_ID}`)
          .set(...header)

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
        expect(res.body.data.message).toBe('Category deleted')
        expect(prismaMock.itemCategory.delete).toHaveBeenCalledWith({
          where: { id: CATEGORY_ID, organizationId: ORG_ID },
        })
      })
    })
  })
})
