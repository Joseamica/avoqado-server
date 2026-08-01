import { recordPaymentBodySchema } from '@/schemas/tpv.schema'

const cardPayment = {
  venueId: 'cmn3acoxt000mn227k1vdgj95',
  amount: 44000,
  tip: 0,
  status: 'COMPLETED',
  method: 'CREDIT_CARD',
  source: 'TPV',
  splitType: 'FULLPAYMENT',
  staffId: 'staff-1',
  paidProductsId: [],
  currency: 'MXN',
  merchantAccountId: 'cmn3a6xr8000kn227eg8zeh41',
  maskedPan: '477291******5280',
}

describe('recordPaymentBodySchema internationality evidence', () => {
  it('keeps old TPV payloads valid and defaults the legacy boolean', () => {
    const parsed = recordPaymentBodySchema.parse({ body: cardPayment })

    expect(parsed.body.isInternational).toBe(false)
    expect(parsed.body.issuerCountryCode).toBeUndefined()
    expect(parsed.body.issuerCountrySource).toBeUndefined()
  })

  it('accepts additive EMV evidence without changing the legacy boolean', () => {
    const parsed = recordPaymentBodySchema.parse({
      body: {
        ...cardPayment,
        isInternational: true,
        issuerCountryCode: '0840',
        issuerCountrySource: 'EMV_5F28',
      },
    })

    expect(parsed.body.isInternational).toBe(true)
    expect(parsed.body.issuerCountryCode).toBe('0840')
    expect(parsed.body.issuerCountrySource).toBe('EMV_5F28')
  })

  it('discards malformed shadow evidence instead of blocking the payment', () => {
    const parsed = recordPaymentBodySchema.parse({
      body: {
        ...cardPayment,
        issuerCountryCode: 'THIS-IS-NOT-A-COUNTRY-CODE',
        issuerCountrySource: 'SDK_GUESS',
      },
    })

    expect(parsed.body.issuerCountryCode).toBeUndefined()
    expect(parsed.body.issuerCountrySource).toBeUndefined()
  })
})
