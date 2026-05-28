/**
 * Tests for `sendNewVenueOnboardingDigest` — the admin-team digest mailed to
 * hola@avoqado.io whenever a REAL venue completes onboarding.
 *
 * Reproduces the regression behind 2026-05-27 incident: a new venue (Gibran's
 * AUTO DETAILING MEXA) finished onboarding without uploading KYC docs, so the
 * legacy notifier short-circuited and nobody got an email. The digest fixes
 * that by firing unconditionally for REAL onboarding.
 */
const mockSend = jest.fn()

// Resend must be a function-style constructor for the SUT's `new Resend(...)`.
jest.mock('resend', () => ({
  __esModule: true,
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}))

describe('sendNewVenueOnboardingDigest', () => {
  const buildData = (overrides: Partial<any> = {}) => ({
    venueId: 'cmpnplqwe0015no1s156beoay',
    venueName: 'AUTO DETAILING MEXA',
    venueSlug: 'auto-detailing-mexa',
    venueStatus: 'ONBOARDING',
    kycStatus: 'NOT_SUBMITTED',
    hasKycDocuments: false,
    businessInfo: {
      phone: '+526648442154',
      email: 'gerencia@autodetailing.mx',
      address: 'Claveles & Juan Carrillo',
      city: 'Ensenada',
      state: 'Baja California',
      country: 'MX',
      zipCode: '22785',
      entityType: 'PERSONA_FISICA',
    },
    owner: {
      firstName: 'Gibran',
      lastName: 'Chavez',
      email: 'gibrangonzalez0303@gmail.com',
      phone: '+526648442154',
    },
    paymentInfo: {
      clabe: '638180000162210392',
      bankName: 'NU Mexico (SOFIPO)',
      accountHolder: 'Gibran gonzalez',
    },
    ...overrides,
  })

  beforeEach(() => {
    jest.resetModules()
    mockSend.mockReset()
    delete process.env.RESEND_API_KEY
    delete process.env.ONBOARDING_NOTIFICATIONS_EMAIL
  })

  it('returns false and skips sending when RESEND_API_KEY is not configured', async () => {
    // No RESEND_API_KEY → module init leaves the Resend client as null.
    const mod = await import('../../../src/services/resend.service')

    const result = await mod.sendNewVenueOnboardingDigest(buildData())

    expect(result).toBe(false)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('emails onboarding@avoqado.io with the venue, owner, and bank details', async () => {
    process.env.RESEND_API_KEY = 're_test_key'
    mockSend.mockResolvedValue({ data: { id: 'resend-1' }, error: null })
    const mod = await import('../../../src/services/resend.service')

    const result = await mod.sendNewVenueOnboardingDigest(buildData())

    expect(result).toBe(true)
    expect(mockSend).toHaveBeenCalledTimes(1)
    const args = mockSend.mock.calls[0][0]
    expect(args.to).toBe('onboarding@avoqado.io')
    expect(args.subject).toContain('AUTO DETAILING MEXA')
    expect(args.subject).toContain('Ensenada')
    // Both HTML and plain-text variants are sent — verify all the info ended up
    // somewhere the team can read it.
    const bodies = `${args.html}\n${args.text}`
    expect(bodies).toContain('AUTO DETAILING MEXA')
    expect(bodies).toContain('gibrangonzalez0303@gmail.com')
    expect(bodies).toContain('+526648442154')
    expect(bodies).toContain('638180000162210392') // CLABE
    expect(bodies).toContain('NU Mexico (SOFIPO)')
    expect(bodies).toContain('PERSONA_FISICA')
  })

  // -------------------------------------------------------------------------
  // EMAIL_STANDARDS.md compliance — every customer-visible/admin email must
  // match the Avoqado design system (logo header+footer, black CTA, no
  // emoji in subject). See docs/guides/EMAIL_STANDARDS.md.
  // -------------------------------------------------------------------------
  describe('Avoqado email-design compliance', () => {
    beforeEach(() => {
      process.env.RESEND_API_KEY = 're_test_key'
      mockSend.mockResolvedValue({ data: { id: 'resend-design' }, error: null })
    })

    it('subject does not contain emoji', async () => {
      const mod = await import('../../../src/services/resend.service')
      await mod.sendNewVenueOnboardingDigest(buildData())
      const subject: string = mockSend.mock.calls[0][0].subject
      // Match any extended pictographic / symbol code point.
      expect(subject).not.toMatch(/\p{Extended_Pictographic}/u)
    })

    it('HTML embeds the Avoqado isotipo twice (header + footer)', async () => {
      const mod = await import('../../../src/services/resend.service')
      await mod.sendNewVenueOnboardingDigest(buildData())
      const html: string = mockSend.mock.calls[0][0].html
      const matches = html.match(/avoqado\.io\/isotipo\.svg/g) || []
      expect(matches.length).toBeGreaterThanOrEqual(2)
    })

    it('CTA button uses black background (#000000), not a brand color', async () => {
      const mod = await import('../../../src/services/resend.service')
      await mod.sendNewVenueOnboardingDigest(buildData())
      const html: string = mockSend.mock.calls[0][0].html
      expect(html).toMatch(/background-color:\s*#000000/i)
      // Defensive: nothing in the digest should leak the legacy purple gradient.
      expect(html).not.toMatch(/linear-gradient/i)
    })

    it('footer carries the legal-entity line', async () => {
      const mod = await import('../../../src/services/resend.service')
      await mod.sendNewVenueOnboardingDigest(buildData())
      const html: string = mockSend.mock.calls[0][0].html
      expect(html).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
    })

    it('plain-text body is non-empty and includes the title', async () => {
      const mod = await import('../../../src/services/resend.service')
      await mod.sendNewVenueOnboardingDigest(buildData())
      const text: string = mockSend.mock.calls[0][0].text
      expect(text.length).toBeGreaterThan(50)
      expect(text).toContain('Nuevo venue en onboarding')
    })

    // -----------------------------------------------------------------------
    // WhatsApp deep links — business and owner phones should render as
    // wa.me links so the team can one-click contact the new lead.
    // -----------------------------------------------------------------------
    it('business phone renders as a wa.me link with country code stripped', async () => {
      const mod = await import('../../../src/services/resend.service')
      // E.164 input (`+526648442154`) → wa.me/526648442154 (no plus).
      await mod.sendNewVenueOnboardingDigest(buildData())
      const html: string = mockSend.mock.calls[0][0].html
      expect(html).toContain('https://wa.me/526648442154')
      // Display text should still show the original E.164 number.
      expect(html).toContain('+526648442154')
    })

    it('owner phone renders as a wa.me link too', async () => {
      const mod = await import('../../../src/services/resend.service')
      await mod.sendNewVenueOnboardingDigest(buildData())
      const html: string = mockSend.mock.calls[0][0].html
      // Owner phone in buildData() is the same number, so it should appear twice.
      const matches = html.match(/https:\/\/wa\.me\/526648442154/g) || []
      // Each phone is wrapped in two anchors (number + "WhatsApp" label), so
      // two phones × two anchors = 4 occurrences.
      expect(matches.length).toBeGreaterThanOrEqual(4)
    })

    it('treats a legacy 10-digit Mexican number as +52', async () => {
      const mod = await import('../../../src/services/resend.service')
      await mod.sendNewVenueOnboardingDigest(
        buildData({
          businessInfo: { ...buildData().businessInfo, phone: '5512345678' },
          owner: null,
        }),
      )
      const html: string = mockSend.mock.calls[0][0].html
      expect(html).toContain('https://wa.me/525512345678')
    })

    it('plain-text body includes the wa.me URL next to each phone', async () => {
      const mod = await import('../../../src/services/resend.service')
      await mod.sendNewVenueOnboardingDigest(buildData())
      const text: string = mockSend.mock.calls[0][0].text
      expect(text).toContain('https://wa.me/526648442154')
    })
  })

  it('renders gracefully when there is no owner or payment info yet', async () => {
    process.env.RESEND_API_KEY = 're_test_key'
    mockSend.mockResolvedValue({ data: { id: 'resend-2' }, error: null })
    const mod = await import('../../../src/services/resend.service')

    const result = await mod.sendNewVenueOnboardingDigest(buildData({ owner: null, paymentInfo: null }))

    expect(result).toBe(true)
    const args = mockSend.mock.calls[0][0]
    // Sections render as em-dash placeholders rather than crashing.
    expect(args.text).toContain('AUTO DETAILING MEXA')
    expect(args.html).not.toContain('undefined')
  })

  it('respects ONBOARDING_NOTIFICATIONS_EMAIL env override when set', async () => {
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.ONBOARDING_NOTIFICATIONS_EMAIL = 'leads@avoqado.io'
    mockSend.mockResolvedValue({ data: { id: 'resend-env' }, error: null })
    const mod = await import('../../../src/services/resend.service')

    const result = await mod.sendNewVenueOnboardingDigest(buildData())

    expect(result).toBe(true)
    expect(mockSend.mock.calls[0][0].to).toBe('leads@avoqado.io')
  })

  it('returns false and logs when Resend returns an error', async () => {
    process.env.RESEND_API_KEY = 're_test_key'
    mockSend.mockResolvedValue({ data: null, error: { message: 'rate limited' } })
    const mod = await import('../../../src/services/resend.service')

    const result = await mod.sendNewVenueOnboardingDigest(buildData())

    expect(result).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Regression: KYC submission emails moved from hola@ to the onboarding alias
  // along with the new digest, so the empty-recipients fallback must hit the
  // onboarding alias now.
  // -------------------------------------------------------------------------
  it('sendKycSubmissionNotification falls back to onboarding@avoqado.io when recipients are empty', async () => {
    process.env.RESEND_API_KEY = 're_test_key'
    mockSend.mockResolvedValue({ data: { id: 'resend-3' }, error: null })
    const mod = await import('../../../src/services/resend.service')

    const result = await mod.sendKycSubmissionNotification({
      venueName: 'X',
      venueId: 'venue-x',
      actionUrl: '/super/x',
      recipients: [],
    })

    expect(result).toBe(true)
    const args = mockSend.mock.calls[0][0]
    expect(args.to).toBe('onboarding@avoqado.io')
  })
})
