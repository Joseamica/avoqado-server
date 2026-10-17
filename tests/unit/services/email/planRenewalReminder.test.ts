/**
 * Correo de aviso de renovación / de fin de prueba (`sendPlanRenewalReminderEmail`).
 *
 * Con `isTrialEnd` es el aviso de que la prueba termina y ese día se cobra (job de recordatorio y
 * `customer.subscription.trial_will_end`); sin él es el de renovación de siempre, que no debe cambiar.
 * Correr con `TZ=UTC` para que la prueba de zona horaria pruebe lo que dice.
 */
import emailService from '@/services/email.service'

const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(true)
afterEach(() => spy.mockClear())

// Sin emoji en el asunto (email-templates.md, no negociable #4).
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
const LIGA = 'https://dash.avoqado.io/venues/bar/billing'

// 18:00 UTC = mediodía en CDMX: el 16 de noviembre en cualquier zona de la prueba.
const FIN_DE_PRUEBA = new Date('2026-11-16T18:00:00Z')

const base = {
  venueName: 'Bar',
  interval: 'monthly' as const,
  renewalDate: FIN_DE_PRUEBA,
  amountCents: 197084,
  billingPortalUrl: LIGA,
}

function enviado() {
  const arg = spy.mock.calls[0][0]
  return { ...arg, html: arg.html ?? '', text: arg.text ?? '' }
}

describe('sendPlanRenewalReminderEmail — fin de prueba (isTrialEnd)', () => {
  it.each([
    ['es', 'Tu prueba de Avoqado Premium termina el 16 de noviembre de 2026', '16 de noviembre de 2026', 'cancela antes desde Facturación'],
    ['en', 'Your Avoqado Premium trial ends on November 16, 2026', 'November 16, 2026', 'cancel before then from Billing'],
  ] as const)('%s: asunto, monto, fecha, plan y liga; sin emoji; isotipo x2; botón negro', async (locale, asunto, fecha, cancelar) => {
    await emailService.sendPlanRenewalReminderEmail('a@x.com', { ...base, locale, isTrialEnd: true, planName: 'Premium' })
    const { to, subject, html, text } = enviado()

    expect(to).toBe('a@x.com')
    expect(subject).toBe(asunto)
    expect(subject).not.toMatch(EMOJI_RE)
    for (const cuerpo of [html, text]) {
      expect(cuerpo).toContain('$1,970.84')
      expect(cuerpo).toContain(fecha)
      expect(cuerpo).toContain('Premium')
      expect(cuerpo).toContain(LIGA)
      expect(cuerpo).toContain(cancelar)
    }
    expect(html.split('https://avoqado.io/isotipo.svg').length - 1).toBeGreaterThanOrEqual(2)
    expect(html).toMatch(/background-color:\s*#000000/)
    expect(text.length).toBeGreaterThan(0)
  })

  it('es: el cuerpo dice que ese día se cobra a la tarjeta', async () => {
    await emailService.sendPlanRenewalReminderEmail('a@x.com', { ...base, locale: 'es', isTrialEnd: true, planName: 'Premium' })
    const { html, text } = enviado()
    for (const cuerpo of [html, text]) {
      expect(cuerpo).toContain('Ese día cobraremos')
      expect(cuerpo).toContain('a tu tarjeta')
    }
  })

  it('sin `planName` el plan es Pro', async () => {
    await emailService.sendPlanRenewalReminderEmail('a@x.com', { ...base, locale: 'es', isTrialEnd: true })
    expect(enviado().subject).toBe('Tu prueba de Avoqado Pro termina el 16 de noviembre de 2026')
  })
})

describe('sendPlanRenewalReminderEmail — renovación (sin isTrialEnd)', () => {
  it.each([
    ['es', 'Tu plan se renueva pronto', 'Tu plan Avoqado Pro se renovará el'],
    ['en', 'Your plan renews soon', 'Your Avoqado Pro plan will renew on'],
  ] as const)('%s: sin `isTrialEnd` ni `planName` el asunto y el cuerpo de hoy no cambian', async (locale, asunto, frase) => {
    await emailService.sendPlanRenewalReminderEmail('a@x.com', { ...base, locale })
    const { subject, html, text } = enviado()
    expect(subject).toBe(asunto)
    expect(html).toContain(frase)
    expect(text).toContain(frase)
    expect(html).not.toContain('trial')
    expect(html).not.toContain('prueba')
  })

  it.each([
    ['es', 'Tu plan Avoqado Premium se renovará el'],
    ['en', 'Your Avoqado Premium plan will renew on'],
  ] as const)('%s: la renovación de Premium dice «Premium», nunca «Pro»', async (locale, frase) => {
    await emailService.sendPlanRenewalReminderEmail('a@x.com', { ...base, locale, planName: 'Premium' })
    const { subject, html, text } = enviado()
    for (const cuerpo of [html, text]) {
      expect(cuerpo).toContain(frase)
      expect(cuerpo).not.toMatch(/\bPro\b/)
    }
    expect(subject).not.toMatch(EMOJI_RE)
  })
})

describe('sendPlanRenewalReminderEmail — zona horaria de la fecha', () => {
  // 02:00 UTC del 17 = las 20:00 del 16 en CDMX. Con `TZ=UTC` y sin zona explícita saldría «17».
  const CRUZA_MEDIANOCHE_UTC = new Date('2026-11-17T02:00:00Z')

  it.each([true, false])('por defecto es America/Mexico_City (isTrialEnd=%s)', async isTrialEnd => {
    await emailService.sendPlanRenewalReminderEmail('a@x.com', { ...base, locale: 'es', renewalDate: CRUZA_MEDIANOCHE_UTC, isTrialEnd })
    const { html, text } = enviado()
    expect(html).toContain('16 de noviembre')
    expect(text).toContain('16 de noviembre')
    expect(html).not.toContain('17 de noviembre')
  })

  it('`timeZone` explícita manda sobre el valor por defecto', async () => {
    await emailService.sendPlanRenewalReminderEmail('a@x.com', {
      ...base,
      locale: 'es',
      renewalDate: CRUZA_MEDIANOCHE_UTC,
      isTrialEnd: true,
      timeZone: 'UTC',
    })
    expect(enviado().subject).toContain('17 de noviembre')
  })
})
