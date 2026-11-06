/**
 * Aviso de que se acaba una prueba REGALADA del plan (`sendPlanFreeTrialEndingEmail`): la que da el SUPERADMIN con
 * «Dar días de prueba», sin tarjeta. No se cobra nada; Facturación la muestra «de cortesía» y no deja contratar
 * durante la prueba, así que el correo manda a escribirnos (D2, 5-nov-2026).
 * Correr con `TZ=UTC` para que la prueba de zona horaria pruebe lo que dice.
 */
import emailService from '@/services/email.service'

const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(true)
afterEach(() => spy.mockClear())

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u

// 03:00 UTC del 6 = 21:00 del 5 en CDMX: la fecha que se escribe es la del negocio, no la del servidor.
const FIN = new Date('2026-12-06T03:00:00Z')

function enviado() {
  const arg = spy.mock.calls[0][0]
  return { ...arg, html: arg.html ?? '', text: arg.text ?? '' }
}

describe('sendPlanFreeTrialEndingEmail', () => {
  it.each([
    ['es', 'Tu prueba gratis de Avoqado Pro termina el 5 de diciembre de 2026', 'no te cobraremos nada', 'plan Gratis'],
    ['en', 'Your free Avoqado Pro trial ends on December 5, 2026', "won't charge you anything for this trial", 'Free plan'],
  ] as const)(
    '%s: asunto con la fecha del negocio, sin cobro, qué pasa después y a quién escribir',
    async (locale, asunto, sinCobro, gratis) => {
      await emailService.sendPlanFreeTrialEndingEmail('ivonne@x.com', {
        locale,
        venueName: 'Taqueria El Patio',
        endDate: FIN,
        timeZone: 'America/Mexico_City',
      })
      const { to, subject, html, text } = enviado()

      expect(to).toBe('ivonne@x.com')
      expect(subject).toBe(asunto)
      expect(subject).not.toMatch(EMOJI_RE)
      for (const cuerpo of [html, text]) {
        expect(cuerpo).toContain(sinCobro)
        expect(cuerpo).toContain(gratis)
        expect(cuerpo).toContain('hola@avoqado.io')
      }
      // Nunca un monto ni «no tienes tarjeta»: puede tener tarjeta u otros cobros (Codex r1 #4); lo cierto es que ESTA prueba no cobra.
      expect(html + text).not.toMatch(/\$\d/)
      expect(html + text).not.toMatch(/tarjeta registrada|card on file/i)
      expect(html).toContain('Taqueria El Patio')
      expect(html.split('https://avoqado.io/isotipo.svg').length - 1).toBeGreaterThanOrEqual(2)
      expect(html).toMatch(/background-color:\s*#000000/)
      expect(text.length).toBeGreaterThan(0)
    },
  )

  it('el botón abre un correo a hola@avoqado.io con el negocio en el asunto', async () => {
    await emailService.sendPlanFreeTrialEndingEmail('a@x.com', { locale: 'es', venueName: 'Taqueria El Patio', endDate: FIN })
    const { html } = enviado()
    expect(html).toContain(`mailto:hola@avoqado.io?subject=${encodeURIComponent('Quiero seguir con Pro · Taqueria El Patio')}`)
  })

  it('pasa la llave de no repetir al proveedor', async () => {
    await emailService.sendPlanFreeTrialEndingEmail('a@x.com', {
      locale: 'es',
      venueName: 'Bar',
      endDate: FIN,
      idempotencyKey: 'prueba-regalada:vf9:x',
    })
    expect(spy.mock.calls[0][0].idempotencyKey).toBe('prueba-regalada:vf9:x')
  })

  it('Premium dice Premium', async () => {
    await emailService.sendPlanFreeTrialEndingEmail('a@x.com', { locale: 'es', venueName: 'Bar', endDate: FIN, planName: 'Premium' })
    expect(enviado().subject).toBe('Tu prueba gratis de Avoqado Premium termina el 5 de diciembre de 2026')
  })

  it('zona inválida → la de CDMX, y el correo sale igual', async () => {
    await expect(
      emailService.sendPlanFreeTrialEndingEmail('a@x.com', { locale: 'es', venueName: 'Bar', endDate: FIN, timeZone: 'GMT-6' }),
    ).resolves.toBe(true)
    expect(enviado().subject).toContain('5 de diciembre de 2026')
  })

  it('el nombre del negocio va escapado en el HTML', async () => {
    await emailService.sendPlanFreeTrialEndingEmail('a@x.com', { locale: 'es', venueName: 'Tacos <b>&</b> Co', endDate: FIN })
    const { html } = enviado()
    expect(html).not.toContain('<b>&</b>')
  })
})
