jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { venueFeature: { findFirst: jest.fn() } },
}))
import prisma from '../../../../src/utils/prismaClient'
import { venueHasActiveBasePlan } from '../../../../src/services/access/basePlan.service'

const mock = (prisma as any).venueFeature.findFirst
beforeEach(() => jest.clearAllMocks())

describe('venueHasActiveBasePlan', () => {
  it('true when PLAN_PRO active, not suspended, trial in future', async () => {
    mock.mockResolvedValue({ active: true, suspendedAt: null, endDate: new Date(Date.now() + 86400000) })
    expect(await venueHasActiveBasePlan('v1')).toBe(true)
  })
  it('true when PLAN_PRO active paid (endDate null)', async () => {
    mock.mockResolvedValue({ active: true, suspendedAt: null, endDate: null })
    expect(await venueHasActiveBasePlan('v1')).toBe(true)
  })
  it('false when no PLAN_PRO row', async () => {
    mock.mockResolvedValue(null)
    expect(await venueHasActiveBasePlan('v1')).toBe(false)
  })
  it('false when suspended (payment failed)', async () => {
    mock.mockResolvedValue({ active: false, suspendedAt: new Date(), endDate: null })
    expect(await venueHasActiveBasePlan('v1')).toBe(false)
  })
  it('false when trial expired', async () => {
    mock.mockResolvedValue({ active: true, suspendedAt: null, endDate: new Date(Date.now() - 86400000) })
    expect(await venueHasActiveBasePlan('v1')).toBe(false)
  })
})
