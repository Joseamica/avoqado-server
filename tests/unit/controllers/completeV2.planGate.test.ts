import { parseV2Plan } from '../../../src/services/onboarding/onboardingProgress.service'

describe('plan hard-gate decision', () => {
  function gateRejects(v2SetupData: unknown): boolean {
    const plan = parseV2Plan(v2SetupData)
    return !plan?.paymentMethodId
  }
  it('rejects when no plan/paymentMethodId', () => {
    expect(gateRejects({ step2: {} })).toBe(true)
    expect(gateRejects({ plan: { interval: 'monthly' } })).toBe(true)
  })
  it('allows when paymentMethodId present', () => {
    expect(gateRejects({ plan: { paymentMethodId: 'pm_1', interval: 'monthly', payNow: false } })).toBe(false)
  })
})
