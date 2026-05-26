import { rateCorrectionBodySchema } from '@/schemas/superadmin/rateCorrection.schema'

describe('rateCorrectionBodySchema', () => {
  it('accepts a valid body with venue rates', () => {
    const r = rateCorrectionBodySchema.safeParse({
      accountType: 'PRIMARY',
      newVenueRates: {
        debitRate: 0.02,
        creditRate: 0.055,
        amexRate: 0.04,
        internationalRate: 0.045,
        includesTax: true,
      },
      missingCostMode: 'FIX_PAYMENT_ONLY',
    })
    expect(r.success).toBe(true)
  })

  it('accepts a valid body with only provider rates', () => {
    const r = rateCorrectionBodySchema.safeParse({
      accountType: 'PRIMARY',
      newProviderRates: {
        debitRate: 0.01,
        creditRate: 0.02,
        amexRate: 0.025,
        internationalRate: 0.03,
      },
      missingCostMode: 'FIX_PAYMENT_ONLY',
    })
    expect(r.success).toBe(true)
  })

  it('rejects when both rate sets are omitted', () => {
    const r = rateCorrectionBodySchema.safeParse({
      accountType: 'PRIMARY',
      missingCostMode: 'FIX_PAYMENT_ONLY',
    })
    expect(r.success).toBe(false)
  })

  it('rejects an out-of-range rate', () => {
    const r = rateCorrectionBodySchema.safeParse({
      accountType: 'PRIMARY',
      newVenueRates: {
        debitRate: 2,
        creditRate: 0.05,
        amexRate: 0.04,
        internationalRate: 0.045,
      },
      missingCostMode: 'FIX_PAYMENT_ONLY',
    })
    expect(r.success).toBe(false)
  })
})
