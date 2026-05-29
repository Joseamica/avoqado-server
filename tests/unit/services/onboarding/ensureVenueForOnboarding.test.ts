// Test the "provisional venue" mid-onboarding creation. Step 8 (payment
// providers) and Step 9 (TPV purchase) both need a venueId before
// `completeSetup` runs — so the GET progress endpoint ensures one exists.
//
// Strategy: if the org already has any venue, reuse it. Otherwise create
// one with status=ONBOARDING using the wizard data captured so far. The
// schema already has `VenueStatus.ONBOARDING` (default) for exactly this case.

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findFirst: jest.fn() },
    organization: { findUnique: jest.fn() },
  },
}))

jest.mock('../../../../src/services/onboarding/venueCreation.service', () => ({
  __esModule: true,
  createVenueFromOnboarding: jest.fn(),
}))

jest.mock('../../../../src/services/onboarding/onboardingProgress.service', () => {
  const actual = jest.requireActual('../../../../src/services/onboarding/onboardingProgress.service')
  return {
    __esModule: true,
    ...actual,
    getV2SetupDataForCompletion: jest.fn(),
  }
})

import { ensureVenueForOnboarding } from '../../../../src/services/onboarding/ensureVenue.service'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const prisma = require('../../../../src/utils/prismaClient').default
// eslint-disable-next-line @typescript-eslint/no-var-requires
const venueCreation = require('../../../../src/services/onboarding/venueCreation.service')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const onboardingProgress = require('../../../../src/services/onboarding/onboardingProgress.service')

describe('ensureVenueForOnboarding', () => {
  beforeEach(() => {
    prisma.venue.findFirst.mockReset()
    prisma.organization.findUnique.mockReset()
    venueCreation.createVenueFromOnboarding.mockReset()
    onboardingProgress.getV2SetupDataForCompletion.mockReset()
  })

  it('returns the existing venue when org already has one (any status)', async () => {
    prisma.venue.findFirst.mockResolvedValue({
      id: 'venue-existing',
      slug: 'pelusis',
      status: 'ONBOARDING',
    })

    const result = await ensureVenueForOnboarding('org-1', 'staff-1')
    expect(result).toEqual({ id: 'venue-existing', slug: 'pelusis', status: 'ONBOARDING' })
    // Idempotent — does NOT call createVenueFromOnboarding when one exists
    expect(venueCreation.createVenueFromOnboarding).not.toHaveBeenCalled()
  })

  it('also reuses an existing venue when its status is ACTIVE (post-completion)', async () => {
    // Covers the "user returns to onboarding wizard after already completing" case.
    // We don't want to create a SECOND venue.
    prisma.venue.findFirst.mockResolvedValue({
      id: 'venue-existing',
      slug: 'pelusis',
      status: 'ACTIVE',
    })

    const result = await ensureVenueForOnboarding('org-1', 'staff-1')
    expect(result?.id).toBe('venue-existing')
    expect(venueCreation.createVenueFromOnboarding).not.toHaveBeenCalled()
  })

  it('creates a provisional venue when none exists and wizard data is sufficient', async () => {
    prisma.venue.findFirst.mockResolvedValue(null)
    onboardingProgress.getV2SetupDataForCompletion.mockResolvedValue({
      businessInfo: {
        name: 'Pelusis Café',
        type: 'RESTAURANT',
        venueType: 'RESTAURANT',
        timezone: 'America/Mexico_City',
        country: 'MX',
        address: '',
        city: '',
        state: '',
        zipCode: '',
        phone: '',
        email: '',
      },
      bankInfo: {},
      identityInfo: {},
      entityInfo: {},
    })
    venueCreation.createVenueFromOnboarding.mockResolvedValue({
      venue: { id: 'venue-new', slug: 'pelusis-cafe', status: 'ONBOARDING' },
    })

    const result = await ensureVenueForOnboarding('org-1', 'staff-1')
    expect(result?.id).toBe('venue-new')
    expect(venueCreation.createVenueFromOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        userId: 'staff-1',
        // Without explicit onboardingType, defaults to 'REAL' (production venue).
        // Demo trials go through a different path.
        onboardingType: 'REAL',
        businessInfo: expect.objectContaining({ name: 'Pelusis Café' }),
      }),
    )
  })

  it('returns null when no venue exists AND wizard data has no business name', async () => {
    // The user reached this endpoint too early — Step 2 (businessInfo) hasn't
    // been completed. Don't create a venue with garbage data; the wizard
    // will retry once they reach Step 3+.
    prisma.venue.findFirst.mockResolvedValue(null)
    onboardingProgress.getV2SetupDataForCompletion.mockResolvedValue({
      businessInfo: { name: '', type: '', venueType: '' },
      bankInfo: {},
      identityInfo: {},
      entityInfo: {},
    })

    const result = await ensureVenueForOnboarding('org-1', 'staff-1')
    expect(result).toBeNull()
    expect(venueCreation.createVenueFromOnboarding).not.toHaveBeenCalled()
  })

  it('also returns null when getV2SetupDataForCompletion throws (no progress)', async () => {
    prisma.venue.findFirst.mockResolvedValue(null)
    onboardingProgress.getV2SetupDataForCompletion.mockRejectedValue(
      new Error('No se encontro el progreso de onboarding'),
    )

    const result = await ensureVenueForOnboarding('org-1', 'staff-1')
    expect(result).toBeNull()
  })

  it('queries the first venue by createdAt ASC so multi-venue orgs get a stable pick', async () => {
    prisma.venue.findFirst.mockResolvedValue({ id: 'first-venue', slug: 'a', status: 'ACTIVE' })

    await ensureVenueForOnboarding('org-1', 'staff-1')

    expect(prisma.venue.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      select: { id: true, slug: true, status: true },
      orderBy: { createdAt: 'asc' },
    })
  })
})
