import express from 'express'
import request from 'supertest'
import { prismaMock } from '../../__helpers__/setup'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const context = req.headers['x-test-auth-context']
    if (context) req.authContext = JSON.parse(context as string)
    next()
  },
}))

const mockGetOrgStockSummary = jest.fn((_req: any, res: any) => res.status(200).json({ success: true }))

jest.mock('@/controllers/dashboard/organizationStockControl.controller', () => ({
  getOrgStockOverview: jest.fn(),
  getOrgStockSummary: (...args: unknown[]) => mockGetOrgStockSummary(...args),
  getOrgStockItems: jest.fn(),
  getOrgStockBulkGroups: jest.fn(),
  getOrgStockCustody: jest.fn(),
  exportOrgStockExcel: jest.fn(),
  getOrgInventoryByResponsible: jest.fn(),
}))

import organizationStockControlRoutes from '@/routes/dashboard/organizationStockControl.routes'

const ORG_ID = 'org-1'
const ownerContext = { userId: 'owner-1', orgId: ORG_ID, venueId: 'venue-1', role: 'OWNER' }

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/dashboard/organizations/:orgId', organizationStockControlRoutes)
  return app
}

describe('organization stock-control membership gate', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'membership-1' } as any)
  })

  it('requires both the venue membership and staff account to be active', async () => {
    const response = await request(makeApp())
      .get(`/dashboard/organizations/${ORG_ID}/stock-control/summary`)
      .set('x-test-auth-context', JSON.stringify(ownerContext))

    expect(response.status).toBe(200)
    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          staffId: 'owner-1',
          active: true,
          staff: { active: true },
          venue: { organizationId: ORG_ID },
        }),
      }),
    )
  })

  it('denies access when no active membership exists', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)

    const response = await request(makeApp())
      .get(`/dashboard/organizations/${ORG_ID}/stock-control/summary`)
      .set('x-test-auth-context', JSON.stringify(ownerContext))

    expect(response.status).toBe(403)
    expect(mockGetOrgStockSummary).not.toHaveBeenCalled()
  })
})
