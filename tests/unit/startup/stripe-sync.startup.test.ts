jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    feature: {
      count: jest.fn(),
    },
  },
}))

jest.mock('@/services/stripe.service', () => ({
  syncFeaturesToStripe: jest.fn(),
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

import logger from '@/config/logger'
import { syncFeaturesToStripe } from '@/services/stripe.service'
import { ensureFeaturesAreSyncedToStripe } from '@/startup/stripe-sync.startup'
import prisma from '@/utils/prismaClient'

const countFeatures = prisma.feature.count as jest.MockedFunction<typeof prisma.feature.count>
const syncFeatures = syncFeaturesToStripe as jest.MockedFunction<typeof syncFeaturesToStripe>

describe('Stripe feature sync startup boundary', () => {
  const originalDemoMode = process.env.DEMO_MODE
  const originalStripeSecret = process.env.STRIPE_SECRET_KEY

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.STRIPE_SECRET_KEY = 'sk_test_deliberately_not_called'
    delete process.env.DEMO_MODE
  })

  afterAll(() => {
    if (originalDemoMode === undefined) delete process.env.DEMO_MODE
    else process.env.DEMO_MODE = originalDemoMode

    if (originalStripeSecret === undefined) delete process.env.STRIPE_SECRET_KEY
    else process.env.STRIPE_SECRET_KEY = originalStripeSecret
  })

  it('performs no database or Stripe work in DEMO_MODE', async () => {
    process.env.DEMO_MODE = 'true'

    await expect(ensureFeaturesAreSyncedToStripe()).resolves.toBe(false)

    expect(countFeatures).not.toHaveBeenCalled()
    expect(syncFeatures).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith('⏭️  Stripe sync skipped: DEMO_MODE=true')
  })

  it('preserves the existing non-demo sync path', async () => {
    countFeatures.mockResolvedValueOnce(3).mockResolvedValueOnce(2)
    syncFeatures.mockResolvedValueOnce([])

    await expect(ensureFeaturesAreSyncedToStripe()).resolves.toBe(true)

    expect(countFeatures).toHaveBeenCalledTimes(2)
    expect(syncFeatures).toHaveBeenCalledTimes(1)
  })
})
