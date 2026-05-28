/**
 * Tests for `sendOnboardingWelcomeEmail` — the welcome message to the venue
 * owner after they finish onboarding. Before this email existed, customers
 * completed signup and got zero acknowledgement from us — the dashboard
 * loaded with no data and no idea what was next. The welcome bridges that
 * gap until the team contacts them manually.
 */
const mockWelcomeSend = jest.fn()

jest.mock('resend', () => ({
  __esModule: true,
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: mockWelcomeSend },
  })),
}))

describe('sendOnboardingWelcomeEmail', () => {
  const buildData = (overrides: Partial<any> = {}) => ({
    ownerEmail: 'gibrangonzalez0303@gmail.com',
    ownerFirstName: 'Gibran bernardo',
    venueName: 'AUTO DETAILING MEXA',
    venueSlug: 'auto-detailing-mexa',
    hasKycDocuments: false,
    ...overrides,
  })

  beforeEach(() => {
    jest.resetModules()
    mockWelcomeSend.mockReset()
    delete process.env.RESEND_API_KEY
    delete process.env.ONBOARDING_NOTIFICATIONS_EMAIL
    delete process.env.FRONTEND_URL
  })

  it('returns false and skips sending when RESEND_API_KEY is not configured', async () => {
    const mod = await import('../../../src/services/resend.service')
    const result = await mod.sendOnboardingWelcomeEmail(buildData())
    expect(result).toBe(false)
    expect(mockWelcomeSend).not.toHaveBeenCalled()
  })

  it('sends the welcome to the owner with a personalized greeting', async () => {
    process.env.RESEND_API_KEY = 're_test_key'
    mockWelcomeSend.mockResolvedValue({ data: { id: 'welcome-1' }, error: null })
    const mod = await import('../../../src/services/resend.service')

    const result = await mod.sendOnboardingWelcomeEmail(buildData())

    expect(result).toBe(true)
    expect(mockWelcomeSend).toHaveBeenCalledTimes(1)
    const args = mockWelcomeSend.mock.calls[0][0]
    expect(args.to).toBe('gibrangonzalez0303@gmail.com')
    // Subject mentions the first token of the first-name field only.
    expect(args.subject).toBe('Bienvenido a Avoqado, Gibran')
    // HTML greets the owner by first name only.
    expect(args.html).toContain('¡Hola, Gibran!')
    // Body mentions the venue + the 24h commitment.
    expect(args.html).toContain('AUTO DETAILING MEXA')
    expect(args.html).toContain('24 horas hábiles')
  })

  it('shows the "upload docs" secondary CTA only when KYC docs were not submitted', async () => {
    process.env.RESEND_API_KEY = 're_test_key'
    mockWelcomeSend.mockResolvedValue({ data: { id: 'welcome-2' }, error: null })
    const mod = await import('../../../src/services/resend.service')

    // First: hasKycDocuments=false → docs CTA appears.
    await mod.sendOnboardingWelcomeEmail(buildData({ hasKycDocuments: false }))
    expect(mockWelcomeSend.mock.calls[0][0].html).toContain('Subir documentos')
    expect(mockWelcomeSend.mock.calls[0][0].text).toContain('Subir documentos')

    mockWelcomeSend.mockClear()

    // Second: hasKycDocuments=true → docs CTA omitted (they already uploaded).
    await mod.sendOnboardingWelcomeEmail(buildData({ hasKycDocuments: true }))
    expect(mockWelcomeSend.mock.calls[0][0].html).not.toContain('Subir documentos')
    expect(mockWelcomeSend.mock.calls[0][0].text).not.toContain('Subir documentos')
  })

  it('sets replyTo to the onboarding alias so customer replies reach the team', async () => {
    process.env.RESEND_API_KEY = 're_test_key'
    mockWelcomeSend.mockResolvedValue({ data: { id: 'welcome-3' }, error: null })
    const mod = await import('../../../src/services/resend.service')

    await mod.sendOnboardingWelcomeEmail(buildData())

    expect(mockWelcomeSend.mock.calls[0][0].replyTo).toBe('onboarding@avoqado.io')
  })

  it('honors ONBOARDING_NOTIFICATIONS_EMAIL env override for replyTo', async () => {
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.ONBOARDING_NOTIFICATIONS_EMAIL = 'leads@avoqado.io'
    mockWelcomeSend.mockResolvedValue({ data: { id: 'welcome-4' }, error: null })
    const mod = await import('../../../src/services/resend.service')

    await mod.sendOnboardingWelcomeEmail(buildData())

    expect(mockWelcomeSend.mock.calls[0][0].replyTo).toBe('leads@avoqado.io')
    expect(mockWelcomeSend.mock.calls[0][0].html).toContain('leads@avoqado.io')
  })

  it('falls back to a generic greeting when ownerFirstName is empty', async () => {
    process.env.RESEND_API_KEY = 're_test_key'
    mockWelcomeSend.mockResolvedValue({ data: { id: 'welcome-5' }, error: null })
    const mod = await import('../../../src/services/resend.service')

    await mod.sendOnboardingWelcomeEmail(buildData({ ownerFirstName: '' }))

    expect(mockWelcomeSend.mock.calls[0][0].subject).toBe('Bienvenido a Avoqado, equipo')
    expect(mockWelcomeSend.mock.calls[0][0].html).toContain('¡Hola!')
  })

  // -------------------------------------------------------------------------
  // EMAIL_STANDARDS.md compliance — same checks as the digest, applied here.
  // -------------------------------------------------------------------------
  describe('Avoqado email-design compliance', () => {
    beforeEach(() => {
      process.env.RESEND_API_KEY = 're_test_key'
      mockWelcomeSend.mockResolvedValue({ data: { id: 'welcome-design' }, error: null })
    })

    it('subject does not contain emoji', async () => {
      const mod = await import('../../../src/services/resend.service')
      await mod.sendOnboardingWelcomeEmail(buildData())
      const subject: string = mockWelcomeSend.mock.calls[0][0].subject
      expect(subject).not.toMatch(/\p{Extended_Pictographic}/u)
    })

    it('HTML embeds the Avoqado isotipo twice (header + footer)', async () => {
      const mod = await import('../../../src/services/resend.service')
      await mod.sendOnboardingWelcomeEmail(buildData())
      const html: string = mockWelcomeSend.mock.calls[0][0].html
      const matches = html.match(/avoqado\.io\/isotipo\.svg/g) || []
      expect(matches.length).toBeGreaterThanOrEqual(2)
    })

    it('primary CTA uses black background (#000000)', async () => {
      const mod = await import('../../../src/services/resend.service')
      await mod.sendOnboardingWelcomeEmail(buildData())
      const html: string = mockWelcomeSend.mock.calls[0][0].html
      expect(html).toMatch(/background-color:\s*#000000/i)
      expect(html).not.toMatch(/linear-gradient/i)
    })

    it('footer carries the legal-entity line', async () => {
      const mod = await import('../../../src/services/resend.service')
      await mod.sendOnboardingWelcomeEmail(buildData())
      const html: string = mockWelcomeSend.mock.calls[0][0].html
      expect(html).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
    })

    it('plain-text body includes the greeting and 24h promise', async () => {
      const mod = await import('../../../src/services/resend.service')
      await mod.sendOnboardingWelcomeEmail(buildData())
      const text: string = mockWelcomeSend.mock.calls[0][0].text
      expect(text).toContain('¡Hola, Gibran!')
      expect(text).toContain('24 horas hábiles')
    })
  })
})
