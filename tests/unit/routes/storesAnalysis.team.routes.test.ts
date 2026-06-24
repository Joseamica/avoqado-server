/**
 * Stores-Analysis Team Route Tests (white-label "Usuarios" list)
 *
 * Regression: PlayTelecom's UsersManagement page lists staff via
 * GET /dashboard/venues/:venueId/stores-analysis/team. That handler queried
 * StaffOrganization with no isActive filter, so members removed from the org
 * (StaffOrganization.isActive=false via removeFromOrganization / the
 * ex-collaborator cleanup) kept appearing — in BOTH org scope and venue scope.
 * The fix adds `isActive: true`, mirroring getOrganizationTeam. Venue-deactivated
 * members (StaffVenue.active=false, isActive stays true) remain visible so they
 * can be reactivated. See Asana 1215884464715725.
 *
 * Uses supertest with a mini Express app. Prisma is mocked via global setup.
 */

import express from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'

// Inject authContext from a test header (JSON-stringified)
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) req.authContext = JSON.parse(ctx as string)
    next()
  },
}))

// White-label gate: pass-through in tests (access is exercised elsewhere)
jest.mock('@/middlewares/verifyAccess.middleware', () => ({
  verifyAccess: () => (_req: any, _res: any, next: any) => next(),
}))

import storesAnalysisRouter from '@/routes/dashboard/storesAnalysis.routes'

const ORG_ID = 'org-test-123'
const VENUE_ID = 'venue-test-456'
const USER_ID = 'user-test-001'

const ownerContext = { userId: USER_ID, orgId: ORG_ID, venueId: VENUE_ID, role: 'OWNER' }

function authHeader(ctx: object): [string, string] {
  return ['x-test-auth-context', JSON.stringify(ctx)]
}

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/dashboard/venues/:venueId/stores-analysis', storesAnalysisRouter)
  return app
}

describe('Stores-Analysis GET /team', () => {
  let app: express.Express

  beforeEach(() => {
    app = createApp()
    // getOrgIdFromVenue
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: ORG_ID } as any)
    // isOrgOwner lookup
    prismaMock.staffOrganization.findFirst.mockResolvedValue({ role: 'OWNER' } as any)
    prismaMock.staffOrganization.findMany.mockResolvedValue([])
    prismaMock.staffVenue.findMany.mockResolvedValue([])
  })

  it('org scope: only returns CURRENT members (StaffOrganization.isActive = true)', async () => {
    const res = await request(app)
      .get(`/dashboard/venues/${VENUE_ID}/stores-analysis/team?scope=org`)
      .set(...authHeader(ownerContext))

    expect(res.status).toBe(200)
    expect(prismaMock.staffOrganization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG_ID, isActive: true },
      }),
    )
  })

  it('venue scope: filters org membership on isActive = true', async () => {
    const res = await request(app)
      .get(`/dashboard/venues/${VENUE_ID}/stores-analysis/team`)
      .set(...authHeader(ownerContext))

    expect(res.status).toBe(200)
    expect(prismaMock.staffOrganization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_ID, isActive: true }),
      }),
    )
  })
})
