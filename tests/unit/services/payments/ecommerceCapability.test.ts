/**
 * ecommerceCapability — single source of truth for "can this venue charge online?".
 * Gates the booking widget's money surfaces (reservation deposits + credit packs).
 *
 * Tests: the per-provider chargeable predicate (Stripe/MP via chargesEnabled,
 * Blumon via accessToken) and canVenueChargeOnline (has a chargeable Stripe
 * Connect merchant), including multi-tenant scoping of the query.
 */
import { prismaMock } from '../../../__helpers__/setup'
import {
  isEcommerceMerchantChargeable,
  resolveChargeableStripeMerchant,
  canVenueChargeOnline,
} from '../../../../src/services/payments/ecommerceCapability'

const VENUE_ID = 'venue-cap-1'

describe('ecommerceCapability', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('isEcommerceMerchantChargeable', () => {
    it('STRIPE_CONNECT is chargeable only when chargesEnabled', () => {
      expect(isEcommerceMerchantChargeable({ chargesEnabled: true, providerCredentials: {}, provider: { code: 'STRIPE_CONNECT' } })).toBe(
        true,
      )
      expect(isEcommerceMerchantChargeable({ chargesEnabled: false, providerCredentials: {}, provider: { code: 'STRIPE_CONNECT' } })).toBe(
        false,
      )
    })

    it('MERCADO_PAGO is chargeable only when chargesEnabled', () => {
      expect(isEcommerceMerchantChargeable({ chargesEnabled: true, providerCredentials: {}, provider: { code: 'MERCADO_PAGO' } })).toBe(
        true,
      )
      expect(isEcommerceMerchantChargeable({ chargesEnabled: false, providerCredentials: {}, provider: { code: 'MERCADO_PAGO' } })).toBe(
        false,
      )
    })

    it('BLUMON reads readiness from a non-empty accessToken (ignores chargesEnabled)', () => {
      expect(
        isEcommerceMerchantChargeable({
          chargesEnabled: false,
          providerCredentials: { accessToken: 'tok_123' },
          provider: { code: 'BLUMON' },
        }),
      ).toBe(true)
      expect(
        isEcommerceMerchantChargeable({ chargesEnabled: true, providerCredentials: { accessToken: '' }, provider: { code: 'BLUMON' } }),
      ).toBe(false)
      expect(isEcommerceMerchantChargeable({ chargesEnabled: true, providerCredentials: null, provider: { code: 'BLUMON' } })).toBe(false)
    })
  })

  describe('resolveChargeableStripeMerchant', () => {
    it('queries for an active, charges-enabled STRIPE_CONNECT merchant scoped to the venue', async () => {
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(null)

      await resolveChargeableStripeMerchant(VENUE_ID)

      expect(prismaMock.ecommerceMerchant.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            venueId: VENUE_ID,
            active: true,
            chargesEnabled: true,
            provider: { code: 'STRIPE_CONNECT', active: true },
          },
          include: { provider: true },
          orderBy: { createdAt: 'desc' },
        }),
      )
    })
  })

  describe('canVenueChargeOnline', () => {
    it('true when a chargeable Stripe merchant exists', async () => {
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValue({ id: 'ecm-1', provider: { code: 'STRIPE_CONNECT' } })
      await expect(canVenueChargeOnline(VENUE_ID)).resolves.toBe(true)
    })

    it('false when none exists', async () => {
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(null)
      await expect(canVenueChargeOnline(VENUE_ID)).resolves.toBe(false)
    })
  })
})
