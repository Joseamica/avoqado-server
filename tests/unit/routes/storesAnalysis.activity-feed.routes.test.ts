/**
 * Regression coverage for the Supervisor activity feed.
 *
 * Breaks caught:
 * - a client can make the server materialize 10k rich orders/time entries;
 * - a manager can receive organization venues they are not assigned to.
 */
import express from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const raw = req.headers['x-test-auth-context']
    if (raw) req.authContext = JSON.parse(raw as string)
    next()
  },
}))

jest.mock('@/middlewares/verifyAccess.middleware', () => ({
  verifyAccess: () => (req: any, _res: any, next: any) => {
    const auth = req.authContext
    req.access = {
      userId: auth.userId,
      venueId: auth.venueId,
      organizationId: auth.orgId,
      role: auth.role,
      whiteLabelEnabled: true,
      corePermissions: [],
      enabledFeatures: [],
      featureAccess: {},
      featureMetadata: {},
    }
    next()
  },
}))

import storesAnalysisRouter from '@/routes/dashboard/storesAnalysis.routes'
import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'

const ORG_ID = 'org-play'
const VENUE_ID = 'venue-context'
const USER_ID = 'staff-1'
const BASE = `/dashboard/venues/${VENUE_ID}/stores-analysis`

function auth(role: string): [string, string] {
  return ['x-test-auth-context', JSON.stringify({ userId: USER_ID, orgId: ORG_ID, venueId: VENUE_ID, role })]
}

function createApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use('/dashboard/venues/:venueId/stores-analysis', storesAnalysisRouter)
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ message: err.message })
  })
  return app
}

describe('Stores Analysis activity feed bounds and scope', () => {
  const getActivityFeedSpy = jest.spyOn(organizationDashboardService, 'getActivityFeed')

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: ORG_ID } as any)
    getActivityFeedSpy.mockResolvedValue({ events: [], total: 0 })
  })

  afterAll(() => {
    getActivityFeedSpy.mockRestore()
  })

  it('caps a requested limit of 10000 at 200', async () => {
    const res = await request(createApp())
      .get(`${BASE}/activity-feed?limit=10000`)
      .set(...auth('OWNER'))

    expect(res.status).toBe(200)
    expect(getActivityFeedSpy).toHaveBeenCalledWith(ORG_ID, 200, undefined, undefined, undefined, undefined)
  })

  it.each(['garbage', '0', '-20'])('uses the safe default for invalid limit %s', async invalidLimit => {
    const res = await request(createApp())
      .get(`${BASE}/activity-feed?limit=${invalidLimit}`)
      .set(...auth('OWNER'))

    expect(res.status).toBe(200)
    expect(getActivityFeedSpy).toHaveBeenCalledWith(ORG_ID, 50, undefined, undefined, undefined, undefined)
  })

  it('passes only a managers active venues to the service', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([{ venueId: 'venue-1' }, { venueId: 'venue-2' }] as any)

    const res = await request(createApp())
      .get(`${BASE}/activity-feed`)
      .set(...auth('MANAGER'))

    expect(res.status).toBe(200)
    expect(prismaMock.staffVenue.findMany).toHaveBeenCalledWith({
      where: {
        staffId: USER_ID,
        active: true,
        venue: { organizationId: ORG_ID, status: 'ACTIVE' },
      },
      select: { venueId: true },
    })
    expect(getActivityFeedSpy).toHaveBeenCalledWith(ORG_ID, 50, undefined, undefined, undefined, ['venue-1', 'venue-2'])
  })

  it('rejects a venue filter outside a managers assignments before querying the feed', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([{ venueId: 'venue-1' }] as any)

    const res = await request(createApp())
      .get(`${BASE}/activity-feed?filterVenueId=venue-forged`)
      .set(...auth('MANAGER'))

    expect(res.status).toBe(403)
    expect(getActivityFeedSpy).not.toHaveBeenCalled()
  })
})
