// FRONTEND_URL comes from the validated config (src/config/env.ts), parsed once at import: the test drives it through
// this mutable mock instead of process.env.
const mockEnv = { FRONTEND_URL: 'https://dashboard.avoqado.io' }
jest.mock('@/config/env', () => mockEnv)

import { billingPageUrl } from '@/utils/dashboardLinks'

describe('billingPageUrl', () => {
  beforeEach(() => {
    mockEnv.FRONTEND_URL = 'https://dashboard.avoqado.io'
  })

  it('points at the real Plan page of the venue', () => {
    expect(billingPageUrl('mi-cafe')).toBe('https://dashboard.avoqado.io/venues/mi-cafe/settings/billing/subscriptions')
  })

  it('keeps a query', () => {
    expect(billingPageUrl('mi-cafe', '?winback=1')).toBe(
      'https://dashboard.avoqado.io/venues/mi-cafe/settings/billing/subscriptions?winback=1',
    )
  })

  it('without a slug lets the dashboard pick the default venue', () => {
    expect(billingPageUrl(null)).toBe('https://dashboard.avoqado.io/go/settings/billing/subscriptions')
    expect(billingPageUrl()).toBe('https://dashboard.avoqado.io/go/settings/billing/subscriptions')
  })

  it('uses the configured FRONTEND_URL (the same value the rest of the server reads)', () => {
    mockEnv.FRONTEND_URL = 'https://dashboardv2.avoqado.io'
    expect(billingPageUrl('x')).toBe('https://dashboardv2.avoqado.io/venues/x/settings/billing/subscriptions')
  })
})
