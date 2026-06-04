import emailService from '../../../../src/services/email.service'

// Mock prisma so the resolver regression block (bottom of file) can stub venue lookups.
// email.service does NOT import prismaClient, so this does not affect the send-spy tests.
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn() } },
}))

import { resolvePlanNotificationTarget } from '../../../../src/services/access/planNotification.service'
import prisma from '../../../../src/utils/prismaClient'

// No emoji allowed in any subject line (email-templates.md non-negotiable #4).
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u

describe('Subscription lifecycle plan emails', () => {
  const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(true)
  afterEach(() => spy.mockClear())

  // --- Task 4: sendPlanConfirmationEmail ---
  describe('sendPlanConfirmationEmail', () => {
    it('confirmation: trial es subject, no emoji', async () => {
      await emailService.sendPlanConfirmationEmail('a@x.com', {
        locale: 'es',
        venueName: 'Bar',
        payNow: false,
        interval: 'monthly',
        firstChargeDate: new Date('2026-07-03'),
        firstChargeAmountCents: 115884,
        billingPortalUrl: 'u',
      })
      const arg = spy.mock.calls[0][0]
      expect(arg.to).toBe('a@x.com')
      expect(arg.subject).toMatch(/prueba|Pro/i)
      expect(arg.subject).not.toMatch(EMOJI_RE)
      expect(arg.html).toContain('1,158.84')
    })

    it('confirmation: pay-now en subject + intro amount', async () => {
      await emailService.sendPlanConfirmationEmail('a@x.com', {
        locale: 'en',
        venueName: 'Bar',
        payNow: true,
        interval: 'monthly',
        firstChargeDate: new Date('2026-09-03'),
        firstChargeAmountCents: 115884,
        introAmountCents: 69484,
        billingPortalUrl: 'u',
      })
      const arg = spy.mock.calls[0][0]
      expect(arg.to).toBe('a@x.com')
      expect(arg.subject).toMatch(/welcome|plan|Pro/i)
      expect(arg.subject).not.toMatch(EMOJI_RE)
      expect(arg.html).toContain('694.84')
    })
  })

  // --- Task 6: sendPlanRenewalReminderEmail ---
  describe('sendPlanRenewalReminderEmail', () => {
    it('renewal reminder: es subject + amount + date, no emoji', async () => {
      await emailService.sendPlanRenewalReminderEmail('a@x.com', {
        locale: 'es',
        venueName: 'Bar',
        interval: 'monthly',
        renewalDate: new Date('2026-07-03'),
        amountCents: 115884,
        billingPortalUrl: 'u',
      })
      const arg = spy.mock.calls[0][0]
      expect(arg.to).toBe('a@x.com')
      expect(arg.subject).toBe('Tu plan se renueva pronto')
      expect(arg.subject).not.toMatch(EMOJI_RE)
      expect(arg.html).toContain('1,158.84')
      expect(arg.html).toContain('renovará')
    })
  })

  // --- Task 8: sendPlanWinbackEmail ---
  describe('sendPlanWinbackEmail', () => {
    it('winback: en subject, free-month copy + CTA url, no emoji', async () => {
      await emailService.sendPlanWinbackEmail('a@x.com', {
        locale: 'en',
        venueName: 'Bar',
        reactivateUrl: 'https://dash/billing?winback=1',
      })
      const arg = spy.mock.calls[0][0]
      expect(arg.to).toBe('a@x.com')
      expect(arg.subject).toBe('Come back to Avoqado Pro — your first month is free')
      expect(arg.subject).not.toMatch(EMOJI_RE)
      expect(arg.html).toContain('first month is free')
      expect(arg.html).toContain('https://dash/billing?winback=1')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Task 10: retrofitted 5 existing emails — bilingual (locale param)
  //
  // For each method:
  //   - locale: 'en'  → English subject (NEW behavior)
  //   - locale omitted → Spanish subject (REGRESSION: legacy à-la-carte Feature
  //                       callers never passed a locale and must stay Spanish)
  // No emoji in any subject (email-templates.md non-negotiable #4).
  // ──────────────────────────────────────────────────────────────────────────

  describe('sendTrialEndingEmail (bilingual retrofit)', () => {
    const base = {
      venueName: 'Bar',
      featureName: 'Plan Pro',
      trialEndDate: new Date('2026-07-03'),
      billingPortalUrl: 'https://dash/billing',
    }

    it('locale en → English subject, no emoji', async () => {
      await emailService.sendTrialEndingEmail('a@x.com', { ...base, locale: 'en' })
      const arg = spy.mock.calls[0][0]
      expect(arg.to).toBe('a@x.com')
      expect(arg.subject).toBe('Your free trial of Plan Pro is ending soon - Bar')
      expect(arg.subject).not.toMatch(EMOJI_RE)
      expect(arg.html).toContain('ending soon')
    })

    it('locale omitted → Spanish subject (regression for legacy callers)', async () => {
      await emailService.sendTrialEndingEmail('a@x.com', base)
      const arg = spy.mock.calls[0][0]
      expect(arg.subject).toBe('Tu prueba gratuita de Plan Pro esta por terminar - Bar')
      expect(arg.subject).not.toMatch(EMOJI_RE)
    })
  })

  describe('sendPaymentFailedEmail (bilingual retrofit)', () => {
    const base = {
      venueName: 'Bar',
      featureName: 'Plan Pro',
      attemptCount: 1,
      amountDue: 115884,
      currency: 'mxn',
      billingPortalUrl: 'https://dash/billing',
    }

    it('locale en → English subject + en-US money formatting, no emoji', async () => {
      await emailService.sendPaymentFailedEmail('a@x.com', { ...base, locale: 'en' })
      const arg = spy.mock.calls[0][0]
      expect(arg.subject).toBe('Payment problem with Plan Pro - Bar')
      expect(arg.subject).not.toMatch(EMOJI_RE)
      // en-US MXN formatting renders the currency code prefix.
      expect(arg.html).toContain('1,158.84')
    })

    it('locale omitted → Spanish subject (regression for legacy callers)', async () => {
      await emailService.sendPaymentFailedEmail('a@x.com', base)
      const arg = spy.mock.calls[0][0]
      expect(arg.subject).toBe('Problema con el pago de Plan Pro - Bar')
      expect(arg.subject).not.toMatch(EMOJI_RE)
    })
  })

  describe('sendSubscriptionSuspendedEmail (bilingual retrofit)', () => {
    const base = {
      venueName: 'Bar',
      featureName: 'Plan Pro',
      suspendedAt: new Date('2026-07-03'),
      gracePeriodEndsAt: new Date('2026-07-10'),
      billingPortalUrl: 'https://dash/billing',
    }

    it('locale en → English subject, no emoji', async () => {
      await emailService.sendSubscriptionSuspendedEmail('a@x.com', { ...base, locale: 'en' })
      const arg = spy.mock.calls[0][0]
      expect(arg.subject).toBe('Your Plan Pro subscription has been suspended - Bar')
      expect(arg.subject).not.toMatch(EMOJI_RE)
      expect(arg.html).toContain('has been suspended')
    })

    it('locale omitted → Spanish subject (regression for legacy callers)', async () => {
      await emailService.sendSubscriptionSuspendedEmail('a@x.com', base)
      const arg = spy.mock.calls[0][0]
      expect(arg.subject).toBe('Tu suscripcion de Plan Pro ha sido suspendida - Bar')
      expect(arg.subject).not.toMatch(EMOJI_RE)
    })
  })

  describe('sendSubscriptionCanceledEmail (bilingual retrofit)', () => {
    const base = {
      venueName: 'Bar',
      featureName: 'Plan Pro',
      canceledAt: new Date('2026-07-10'),
      suspendedAt: new Date('2026-07-03'),
    }

    it('locale en → English subject, no emoji', async () => {
      await emailService.sendSubscriptionCanceledEmail('a@x.com', { ...base, locale: 'en' })
      const arg = spy.mock.calls[0][0]
      expect(arg.subject).toBe('Your Plan Pro subscription has been canceled - Bar')
      expect(arg.subject).not.toMatch(EMOJI_RE)
      expect(arg.html).toContain('has been permanently canceled')
    })

    it('locale omitted → Spanish subject (regression for legacy callers)', async () => {
      await emailService.sendSubscriptionCanceledEmail('a@x.com', base)
      const arg = spy.mock.calls[0][0]
      expect(arg.subject).toBe('Tu suscripcion de Plan Pro ha sido cancelada - Bar')
      expect(arg.subject).not.toMatch(EMOJI_RE)
    })
  })

  describe('sendTrialExpiredEmail (bilingual retrofit)', () => {
    const base = {
      venueName: 'Bar',
      featureName: 'Plan Pro',
      expiredAt: new Date('2026-07-03'),
    }

    it('locale en → English subject, no emoji', async () => {
      await emailService.sendTrialExpiredEmail('a@x.com', { ...base, locale: 'en' })
      const arg = spy.mock.calls[0][0]
      expect(arg.subject).toBe('Your Plan Pro trial has ended - Bar')
      expect(arg.subject).not.toMatch(EMOJI_RE)
      expect(arg.html).toContain('trial period ended')
    })

    it('locale omitted → Spanish subject (regression for legacy callers)', async () => {
      await emailService.sendTrialExpiredEmail('a@x.com', base)
      const arg = spy.mock.calls[0][0]
      expect(arg.subject).toBe('Tu periodo de prueba de Plan Pro ha terminado - Bar')
      expect(arg.subject).not.toMatch(EMOJI_RE)
    })
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Task 10 regression: the caller recipient precedence (resolvePlanNotificationTarget)
// must still produce a non-null recipient when venue.email is set but org.email is
// null — i.e. the cron/webhook callers keep sending. This pins the resolver contract
// the 5 callers rely on (recipient = target.email ?? <legacy org email>).
// ──────────────────────────────────────────────────────────────────────────

describe('resolvePlanNotificationTarget — caller recipient fallback (Task 10 regression)', () => {
  afterEach(() => jest.clearAllMocks())

  it('resolves venue.email even when org.email is null (callers still send)', async () => {
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValueOnce({
      name: 'Bar',
      email: 'bar@x.com',
      language: 'es',
      organization: { email: null },
      staff: [],
    })
    const target = await resolvePlanNotificationTarget('v1')
    // recipient = target.email ?? venueFeature.venue.organization.email → 'bar@x.com'
    expect(target.email).toBe('bar@x.com')
    expect(target.locale).toBe('es')
  })

  it('falls back to org.email (legacy recipient) when venue/owner email missing', async () => {
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValueOnce({
      name: 'Bar',
      email: null,
      language: 'en',
      organization: { email: 'org@x.com' },
      staff: [],
    })
    const target = await resolvePlanNotificationTarget('v1')
    expect(target.email).toBe('org@x.com')
    expect(target.locale).toBe('en')
  })
})
