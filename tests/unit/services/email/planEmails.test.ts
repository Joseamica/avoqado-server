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
    it('🔴 la fecha del cobro se escribe en la hora del NEGOCIO (Tijuana), no en la del servidor', async () => {
      // 2027-10-21T06:30Z = 20 de octubre, 23:30 en Tijuana; ya es 21 en Ciudad de México (la Mac) y en UTC (Render).
      // Sin la zona del negocio el correo decía «21 de octubre» en cualquiera de los dos servidores.
      await emailService.sendPlanConfirmationEmail('a@x.com', {
        locale: 'es',
        venueName: 'Bar',
        payNow: false,
        interval: 'annual',
        firstChargeDate: new Date('2027-10-21T06:30:00Z'),
        firstChargeAmountCents: 1158840,
        billingPortalUrl: 'u',
        timeZone: 'America/Tijuana',
      })
      const html = JSON.stringify(spy.mock.calls.at(-1))
      expect(html).toContain('20 de octubre de 2027')
      expect(html).not.toContain('21 de octubre de 2027')
    })

    it('🔴 Plan Básico: la prueba que termina sin cobrar dice Básico y NO anuncia el cobro de Pro', async () => {
      await emailService.sendPlanConfirmationEmail('a@x.com', {
        locale: 'es',
        venueName: 'Bar',
        payNow: false,
        interval: 'monthly',
        firstChargeDate: new Date('2026-12-17T18:00:00Z'),
        firstChargeAmountCents: 115884,
        billingPortalUrl: 'u',
        trialEndsFree: true,
        basicPlanPriceWithoutTaxCents: 49900,
      })
      const correo = JSON.stringify(spy.mock.calls.at(-1))
      expect(correo).toContain(
        '30 días gratis con todo Pro. Termina el 17 de diciembre de 2026 y no se te cobra nada; ese día podrás contratar el Básico por $499 + IVA al mes con un clic.',
      )
      expect(correo).toContain('Cámbialo en «Tu plan».')
      expect(correo).not.toContain('1,158.84')
      expect(correo).not.toContain('primer cobro')
    })

    it('Plan Básico sin precio vigente: el texto sale sin precio, nunca inventado', async () => {
      await emailService.sendPlanConfirmationEmail('a@x.com', {
        locale: 'es',
        venueName: 'Bar',
        payNow: false,
        interval: 'monthly',
        firstChargeDate: new Date('2026-12-17T18:00:00Z'),
        firstChargeAmountCents: 115884,
        billingPortalUrl: 'u',
        trialEndsFree: true,
      })
      const correo = JSON.stringify(spy.mock.calls.at(-1))
      expect(correo).toContain('ese día podrás contratar el Básico con un clic.')
      expect(correo).not.toContain('1,158.84')
    })

    it('regresión: la prueba de Pro normal sigue anunciando su primer cobro', async () => {
      await emailService.sendPlanConfirmationEmail('a@x.com', {
        locale: 'es',
        venueName: 'Bar',
        payNow: false,
        interval: 'monthly',
        firstChargeDate: new Date('2026-12-17T18:00:00Z'),
        firstChargeAmountCents: 115884,
        billingPortalUrl: 'u',
      })
      expect(JSON.stringify(spy.mock.calls.at(-1))).toContain('Tu primer cobro será de <strong>$1,158.84</strong>')
    })

    it('🔴 D13: el monto lleva coma de miles aunque el Intl del servidor no la ponga (prod escribió «$1970.84»)', async () => {
      const original = Intl.NumberFormat
      ;(Intl as any).NumberFormat = jest.fn(() => ({ format: () => 'SIN-COMA' }))
      try {
        await emailService.sendPlanConfirmationEmail('a@x.com', {
          locale: 'es',
          venueName: 'Bar',
          planName: 'Premium',
          payNow: false,
          interval: 'monthly',
          firstChargeDate: new Date('2026-11-27'),
          firstChargeAmountCents: 197084,
          billingPortalUrl: 'u',
        } as any)
      } finally {
        ;(Intl as any).NumberFormat = original
      }
      const html = JSON.stringify(spy.mock.calls.at(-1))
      expect(html).toContain('$1,970.84')
      expect(html).not.toContain('SIN-COMA')
    })

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
      // Regresión (Plan Básico): sin `basicOffer`, ni bloque ni asunto nuevo.
      expect(arg.html).not.toContain('Prefieres el Básico')
    })

    it('🔴 Plan Básico «Tu Pro sube»: dice el monto REAL, ofrece el Básico a $499 + IVA y nunca su total', async () => {
      await emailService.sendPlanRenewalReminderEmail('a@x.com', {
        locale: 'es',
        venueName: 'Bar',
        interval: 'monthly',
        renewalDate: new Date('2026-12-05T17:00:00Z'),
        amountCents: 115884,
        billingPortalUrl: 'https://app/tu-plan',
        basicOffer: { priceWithoutTaxCents: 49900, reason: 'DISCOUNT_ENDS' },
      })
      const arg = spy.mock.calls[0][0]
      expect(arg.subject).toBe('Tu descuento de Pro termina el 5 de diciembre de 2026')
      expect(arg.html).toContain('$1,158.84')
      expect(arg.html).toContain('¿Prefieres el Básico a $499 + IVA?')
      expect(arg.html).toContain('Terminar mi Pro al acabar el descuento')
      expect(arg.html).toContain('https://app/tu-plan')
      expect(arg.html).not.toContain('578.84')
      expect(arg.text).toContain('¿Prefieres el Básico a $499 + IVA?')
    })

    it('Plan Básico en el fin de prueba de un Pro normal: el cobro sigue anunciado y el bloque ofrece terminar la prueba', async () => {
      await emailService.sendPlanRenewalReminderEmail('a@x.com', {
        locale: 'es',
        venueName: 'Bar',
        interval: 'monthly',
        renewalDate: new Date('2026-12-05T17:00:00Z'),
        amountCents: 115884,
        billingPortalUrl: 'u',
        isTrialEnd: true,
        basicOffer: { priceWithoutTaxCents: 49900, reason: 'TRIAL_ENDS' },
      })
      const arg = spy.mock.calls[0][0]
      expect(arg.subject).toBe('Tu prueba de Avoqado Pro termina el 5 de diciembre de 2026')
      expect(arg.html).toContain('cobraremos <strong>$1,158.84</strong>')
      expect(arg.html).toContain('terminar tu prueba sin que se te cobre Pro')
    })
  })

  describe('Plan Básico: sendPlanTrialEndsFreeEmail («Tu prueba termina»)', () => {
    const baja = { url: 'https://api/api/v1/public/unsubscribe?token=t1', preferencesUrl: 'https://app/prefs' }

    it('🔴 el texto literal del brief, sin cobro ni monto, con dos botones a «Tu plan» y la baja en un clic', async () => {
      await emailService.sendPlanTrialEndsFreeEmail('a@x.com', {
        locale: 'es',
        venueName: 'Bar',
        trialEndsAt: new Date('2026-12-17T18:00:00Z'),
        timeZone: 'America/Mexico_City',
        billingUrl: 'https://app/tu-plan',
        basicPlanPriceWithoutTaxCents: 49900,
        unsubscribe: baja,
        idempotencyKey: 'k1',
      })
      const arg = spy.mock.calls[0][0]
      expect(arg.subject).toBe('Tu prueba de Avoqado Pro termina el 17 de diciembre de 2026')
      expect(arg.subject).not.toMatch(EMOJI_RE)
      expect(arg.text).toContain(
        'Tu prueba de Pro termina el 17 de diciembre de 2026 y no se te cobrará nada. Ese día podrás contratar el Básico ($499 + IVA) con un clic, o quedarte en Pro desde hoy.',
      )
      expect(arg.html).not.toMatch(/cobraremos|1,158\.84|578\.84/)
      expect(arg.html).toContain('Ver mi plan')
      expect(arg.html).toContain('Quedarme en Pro')
      expect(arg.html).toContain('Dejar de recibir estos avisos por correo')
      expect(arg.html).toContain(baja.url)
      expect(arg.html).toContain(baja.preferencesUrl)
      expect(arg.headers).toEqual({ 'List-Unsubscribe': `<${baja.url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' })
      expect(arg.idempotencyKey).toBe('k1')
    })

    it('sin Básico publicado: sin el bloque del Básico, y nunca un precio inventado', async () => {
      await emailService.sendPlanTrialEndsFreeEmail('a@x.com', {
        locale: 'es',
        venueName: 'Bar',
        trialEndsAt: new Date('2026-12-17T18:00:00Z'),
        billingUrl: 'u',
      })
      const arg = spy.mock.calls[0][0]
      expect(arg.html).not.toContain('Básico')
      expect(arg.html).toContain('no se te cobrará nada')
      expect(arg.headers).toBeUndefined()
    })
  })

  describe('Plan Básico: sendPlanEndedEmail («Tu prueba terminó» / «Tu Pro terminó»)', () => {
    it('🔴 prueba: «Contratar Básico» y «Contratar Pro», sin cobro, con baja en un clic', async () => {
      const baja = { url: 'https://api/unsub?token=t2', preferencesUrl: 'https://app/prefs' }
      await emailService.sendPlanEndedEmail('a@x.com', {
        locale: 'es',
        venueName: 'Bar',
        kind: 'TRIAL',
        billingUrl: 'https://app/tu-plan',
        basicPlanPriceWithoutTaxCents: 49900,
        unsubscribe: baja,
      })
      const arg = spy.mock.calls[0][0]
      expect(arg.subject).toBe('Tu prueba de Avoqado Pro terminó')
      expect(arg.html).toContain('no se te cobró nada')
      expect(arg.html).toContain('Puedes contratar el Básico ($499 + IVA) con un clic, o volver a Pro.')
      expect(arg.html).toContain('Contratar Básico')
      expect(arg.html).toContain('Contratar Pro')
      expect(arg.headers?.['List-Unsubscribe']).toBe(`<${baja.url}>`)
    })

    it('«Tu Pro terminó» sin Básico publicado: sólo «Contratar Pro»', async () => {
      await emailService.sendPlanEndedEmail('a@x.com', { locale: 'es', venueName: 'Bar', kind: 'PRO', billingUrl: 'u' })
      const arg = spy.mock.calls[0][0]
      expect(arg.subject).toBe('Tu plan Avoqado Pro terminó')
      expect(arg.html).toContain('Contratar Pro')
      expect(arg.html).not.toContain('Contratar Básico')
    })
  })

  // 🔴 Real defect (2026-09-27): without Stripe's period end the caller passed the win-back deadline as the access
  // date. Unknown date → the copy says the paid period ends it, never a made-up date.
  describe('sendPlanCancellationEmail', () => {
    const base = { venueName: 'Bar', redeemBy: new Date('2026-10-04T12:00:00Z'), winbackPercentOff: 30, reactivateUrl: 'u' }

    it('with the real period end: states that date', async () => {
      await emailService.sendPlanCancellationEmail('a@x.com', { ...base, locale: 'es', accessUntil: new Date('2026-10-27T12:00:00Z') })
      expect(spy.mock.calls[0][0].html).toContain('27 de octubre de 2026')
    })

    it('🔴 unknown period end: no date, says the paid period ends it (es and en)', async () => {
      await emailService.sendPlanCancellationEmail('a@x.com', { ...base, locale: 'es', accessUntil: null })
      await emailService.sendPlanCancellationEmail('a@x.com', { ...base, locale: 'en', accessUntil: null })
      const [es, en] = spy.mock.calls.map(call => call[0])
      expect(es.html).toContain('hasta el final del periodo que ya pagaste')
      expect(es.text).toContain('hasta el final del periodo que ya pagaste')
      expect(en.html).toContain('until the end of the period you already paid for')
      expect(en.text).toContain('until the end of the period you already paid for')
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
      expect(arg.subject).toBe('Tu suscripción de Plan Pro ha sido suspendida - Bar')
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
      expect(arg.subject).toBe('Tu suscripción de Plan Pro ha sido cancelada - Bar')
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
