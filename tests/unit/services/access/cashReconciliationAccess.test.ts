/**
 * Production change that makes this suite pass: effective runtime access is the paid Feature gate
 * AND a raw default-off VenueSettings opt-in, with fail-closed error handling.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venueSettings: { findUnique: jest.fn() } },
}))

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { CASH_RECONCILIATION_FEATURE, isCashReconciliationEnabled } from '@/services/access/cashReconciliationAccess.service'

const findSettings = (prisma as any).venueSettings.findUnique as jest.Mock
const hasFeature = venueHasFeatureAccess as jest.MockedFunction<typeof venueHasFeatureAccess>

describe('isCashReconciliationEnabled', () => {
  beforeEach(() => jest.clearAllMocks())

  it('uses the exact Feature code and enables only when both gates are true', async () => {
    findSettings.mockResolvedValue({ cashReconciliationEnabled: true })
    hasFeature.mockResolvedValue(true)

    await expect(isCashReconciliationEnabled('venue-1')).resolves.toBe(true)
    expect(hasFeature).toHaveBeenCalledWith('venue-1', 'CASH_RECONCILIATION')
    expect(CASH_RECONCILIATION_FEATURE).toBe('CASH_RECONCILIATION')
  })

  it.each([
    ['raw opt-in off', { cashReconciliationEnabled: false }],
    ['missing VenueSettings row', null],
  ])('is false for %s and short-circuits the paid gate', async (_label, settings) => {
    findSettings.mockResolvedValue(settings)

    await expect(isCashReconciliationEnabled('venue-1')).resolves.toBe(false)
    expect(hasFeature).not.toHaveBeenCalled()
  })

  it('is false when the raw setting is on but the Feature is not entitled', async () => {
    findSettings.mockResolvedValue({ cashReconciliationEnabled: true })
    hasFeature.mockResolvedValue(false)

    await expect(isCashReconciliationEnabled('venue-1')).resolves.toBe(false)
  })

  it.each(['settings lookup', 'entitlement lookup'])('fails closed when %s throws', async failurePoint => {
    if (failurePoint === 'settings lookup') {
      findSettings.mockRejectedValue(new Error('database unavailable'))
    } else {
      findSettings.mockResolvedValue({ cashReconciliationEnabled: true })
      hasFeature.mockRejectedValue(new Error('entitlement unavailable'))
    }

    await expect(isCashReconciliationEnabled('venue-1')).resolves.toBe(false)
  })
})
