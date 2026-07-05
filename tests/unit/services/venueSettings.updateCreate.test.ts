import { updateVenueSettings } from '../../../src/services/dashboard/venueSettings.dashboard.service'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueSettings: { upsert: jest.fn() },
  },
}))
jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '../../../src/utils/prismaClient'

const mockedPrisma = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  venueSettings: { upsert: jest.Mock }
}

describe('updateVenueSettings — googleReviewLink on the CREATE branch', () => {
  beforeEach(() => jest.clearAllMocks())

  it('includes googleReviewLink in the upsert CREATE payload (so a venue with no settings row still persists it)', async () => {
    mockedPrisma.venue.findUnique.mockResolvedValue({ id: 'v1' })
    mockedPrisma.venueSettings.upsert.mockResolvedValue({ id: 's1', venueId: 'v1', googleReviewLink: 'ChIJ12345abc' })

    await updateVenueSettings('v1', { googleReviewLink: 'ChIJ12345abc' } as any)

    const callArg = mockedPrisma.venueSettings.upsert.mock.calls[0][0]
    expect(callArg.create.googleReviewLink).toBe('ChIJ12345abc')
    // update branch still passes the raw updates through
    expect(callArg.update.googleReviewLink).toBe('ChIJ12345abc')
  })

  it('defaults googleReviewLink to null in CREATE when not provided', async () => {
    mockedPrisma.venue.findUnique.mockResolvedValue({ id: 'v1' })
    mockedPrisma.venueSettings.upsert.mockResolvedValue({ id: 's1', venueId: 'v1' })

    await updateVenueSettings('v1', { notifyBadReviews: false } as any)

    const callArg = mockedPrisma.venueSettings.upsert.mock.calls[0][0]
    expect(callArg.create.googleReviewLink ?? null).toBeNull()
  })
})
