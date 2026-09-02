import { assertCommercialV2CheckoutActive } from '@/services/commercial/commercialV2CheckoutPolicy.service'

describe('commercial v2 checkout rollout policy', () => {
  it.each(['OFF', 'SHADOW', 'ALLOWLIST'] as const)('keeps %s mode closed with the stable public error', mode => {
    expect(() => assertCommercialV2CheckoutActive(mode)).toThrow(
      expect.objectContaining({
        code: 'COMMERCIAL_V2_CHECKOUT_DISABLED',
        statusCode: 503,
      }),
    )
  })

  it('defaults to OFF when no mode is supplied', () => {
    expect(() => assertCommercialV2CheckoutActive()).toThrow(expect.objectContaining({ code: 'COMMERCIAL_V2_CHECKOUT_DISABLED' }))
  })

  it('allows checkout only in ACTIVE mode', () => {
    expect(() => assertCommercialV2CheckoutActive('ACTIVE')).not.toThrow()
  })
})
