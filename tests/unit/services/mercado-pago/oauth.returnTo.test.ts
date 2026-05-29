import { signState, verifyState } from '../../../../src/services/mercado-pago/oauth.service'

describe('MP OAuth state — returnTo field', () => {
  beforeAll(() => {
    process.env.MP_OAUTH_STATE_SECRET = 'test-secret-min-32-chars-please-1234567890'
  })

  it('round-trips returnTo when set to "wizard"', () => {
    const token = signState({
      intent: 'connect_merchant',
      venueId: 'venue-1',
      ecommerceMerchantId: 'merch-1',
      staffId: 'staff-1',
      returnTo: 'wizard',
    })
    const verified = verifyState(token)
    expect(verified.returnTo).toBe('wizard')
  })

  it('omits returnTo when not provided (back-compat)', () => {
    const token = signState({
      intent: 'connect_merchant',
      venueId: 'venue-1',
      ecommerceMerchantId: 'merch-1',
      staffId: 'staff-1',
    })
    const verified = verifyState(token)
    expect(verified.returnTo).toBeUndefined()
  })
})
