import {
  buildWelcomeShareDeepLink,
  buildWelcomeShareMessage,
  buildTierUpAdminShareLink,
  buildTierUpAdminShareMessage,
} from '@/services/referrals/referralWhatsApp.service'

/**
 * Unit tests for the referral WhatsApp deep-link helpers (Plan 4 / Path B).
 *
 * These functions are pure — no I/O, no DB — so the tests are straight
 * input → output. We still cover defensive cases (phone formatting,
 * missing phone, special characters) because the strings end up in
 * user-tappable URLs.
 */
describe('referralWhatsApp.service', () => {
  describe('buildWelcomeShareMessage', () => {
    it('contains the venue name, code, and discount percent', () => {
      const msg = buildWelcomeShareMessage({
        venueName: 'Mindform',
        referralCode: 'MINDFORM-MARI8K7',
        newCustomerDiscountPercent: 15,
      })
      expect(msg).toContain('Mindform')
      expect(msg).toContain('MINDFORM-MARI8K7')
      expect(msg).toContain('15%')
    })
  })

  describe('buildWelcomeShareDeepLink', () => {
    it('returns a generic share URL when no phone is provided', () => {
      const url = buildWelcomeShareDeepLink({
        venueName: 'Mindform',
        referralCode: 'MINDFORM-MARI8K7',
        newCustomerDiscountPercent: 10,
      })
      expect(url.startsWith('https://wa.me/?text=')).toBe(true)
      // The encoded text should include the code so the recipient sees it
      // when the share sheet opens.
      expect(decodeURIComponent(url.split('?text=')[1])).toContain('MINDFORM-MARI8K7')
    })

    it('returns a recipient-targeted URL when phone is provided', () => {
      const url = buildWelcomeShareDeepLink({
        venueName: 'Mindform',
        referralCode: 'MINDFORM-MARI8K7',
        newCustomerDiscountPercent: 10,
        phone: '+5215512345678',
      })
      // Phone must be embedded in the path, digits only (no +), before ?text=
      expect(url.startsWith('https://wa.me/5215512345678?text=')).toBe(true)
    })

    it('strips non-digit characters from the phone (E.164 normalization)', () => {
      const url = buildWelcomeShareDeepLink({
        venueName: 'Mindform',
        referralCode: 'MINDFORM-MARI8K7',
        newCustomerDiscountPercent: 10,
        phone: '+52 (155) 1234-5678',
      })
      expect(url.startsWith('https://wa.me/5215512345678?text=')).toBe(true)
    })

    it('encodes the message body so accents and special characters survive a round-trip', () => {
      const url = buildWelcomeShareDeepLink({
        venueName: 'Café Ñ',
        referralCode: 'CAFE-ABC123',
        newCustomerDiscountPercent: 20,
      })
      // %C3%A9 = é, %C3%91 = Ñ
      expect(url).toContain('%C3%A9')
      expect(url).toContain('%C3%91')
      // Round-trip the encoded text and ensure the literal characters survive.
      const decoded = decodeURIComponent(url.split('?text=')[1])
      expect(decoded).toContain('Café Ñ')
      // Asterisks are deliberate WhatsApp bold markdown and must reach the user.
      expect(decoded).toContain('*CAFE-ABC123*')
    })

    it('treats an empty-string phone as no phone (generic share)', () => {
      const url = buildWelcomeShareDeepLink({
        venueName: 'Mindform',
        referralCode: 'MINDFORM-MARI8K7',
        newCustomerDiscountPercent: 10,
        phone: '   ',
      })
      expect(url.startsWith('https://wa.me/?text=')).toBe(true)
    })
  })

  describe('buildTierUpAdminShareMessage', () => {
    it('contains the customer name, tier label, coupon code, and valid days', () => {
      const msg = buildTierUpAdminShareMessage({
        customerName: 'Jose',
        venueName: 'Mindform',
        tierLabel: 'Nivel Oro',
        rewardPercent: 25,
        couponCode: 'JOSE-GOLD-2026',
        validDays: 30,
      })
      expect(msg).toContain('Jose')
      expect(msg).toContain('Nivel Oro')
      expect(msg).toContain('Mindform')
      expect(msg).toContain('25%')
      expect(msg).toContain('JOSE-GOLD-2026')
      expect(msg).toContain('30 días')
    })
  })

  describe('buildTierUpAdminShareLink', () => {
    it('builds a wa.me link with the customer phone digits-only and pre-filled message', () => {
      const url = buildTierUpAdminShareLink({
        customerPhone: '+52 155 1234 5678',
        customerName: 'Jose',
        venueName: 'Mindform',
        tier: 'TIER_2',
        tierLabel: 'Nivel Oro',
        rewardPercent: 25,
        couponCode: 'JOSE-GOLD-2026',
        validDays: 30,
      })
      expect(url.startsWith('https://wa.me/5215512345678?text=')).toBe(true)
      const decoded = decodeURIComponent(url.split('?text=')[1])
      expect(decoded).toContain('Nivel Oro')
      expect(decoded).toContain('JOSE-GOLD-2026')
      expect(decoded).toContain('30 días')
    })

    it('handles a phone already in digits-only E.164 form', () => {
      const url = buildTierUpAdminShareLink({
        customerPhone: '5215512345678',
        customerName: 'Ana',
        venueName: 'Mindform',
        tier: 'TIER_1',
        tierLabel: 'Nivel Plata',
        rewardPercent: 10,
        couponCode: 'ANA-SILVER',
        validDays: 14,
      })
      expect(url.startsWith('https://wa.me/5215512345678?text=')).toBe(true)
    })
  })
})
