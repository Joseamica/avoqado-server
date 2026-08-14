import { FREE_TIER_CODES, PREMIUM_ONLY_CODES } from '@/services/access/basePlan.service'

describe('PROMOTIONS es una feature PRO', () => {
  // El gating es allow-by-default: lo que no está en ninguna lista es PRO+.
  it('🔴 no está en PREMIUM_ONLY_CODES — dejaría fuera a los PRO', () => {
    expect(PREMIUM_ONLY_CODES as readonly string[]).not.toContain('PROMOTIONS')
  })

  it('🔴 no está en FREE_TIER_CODES — regalaría una capacidad que se cobra', () => {
    expect(FREE_TIER_CODES as readonly string[]).not.toContain('PROMOTIONS')
  })
})
