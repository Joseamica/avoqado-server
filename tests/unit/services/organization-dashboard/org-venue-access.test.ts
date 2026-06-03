import prisma from '@/utils/prismaClient'
import { grantVenueAccessForOrg, listVenueAccessCandidatesForOrg } from '@/services/organization-dashboard/orgVenueAccess.service'
import * as venueAccess from '@/services/dashboard/venue-access.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findFirst: jest.fn() } },
}))
jest.mock('@/services/dashboard/venue-access.service')

const m = prisma as unknown as { venue: { findFirst: jest.Mock } }
const grantBatch = venueAccess.grantVenueAccessBatch as jest.Mock
const listCands = venueAccess.listVenueAccessCandidates as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe('grantVenueAccessForOrg', () => {
  it('rejects when the destination venue is not in the org', async () => {
    m.venue.findFirst.mockResolvedValue(null) // venue ∉ org
    await expect(
      grantVenueAccessForOrg('org-1', 'venue-x', [{ staffId: 's1', role: 'MANAGER' as any }], { staffId: 'o' } as any),
    ).rejects.toThrow('no pertenece a esta organización')
    expect(grantBatch).not.toHaveBeenCalled()
  })

  it('delegates to grantVenueAccessBatch when the venue is in the org', async () => {
    m.venue.findFirst.mockResolvedValue({ id: 'venue-1' })
    grantBatch.mockResolvedValue([{ staffId: 's1', role: 'MANAGER', pin: null }])
    await grantVenueAccessForOrg('org-1', 'venue-1', [{ staffId: 's1', role: 'MANAGER' as any }], { staffId: 'o' } as any)
    expect(grantBatch).toHaveBeenCalledWith('venue-1', [{ staffId: 's1', role: 'MANAGER' }], expect.anything())
  })
})

describe('listVenueAccessCandidatesForOrg', () => {
  it('rejects when the destination venue is not in the org', async () => {
    m.venue.findFirst.mockResolvedValue(null)
    await expect(listVenueAccessCandidatesForOrg('org-1', 'venue-x')).rejects.toThrow('no pertenece a esta organización')
    expect(listCands).not.toHaveBeenCalled()
  })

  it('rejects when the SOURCE venue is not in the org', async () => {
    // dest passes, source fails
    m.venue.findFirst.mockResolvedValueOnce({ id: 'dest' }).mockResolvedValueOnce(null)
    await expect(listVenueAccessCandidatesForOrg('org-1', 'dest', 'src-x')).rejects.toThrow('no pertenece a esta organización')
    expect(listCands).not.toHaveBeenCalled()
  })

  it('delegates when both venues are in the org', async () => {
    m.venue.findFirst.mockResolvedValue({ id: 'ok' })
    listCands.mockResolvedValue([])
    await listVenueAccessCandidatesForOrg('org-1', 'dest', 'src')
    expect(listCands).toHaveBeenCalledWith('dest', 'src')
  })
})
