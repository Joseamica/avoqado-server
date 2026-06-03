import prisma from '@/utils/prismaClient'
import { listVenueAccessCandidates } from '@/services/dashboard/venue-access.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn() }, staff: { findMany: jest.fn() } },
}))
const m = prisma as unknown as { venue: { findUnique: jest.Mock }; staff: { findMany: jest.Mock } }

beforeEach(() => {
  jest.clearAllMocks()
  m.venue.findUnique.mockResolvedValue({ id: 'dest', organizationId: 'org-1' })
})

describe('listVenueAccessCandidates', () => {
  it('pre-selects the source-venue role + suggests the source PIN + lists distinct roles held', async () => {
    m.staff.findMany.mockResolvedValue([
      {
        id: 's1',
        firstName: 'Braulio',
        lastName: 'Niño',
        email: 'b@x.com',
        venues: [
          { venueId: 'src', role: 'MANAGER', pin: '3987', active: true },
          { venueId: 'other', role: 'WAITER', pin: '3987', active: true },
        ],
      },
    ])
    const r = await listVenueAccessCandidates('dest', 'src')
    expect(r[0]).toEqual(
      expect.objectContaining({
        staffId: 's1',
        name: 'Braulio Niño',
        inSourceVenue: true,
        currentRoleAtSource: 'MANAGER',
        alreadyAtDestination: false,
        suggestedPin: '3987',
        rolesHeld: expect.arrayContaining(['MANAGER', 'WAITER']),
      }),
    )
  })

  it('flags a person who already has access at the destination', async () => {
    m.staff.findMany.mockResolvedValue([
      {
        id: 's2',
        firstName: 'Ana',
        lastName: 'Lopez',
        email: 'a@x.com',
        venues: [{ venueId: 'dest', role: 'CASHIER', pin: '1010', active: true }],
      },
    ])
    const r = await listVenueAccessCandidates('dest', 'src')
    expect(r[0]).toEqual(
      expect.objectContaining({
        alreadyAtDestination: true,
        currentRoleAtDestination: 'CASHIER',
        inSourceVenue: false,
      }),
    )
  })

  it('ignores inactive venue assignments when computing roles/pin', async () => {
    m.staff.findMany.mockResolvedValue([
      {
        id: 's3',
        firstName: 'Luis',
        lastName: 'Diaz',
        email: 'l@x.com',
        venues: [
          { venueId: 'src', role: 'WAITER', pin: '4444', active: true },
          { venueId: 'old', role: 'ADMIN', pin: '9999', active: false },
        ],
      },
    ])
    const r = await listVenueAccessCandidates('dest', 'src')
    expect(r[0].rolesHeld).toEqual(['WAITER'])
    expect(r[0].suggestedPin).toBe('4444')
  })

  it('throws when the destination venue does not exist', async () => {
    m.venue.findUnique.mockResolvedValue(null)
    await expect(listVenueAccessCandidates('nope')).rejects.toThrow('Sucursal no encontrada')
  })
})
