jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('@/services/access/access.service', () => ({
  hasPermission: () => true,
  getUserAccess: jest.fn(),
  createAccessCache: jest.fn(() => ({})),
}))

import { subscriptionState } from '../../../src/mcp/tools/billing'

const future = new Date('2030-01-01')
const past = new Date('2020-01-01')
const now = new Date('2026-06-04')
const base = { active: true, endDate: null, trialEndDate: null, suspendedAt: null, gracePeriodEndsAt: null }

describe('subscriptionState', () => {
  it('ACTIVE when active with no special dates', () => {
    expect(subscriptionState(base, now)).toBe('ACTIVE')
  })
  it('SUSPENDED takes priority over everything', () => {
    expect(subscriptionState({ ...base, suspendedAt: past, gracePeriodEndsAt: future, trialEndDate: future }, now)).toBe('SUSPENDED')
  })
  it('GRACE_PERIOD when grace end is in the future', () => {
    expect(subscriptionState({ ...base, gracePeriodEndsAt: future }, now)).toBe('GRACE_PERIOD')
  })
  it('TRIAL when trial end is in the future', () => {
    expect(subscriptionState({ ...base, trialEndDate: future }, now)).toBe('TRIAL')
  })
  it('INACTIVE when not active and no special dates', () => {
    expect(subscriptionState({ ...base, active: false }, now)).toBe('INACTIVE')
  })
  it('past grace/trial dates do not override ACTIVE', () => {
    expect(subscriptionState({ ...base, gracePeriodEndsAt: past, trialEndDate: past }, now)).toBe('ACTIVE')
  })
})
