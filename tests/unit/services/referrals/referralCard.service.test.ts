import { generateWelcomeCard, generateTierUpCard, pngBufferToBase64DataUri } from '@/services/referrals/referralCard.service'

/**
 * Unit tests for the referral card PNG service.
 *
 * These tests run real Satori + resvg pipelines (no mocks) because
 * the value of this service is precisely the binary PNG it produces.
 * Mocking out the renderer would only verify glue code.
 *
 * Each test uses a generous timeout (15s) because the first render
 * warms the resvg native binding; subsequent renders are well under
 * 100ms but we don't want flaky CI.
 */
describe('referralCard.service', () => {
  it('generates a welcome card PNG buffer', async () => {
    const buf = await generateWelcomeCard({
      customerName: 'María',
      venueName: 'Mindform',
      referralCode: 'MINDFORM-MARI8K7',
      newCustomerDiscountPercent: 10,
    })

    expect(buf).toBeInstanceOf(Buffer)
    // Cards include user names, codes, and Spanish copy → a real PNG
    // is several KB. 1000 bytes is a generous sanity floor that still
    // catches a completely empty / broken render.
    expect(buf.length).toBeGreaterThan(1000)
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A — anchors the output is
    // really a PNG and not, say, the SVG by accident.
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  }, 15000)

  it('generates a tier-up card PNG buffer', async () => {
    const buf = await generateTierUpCard({
      customerName: 'Jose',
      venueName: 'Mindform',
      tier: 'TIER_1',
      tierLabel: 'Nivel 1',
      referralCount: 7,
      rewardPercent: 15,
      couponCode: 'MINDFORM-TIER1-ABC',
      validDays: 90,
    })

    expect(buf).toBeInstanceOf(Buffer)
    expect(buf.length).toBeGreaterThan(1000)
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  }, 15000)

  it('renders TIER_2 and TIER_3 cards without throwing', async () => {
    const tier2 = await generateTierUpCard({
      customerName: 'Ana',
      venueName: 'Mindform',
      tier: 'TIER_2',
      tierLabel: 'Nivel 2',
      referralCount: 15,
      rewardPercent: 25,
      couponCode: 'MINDFORM-TIER2-XYZ',
      validDays: 90,
    })
    const tier3 = await generateTierUpCard({
      customerName: 'Sofía',
      venueName: 'Mindform',
      tier: 'TIER_3',
      tierLabel: 'Nivel 3',
      referralCount: 30,
      rewardPercent: 50,
      couponCode: 'MINDFORM-TIER3-QQQ',
      validDays: 90,
    })

    // Defensive check that the tier-driven branching in the markup
    // builder doesn't silently produce an empty buffer.
    expect(tier2.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(tier3.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  }, 20000)

  it('converts PNG buffer to base64 data URI', () => {
    const fakeBuf = Buffer.from('test')
    const uri = pngBufferToBase64DataUri(fakeBuf)
    expect(uri).toBe('data:image/png;base64,dGVzdA==')
  })

  it('escapes user input to prevent JSX/HTML injection in cards', async () => {
    // Even if a customer name has angle brackets or curlies, the
    // renderer should still produce a valid PNG and not crash satori
    // by emitting raw JSX tokens.
    const buf = await generateWelcomeCard({
      customerName: 'María <script>',
      venueName: 'Mindform {evil}',
      referralCode: 'MINDFORM-X&Y',
      newCustomerDiscountPercent: 10,
    })
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  }, 15000)
})
