import { parseV2Plan } from '../../../../src/services/onboarding/onboardingProgress.service'

describe('parseV2Plan', () => {
  it('returns null when no plan saved', () => {
    expect(parseV2Plan(null)).toBeNull()
    expect(parseV2Plan({ step2: {} })).toBeNull()
  })
  it('parses a complete plan', () => {
    expect(
      parseV2Plan({ plan: { paymentMethodId: 'pm_1', interval: 'annual', payNow: true, acceptedAt: '2026-06-02T00:00:00Z' } }),
    ).toEqual({ tier: 'PRO', paymentMethodId: 'pm_1', interval: 'annual', payNow: true, acceptedAt: '2026-06-02T00:00:00Z' })
  })
  it('defaults interval to monthly and payNow to false when partial', () => {
    expect(parseV2Plan({ plan: { paymentMethodId: 'pm_1' } })).toEqual({
      tier: 'PRO',
      paymentMethodId: 'pm_1',
      interval: 'monthly',
      payNow: false,
      acceptedAt: null,
    })
  })

  // 4-tier plan step (2026-06): the wizard persists `tier` (FREE | PRO | PREMIUM).
  // Old payloads have no tier → default to PRO (the step used to be a single Pro offer).
  it('parses FREE and PREMIUM tiers', () => {
    expect(parseV2Plan({ plan: { tier: 'FREE', acceptedAt: '2026-06-10T00:00:00Z' } })).toEqual({
      tier: 'FREE',
      paymentMethodId: null,
      interval: 'monthly',
      payNow: false,
      acceptedAt: '2026-06-10T00:00:00Z',
    })
    expect(parseV2Plan({ plan: { tier: 'PREMIUM', paymentMethodId: 'pm_p', interval: 'annual', payNow: true } })).toMatchObject({
      tier: 'PREMIUM',
      paymentMethodId: 'pm_p',
      interval: 'annual',
      payNow: true,
    })
  })
  it('defaults unknown tier values to PRO (back-compat)', () => {
    expect(parseV2Plan({ plan: { tier: 'ENTERPRISE', paymentMethodId: 'pm_1' } })).toMatchObject({ tier: 'PRO' })
    expect(parseV2Plan({ plan: { tier: 42, paymentMethodId: 'pm_1' } })).toMatchObject({ tier: 'PRO' })
  })

  // REGRESSION (full-testing 2026-06-02): the wizard saves plan data via the generic
  // per-step endpoint, which nests it under the positional key (step10.plan). parseV2Plan
  // must resolve it there, not only at a top-level `plan` key — otherwise completeV2 hard-gates
  // with 400 "Falta el método de pago del plan" even though the card was captured.
  it('resolves plan nested under step10 (positional save)', () => {
    expect(
      parseV2Plan({
        step2: { businessName: 'X' },
        step10: { plan: { paymentMethodId: 'pm_nested', interval: 'monthly', payNow: false } },
      }),
    ).toEqual({ tier: 'PRO', paymentMethodId: 'pm_nested', interval: 'monthly', payNow: false, acceptedAt: null })
  })

  // REGRESSION: the plan step's number shifts with which optional steps are enabled,
  // so plan can land under step8/step9/step10. parseV2Plan must find it regardless of position.
  it('resolves plan nested under a different step number (flag-dependent position)', () => {
    expect(parseV2Plan({ step9: { plan: { paymentMethodId: 'pm_9', interval: 'annual', payNow: true } } })).toEqual({
      tier: 'PRO',
      paymentMethodId: 'pm_9',
      interval: 'annual',
      payNow: true,
      acceptedAt: null,
    })
  })
})
