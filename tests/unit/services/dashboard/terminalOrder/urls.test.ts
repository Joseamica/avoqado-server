import { buildStripeCheckoutUrls } from '@/services/dashboard/terminalOrder/urls'

describe('buildStripeCheckoutUrls', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    process.env.DASHBOARD_URL = 'https://dashboard.test'
    delete process.env.FRONTEND_URL
    delete process.env.APP_URL
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  describe('default (from === "tpv" or omitted)', () => {
    it('builds order-detail URLs when `from` is omitted', () => {
      const { successUrl, cancelUrl } = buildStripeCheckoutUrls({
        orderId: 'order-1',
        venueSlug: 'pelusis',
      })

      expect(successUrl).toBe('https://dashboard.test/venues/pelusis/tpv/orders/order-1?session_id={CHECKOUT_SESSION_ID}')
      expect(cancelUrl).toBe('https://dashboard.test/venues/pelusis/tpv?cancelled=true')
    })

    it('builds order-detail URLs when `from === "tpv"` explicitly', () => {
      const { successUrl, cancelUrl } = buildStripeCheckoutUrls({
        orderId: 'order-1',
        venueSlug: 'pelusis',
        from: 'tpv',
      })

      expect(successUrl).toContain('/venues/pelusis/tpv/orders/order-1')
      expect(cancelUrl).toContain('/venues/pelusis/tpv?cancelled=true')
    })
  })

  describe('from === "setup" (onboarding wizard)', () => {
    it('routes successUrl to /setup#step-8 with tpv_status=success', () => {
      const { successUrl } = buildStripeCheckoutUrls({
        orderId: 'order-1',
        venueSlug: 'pelusis',
        from: 'setup',
      })

      // success URL must:
      // 1. Land at /setup
      // 2. Carry tpv_status=success so the wizard hydrates View B
      // 3. Carry orderId so the wizard knows which order to render
      // 4. Anchor to #step-8 so the wizard jumps to the right step
      expect(successUrl).toContain('/setup')
      expect(successUrl).toContain('tpv_status=success')
      expect(successUrl).toContain('orderId=order-1')
      expect(successUrl).toContain('#step-8')
      // Must NOT leak the venue/order-detail path — that defeats the setup roundtrip
      expect(successUrl).not.toContain('/venues/pelusis/tpv/orders/order-1')
    })

    it('routes cancelUrl to /setup#step-8 with tpv_status=cancel', () => {
      const { cancelUrl } = buildStripeCheckoutUrls({
        orderId: 'order-1',
        venueSlug: 'pelusis',
        from: 'setup',
      })

      expect(cancelUrl).toContain('/setup')
      expect(cancelUrl).toContain('tpv_status=cancel')
      expect(cancelUrl).toContain('orderId=order-1')
      expect(cancelUrl).toContain('#step-8')
    })
  })

  describe('env var fallback', () => {
    it('falls back to FRONTEND_URL when DASHBOARD_URL is unset', () => {
      delete process.env.DASHBOARD_URL
      process.env.FRONTEND_URL = 'https://fallback.test'

      const { successUrl } = buildStripeCheckoutUrls({
        orderId: 'order-1',
        venueSlug: 'pelusis',
      })

      expect(successUrl).toMatch(/^https:\/\/fallback\.test\//)
    })
  })
})
