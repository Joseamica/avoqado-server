import { parseV2Step9 } from '../../../../src/services/onboarding/onboardingProgress.service'

describe('V2 step 9 (tpv purchase)', () => {
  it('returns null when v2SetupData has no step9', () => {
    expect(parseV2Step9(null)).toBeNull()
    expect(parseV2Step9({ step2: { businessName: 'X' } })).toBeNull()
  })

  it('returns a typed object when step9 is present (nested tpvPurchase shape)', () => {
    const result = parseV2Step9({
      step9: {
        tpvPurchase: {
          tpvOrderId: 'order-1',
          skipped: false,
          lastUpdatedAt: '2026-05-29T12:00:00Z',
        },
      },
    })
    expect(result).toEqual({
      tpvOrderId: 'order-1',
      skipped: false,
      lastUpdatedAt: '2026-05-29T12:00:00Z',
    })
  })

  it('accepts the flat shape (forward-compat with direct writes under step9)', () => {
    const result = parseV2Step9({
      step9: {
        tpvOrderId: 'order-1',
        skipped: false,
        lastUpdatedAt: '2026-05-29T12:00:00Z',
      },
    })
    expect(result).toEqual({
      tpvOrderId: 'order-1',
      skipped: false,
      lastUpdatedAt: '2026-05-29T12:00:00Z',
    })
  })

  it('defaults missing fields when step9 is partial', () => {
    const result = parseV2Step9({ step9: { tpvPurchase: { skipped: true } } })
    expect(result).toEqual({
      tpvOrderId: null,
      skipped: true,
      lastUpdatedAt: null,
    })
  })

  it('handles the skipped state where tpvOrderId is null', () => {
    const result = parseV2Step9({
      step9: { tpvPurchase: { tpvOrderId: null, skipped: true, lastUpdatedAt: '2026-05-29T12:00:00Z' } },
    })
    expect(result?.tpvOrderId).toBeNull()
    expect(result?.skipped).toBe(true)
  })
})
