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

// Esta suite aísla el límite venue↔organización. La autorización canónica
// `inventory:read` tiene su propia suite de rutas y no debe convertir este test
// en una recreación parcial de PermissionSet/StaffVenue.
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  resolveRequestVenueId: (_req: any, authContext: any) => authContext?.venueId,
  checkPermission: () => (_req: any, _res: any, next: any) => next(),
}))

const mockGetOrgStockSummary = jest.fn((_req: any, res: any) => res.status(200).json({ success: true }))

jest.mock('@/controllers/dashboard/organizationStockControl.controller', () => ({
  getOrgStockOverview: jest.fn(),
  getOrgStockSummary: (...args: Parameters<typeof mockGetOrgStockSummary>) => mockGetOrgStockSummary(...args),
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

describe('organization stock-control active venue boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // No es SUPERADMIN: debe probar el venue activo y después pasar por el
    // middleware canónico `inventory:read` de la ruta.
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: ORG_ID } as any)
  })

  it('requires the active venue to belong to the requested organization', async () => {
    const response = await request(makeApp())
      .get(`/dashboard/organizations/${ORG_ID}/stock-control/summary`)
      .set('x-test-auth-context', JSON.stringify(ownerContext))

    expect(response.status).toBe(200)
    expect(prismaMock.venue.findUnique).toHaveBeenCalledWith({
      where: { id: 'venue-1' },
      select: { organizationId: true },
    })
  })

  it('denies access when the active venue belongs to another organization', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-other' } as any)

    const response = await request(makeApp())
      .get(`/dashboard/organizations/${ORG_ID}/stock-control/summary`)
      .set('x-test-auth-context', JSON.stringify(ownerContext))

    expect(response.status).toBe(403)
    expect(mockGetOrgStockSummary).not.toHaveBeenCalled()
  })
})
