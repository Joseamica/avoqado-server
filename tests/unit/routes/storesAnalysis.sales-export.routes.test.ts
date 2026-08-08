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
import * as supervisorSalesExportService from '@/services/organization-dashboard/supervisorSalesExport.service'
import { logAction } from '@/services/dashboard/activity-log.service'

const ORG_ID = 'org-play'
const VENUE_ID = 'venue-context'
const USER_ID = 'staff-isaac'
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

describe('Stores Analysis sales export routes', () => {
  const getPageSpy = jest.spyOn(supervisorSalesExportService, 'getSupervisorSalesExportPage')
  const logActionMock = logAction as jest.Mock

  beforeEach(() => {
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: ORG_ID, timezone: 'America/Cancun' } as any)
    getPageSpy.mockResolvedValue({ rows: [], nextCursor: null, total: 0 })
    logActionMock.mockResolvedValue(undefined)
  })

  afterAll(() => {
    getPageSpy.mockRestore()
  })

  it('returns a cursor page using the server-resolved organization scope', async () => {
    getPageSpy.mockResolvedValue({
      rows: [
        {
          id: 'order-1',
          venueName: 'Centro',
          product: 'Venta: $10.00',
          iccid: null,
          staffId: USER_ID,
          staffName: 'Isaac Mayoral',
          staffEmployeeCode: null,
          amount: 10,
          timestamp: '2026-08-07T12:00:00.000Z',
        },
      ],
      nextCursor: 'cursor-2',
      total: 2,
    })

    const res = await request(createApp())
      .get(`${BASE}/sales-export-rows`)
      .query({ startDate: '2026-08-01', endDate: '2026-08-07', cursor: 'cursor-1', limit: '300' })
      .set(...auth('OWNER'))

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual(expect.objectContaining({ nextCursor: 'cursor-2', total: 2 }))
    expect(getPageSpy).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      scopedVenueIds: undefined,
      timezone: 'America/Cancun',
      startDate: '2026-08-01',
      endDate: '2026-08-07',
      cursor: 'cursor-1',
      limit: 300,
    })
  })

  it('rejects a manager filtering an unassigned venue before querying export rows', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([{ venueId: 'venue-assigned' }] as any)

    const res = await request(createApp())
      .get(`${BASE}/sales-export-rows`)
      .query({ startDate: '2026-08-01', endDate: '2026-08-07', filterVenueId: 'venue-forged' })
      .set(...auth('MANAGER'))

    expect(res.status).toBe(403)
    expect(getPageSpy).not.toHaveBeenCalled()
  })

  it('records a validated export audit with the authenticated actor and path venue', async () => {
    const res = await request(createApp())
      .post(`${BASE}/sales-export-audit`)
      .set(...auth('OWNER'))
      .set('user-agent', 'supervisor-test')
      .send({
        format: 'excel',
        startDate: '2026-08-01',
        endDate: '2026-08-07',
        rowCount: 5706,
      })

    expect(res.status).toBe(204)
    expect(logActionMock).toHaveBeenCalledWith({
      staffId: USER_ID,
      venueId: VENUE_ID,
      action: 'SALES_REPORT_EXPORTED',
      entity: 'SalesReport',
      data: {
        organizationId: ORG_ID,
        format: 'excel',
        startDate: '2026-08-01',
        endDate: '2026-08-07',
        filterVenueId: null,
        rowCount: 5706,
      },
      ipAddress: expect.any(String),
      userAgent: 'supervisor-test',
    })
  })

  it.each([
    [{ format: 'pdf', startDate: '2026-08-01', endDate: '2026-08-07', rowCount: 1 }, 'format'],
    [{ format: 'csv', startDate: '2026-08-01', endDate: '2026-08-07', rowCount: -1 }, 'rowCount'],
    [{ format: 'csv', startDate: '2026-08-01', endDate: '2026-08-07', rowCount: 25_001 }, 'rowCount'],
    [{ format: 'csv', startDate: '2026-08-01', endDate: '2026-08-07', rowCount: 1.5 }, 'rowCount'],
    [{ format: 'csv', startDate: '2026-08-01', rowCount: 1 }, 'endDate'],
    [{ format: 'csv', startDate: 123, endDate: '2026-08-07', rowCount: 1 }, 'startDate'],
    [{ format: 'csv', startDate: '2026-08-01', endDate: { day: 7 }, rowCount: 1 }, 'endDate'],
  ])('rejects invalid audit payload %j (%s)', async (body, _field) => {
    const res = await request(createApp())
      .post(`${BASE}/sales-export-audit`)
      .set(...auth('OWNER'))
      .send(body)

    expect(res.status).toBe(400)
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('rejects a forged audit venue without writing an activity log', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([{ venueId: 'venue-assigned' }] as any)

    const res = await request(createApp())
      .post(`${BASE}/sales-export-audit`)
      .set(...auth('MANAGER'))
      .send({
        format: 'csv',
        startDate: '2026-08-01',
        endDate: '2026-08-07',
        filterVenueId: 'venue-forged',
        rowCount: 10,
      })

    expect(res.status).toBe(403)
    expect(logActionMock).not.toHaveBeenCalled()
  })
})
