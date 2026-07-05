import { canSubmitReview } from '../../../src/services/tpv/receiptReview.tpv.service'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    digitalReceipt: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn() },
  },
}))
jest.mock('../../../src/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(),
}))

import prisma from '../../../src/utils/prismaClient'
import { venueHasFeatureAccess } from '../../../src/services/access/basePlan.service'

const mockedPrisma = prisma as unknown as {
  digitalReceipt: { findUnique: jest.Mock }
  venueSettings: { findUnique: jest.Mock }
}
const mockedFeature = venueHasFeatureAccess as jest.Mock

describe('canSubmitReview status extension', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns reviewsEnabled=true + normalized googleReviewUrl for a PRO venue with a Place ID', async () => {
    mockedPrisma.digitalReceipt.findUnique.mockResolvedValue({
      paymentId: 'p1',
      payment: { venue: { id: 'v1', name: 'Alberto' }, review: null },
    })
    mockedFeature.mockResolvedValue(true)
    mockedPrisma.venueSettings.findUnique.mockResolvedValue({ googleReviewLink: 'ChIJ12345abc' })

    const r = await canSubmitReview('key-1')
    expect(r.canSubmit).toBe(true)
    expect(r.reviewsEnabled).toBe(true)
    expect(r.googleReviewUrl).toBe('https://search.google.com/local/writereview?placeid=ChIJ12345abc')
  })

  it('returns reviewsEnabled=false + null url for a FREE venue', async () => {
    mockedPrisma.digitalReceipt.findUnique.mockResolvedValue({
      paymentId: 'p1',
      payment: { venue: { id: 'v1', name: 'Alberto' }, review: null },
    })
    mockedFeature.mockResolvedValue(false)
    mockedPrisma.venueSettings.findUnique.mockResolvedValue({ googleReviewLink: 'ChIJ12345abc' })

    const r = await canSubmitReview('key-1')
    expect(r.reviewsEnabled).toBe(false)
    expect(r.googleReviewUrl).toBeNull()
  })

  it('returns null url when the venue has no link even if enabled', async () => {
    mockedPrisma.digitalReceipt.findUnique.mockResolvedValue({
      paymentId: 'p1',
      payment: { venue: { id: 'v1', name: 'Alberto' }, review: null },
    })
    mockedFeature.mockResolvedValue(true)
    mockedPrisma.venueSettings.findUnique.mockResolvedValue(null)

    const r = await canSubmitReview('key-1')
    expect(r.reviewsEnabled).toBe(true)
    expect(r.googleReviewUrl).toBeNull()
  })

  it('keeps canSubmit=false when a review already exists', async () => {
    mockedPrisma.digitalReceipt.findUnique.mockResolvedValue({
      paymentId: 'p1',
      payment: { venue: { id: 'v1', name: 'Alberto' }, review: { id: 'r1' } },
    })
    mockedFeature.mockResolvedValue(true)
    mockedPrisma.venueSettings.findUnique.mockResolvedValue({ googleReviewLink: null })

    const r = await canSubmitReview('key-1')
    expect(r.canSubmit).toBe(false)
    expect(r.reason).toBe('Review already submitted')
    expect(r.reviewsEnabled).toBe(true)
  })
})
