import { parseV2Plan } from '../../../src/services/onboarding/onboardingProgress.service'

describe('plan hard-gate decision', () => {
  // Mirrors completeV2Onboarding's gate: a saved plan step is mandatory; paid tiers
  // (PRO/PREMIUM — incl. legacy payloads without `tier`) also require a payment method.
  // FREE completes without a card.
  function gateRejects(v2SetupData: unknown): boolean {
    const plan = parseV2Plan(v2SetupData)
    if (!plan) return true
    return plan.tier !== 'FREE' && !plan.paymentMethodId
  }
  it('rejects when no plan/paymentMethodId', () => {
    expect(gateRejects({ step2: {} })).toBe(true)
    expect(gateRejects({ plan: { interval: 'monthly' } })).toBe(true)
  })
  it('allows when paymentMethodId present', () => {
    expect(gateRejects({ plan: { paymentMethodId: 'pm_1', interval: 'monthly', payNow: false } })).toBe(false)
  })
  it('allows FREE without a paymentMethodId', () => {
    expect(gateRejects({ plan: { tier: 'FREE', acceptedAt: '2026-06-10T00:00:00Z' } })).toBe(false)
  })
  it('rejects PREMIUM without a paymentMethodId', () => {
    expect(gateRejects({ plan: { tier: 'PREMIUM', interval: 'monthly' } })).toBe(true)
  })
})
