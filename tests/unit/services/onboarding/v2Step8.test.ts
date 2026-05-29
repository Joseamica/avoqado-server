import { parseV2Step8 } from '../../../../src/services/onboarding/onboardingProgress.service'

describe('V2 step 8 (payment providers)', () => {
  it('returns null when v2SetupData has no step8', () => {
    expect(parseV2Step8(null)).toBeNull()
    expect(parseV2Step8({ step2: { businessName: 'X' } })).toBeNull()
  })

  it('returns a typed object when step8 is present', () => {
    const result = parseV2Step8({
      step8: {
        mpMerchantId: 'mp-1',
        stripeMerchantId: null,
        skipped: false,
        lastUpdatedAt: '2026-05-27T12:00:00Z',
      },
    })
    expect(result).toEqual({
      mpMerchantId: 'mp-1',
      stripeMerchantId: null,
      skipped: false,
      lastUpdatedAt: '2026-05-27T12:00:00Z',
    })
  })

  it('defaults missing fields when step8 is partial', () => {
    const result = parseV2Step8({ step8: { mpMerchantId: 'mp-1' } })
    expect(result).toEqual({
      mpMerchantId: 'mp-1',
      stripeMerchantId: null,
      skipped: false,
      lastUpdatedAt: null,
    })
  })
})
