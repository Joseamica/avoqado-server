import { NextFunction, Request, Response } from 'express'
import * as venueDashboardService from '@/services/dashboard/venue.dashboard.service'
import * as venueTpvService from '@/services/tpv/venue.tpv.service'
import * as venueDashboardController from '@/controllers/dashboard/venue.dashboard.controller'
import * as venueTpvController from '@/controllers/tpv/venue.tpv.controller'
import type { ListVenuesQueryDto } from '@/schemas/dashboard/venue.schema'

jest.mock('@/services/dashboard/venue.dashboard.service')
jest.mock('@/services/tpv/venue.tpv.service')

const organizationId = '<organization-id>'
const venueId = '<venue-id>'
const internalFence = '2026-08-08T12:00:00.000Z'

const legacyVenue = {
  id: venueId,
  organizationId,
  name: 'Centro Histórico',
  slug: 'centro-historico',
  settings: { currency: 'MXN' },
}

const prismaVenueReturn = {
  ...legacyVenue,
  // Mocks bypass the Prisma singleton omit, so this fixture proves the HTTP
  // boundary independently strips the server-only governance fence.
  catalogGovernanceEnforcedAt: internalFence,
}

const makeResponse = () => {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  return res
}

const expectResponse = (res: Response, status: number, body: unknown): void => {
  expect(res.status).toHaveBeenCalledWith(status)
  expect(res.json).toHaveBeenCalledWith(body)
  const payload = (res.json as jest.Mock).mock.calls[0][0]
  if (Array.isArray(payload)) {
    payload.forEach(venue => expect(venue).not.toHaveProperty('catalogGovernanceEnforcedAt'))
  } else {
    expect(payload).not.toHaveProperty('catalogGovernanceEnforcedAt')
  }
}

beforeEach(() => jest.clearAllMocks())

describe('H1A legacy Venue contracts', () => {
  it('keeps dashboard list/create/detail payloads byte-compatible when Prisma returns the internal fence', async () => {
    jest.mocked(venueDashboardService.listVenuesForOrganization).mockResolvedValue([prismaVenueReturn] as never)
    jest.mocked(venueDashboardService.createVenueForOrganization).mockResolvedValue(prismaVenueReturn as never)
    jest.mocked(venueDashboardService.getVenueById).mockResolvedValue(prismaVenueReturn as never)
    const next = jest.fn() as NextFunction

    const listResponse = makeResponse()
    await venueDashboardController.listVenues(
      { authContext: { orgId: organizationId }, query: { page: 1, limit: 20 } } as unknown as Request<{}, any, any, ListVenuesQueryDto>,
      listResponse,
      next,
    )
    expectResponse(listResponse, 200, [legacyVenue])

    const createResponse = makeResponse()
    await venueDashboardController.createVenue(
      { authContext: { orgId: organizationId }, body: { name: legacyVenue.name } } as unknown as Request,
      createResponse,
      next,
    )
    expectResponse(createResponse, 201, legacyVenue)

    const detailResponse = makeResponse()
    await venueDashboardController.getVenueById(
      { authContext: { orgId: organizationId, role: 'OWNER' }, params: { venueId } } as unknown as Request<{
        venueId: string
      }>,
      detailResponse,
      next,
    )
    expectResponse(detailResponse, 200, legacyVenue)
    expect(next).not.toHaveBeenCalled()
  })

  it('keeps the TPV detail payload byte-compatible when Prisma returns the internal fence', async () => {
    jest.mocked(venueTpvService.getVenueById).mockResolvedValue(prismaVenueReturn as never)
    const next = jest.fn() as NextFunction
    const response = makeResponse()

    await venueTpvController.getVenueById({ params: { venueId } } as unknown as Request<{ venueId: string }>, response, next)

    expectResponse(response, 200, legacyVenue)
    expect(next).not.toHaveBeenCalled()
  })
})
