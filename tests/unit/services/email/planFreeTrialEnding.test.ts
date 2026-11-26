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

  // D3: mientras pueda quedarse con su plan, el botón lleva a Facturación y el texto dice que hoy no paga nada.
  it('con billingUrl: «Quedarme con Pro» a Facturación, hoy no paga y primer cobro al terminar', async () => {
    const LIGA = 'https://dashboard.avoqado.io/venues/taqueria/settings/billing/subscriptions'
    await emailService.sendPlanFreeTrialEndingEmail('a@x.com', { locale: 'es', venueName: 'Taqueria', endDate: FIN, billingUrl: LIGA })
    const { html, text } = enviado()
    expect(html).toContain(`href="${LIGA}"`)
    expect(html).toContain('Quedarme con Pro')
    for (const cuerpo of [html, text]) {
      expect(cuerpo).toContain('hoy no pagas nada y el primer cobro es el día que termina tu prueba')
      expect(cuerpo).not.toMatch(/\$\d/)
    }
    expect(text).toContain(LIGA)
  })
})

/**
 * Planes editables B2, Task 6 (§18, b2-r8): el mismo correo sirve de bienvenida a la prueba SIN tarjeta (`empezo`) y, en Task 9,
 * de recordatorio. Dice qué tarjeta cobraría Stripe al terminar (o que no hay ninguna) y el monto, con la nota del saldo. Sin
 * esos campos, el correo de hoy (las pruebas de arriba lo fijan).
 */
describe('sendPlanFreeTrialEndingEmail — la prueba sin tarjeta (B2)', () => {
  const LIGA = 'https://dashboard.avoqado.io/venues/taqueria/settings/billing/subscriptions'
  const NOTA = 'Si tu cuenta tiene saldo a favor o pendiente en Stripe, se aplica en tu recibo'

  it('empezo: asunto «Empezó tu prueba de Avoqado Pro: termina el …», con la tarjeta guardada, el monto y la nota del saldo', async () => {
    await emailService.sendPlanFreeTrialEndingEmail('a@x.com', {
      locale: 'es',
      venueName: 'Taqueria',
      endDate: FIN,
      timeZone: 'America/Mexico_City',
      billingUrl: LIGA,
      empezo: true,
      montoAlTerminarCents: 92684,
      tarjeta: { brand: 'visa', last4: '4242' },
      idempotencyKey: 'plan-trial-no-card-start:sub_1',
    })
    const { subject, html, text, idempotencyKey } = enviado()

    expect(subject).toBe('Empezó tu prueba de Avoqado Pro: termina el 5 de diciembre de 2026')
    expect(subject).not.toMatch(EMOJI_RE)
    expect(idempotencyKey).toBe('plan-trial-no-card-start:sub_1')
    for (const cuerpo of [html, text]) {
      // La marca como la lee una persona («Visa»), no la clave de Stripe (`visa`).
      expect(cuerpo).toContain('al terminar se cobrarán $926.84 en tu tarjeta Visa ••••4242; puedes quitarla o cancelar en «Tu plan»')
      expect(cuerpo).not.toContain('visa ••••')
      expect(cuerpo).toContain(NOTA)
      // No es la prueba regalada: nunca «no te cobraremos nada».
      expect(cuerpo).not.toContain('no te cobraremos nada')
    }
    expect(html).toContain(`href="${LIGA}"`)
    expect(html.split('https://avoqado.io/isotipo.svg').length - 1).toBeGreaterThanOrEqual(2)
    expect(html).toMatch(/background-color:\s*#000000/)
    expect(text.length).toBeGreaterThan(0)
  })

  it('sin tarjeta (tarjeta: null): «pon tu tarjeta en «Tu plan»; si no, sigues en Gratis», con el monto y la nota', async () => {
    await emailService.sendPlanFreeTrialEndingEmail('a@x.com', {
      locale: 'es',
      venueName: 'Taqueria',
      endDate: FIN,
      billingUrl: LIGA,
      empezo: true,
      montoAlTerminarCents: 92684,
      tarjeta: null,
    })
    const { html, text } = enviado()
    for (const cuerpo of [html, text]) {
      expect(cuerpo).toContain('pon tu tarjeta en «Tu plan»; si no, sigues en Gratis')
      expect(cuerpo).toContain('$926.84')
      expect(cuerpo).toContain(NOTA)
      expect(cuerpo).not.toContain('••••')
    }
  })

  it('sin empezo (el recordatorio de Task 9): el asunto de hoy; sin monto, ni el monto ni la nota del saldo', async () => {
    await emailService.sendPlanFreeTrialEndingEmail('a@x.com', { locale: 'es', venueName: 'Taqueria', endDate: FIN, tarjeta: null })
    const { subject, html, text } = enviado()
    expect(subject).toBe('Tu prueba gratis de Avoqado Pro termina el 5 de diciembre de 2026')
    for (const cuerpo of [html, text]) {
      expect(cuerpo).toContain('pon tu tarjeta en «Tu plan»; si no, sigues en Gratis')
      expect(cuerpo).not.toMatch(/\$\d/)
      expect(cuerpo).not.toContain(NOTA)
    }
  })

  it('en inglés también: el asunto de la bienvenida y la tarjeta', async () => {
    await emailService.sendPlanFreeTrialEndingEmail('a@x.com', {
      locale: 'en',
      venueName: 'Taqueria',
      endDate: FIN,
      empezo: true,
      montoAlTerminarCents: 92684,
      tarjeta: { brand: 'visa', last4: '4242' },
    })
    const { subject, text } = enviado()
    expect(subject).toBe('Your Avoqado Pro trial started: it ends on December 5, 2026')
    expect(text).toContain("we'll charge $926.84 to your Visa ••••4242")
  })

  it('fix round 1: la marca legible (Mastercard, American Express; una que no se conoce, con mayúscula) y, sin monto, «se cobrará tu plan», nunca «se cobrarán tu plan»', async () => {
    for (const [brand, legible] of [
      ['mastercard', 'Mastercard'],
      ['amex', 'American Express'],
      ['American Express', 'American Express'],
      ['diners', 'Diners Club'],
      ['cartes_bancaires', 'Cartes Bancaires'],
    ] as const) {
      spy.mockClear()
      await emailService.sendPlanFreeTrialEndingEmail('a@x.com', {
        locale: 'es',
        venueName: 'Taqueria',
        endDate: FIN,
        empezo: true,
        tarjeta: { brand, last4: '1234' },
      })
      const { html, text } = enviado()
      for (const cuerpo of [html, text]) {
        expect(cuerpo).toContain(`al terminar se cobrará tu plan en tu tarjeta ${legible} ••••1234`)
        expect(cuerpo).not.toContain('se cobrarán tu plan')
      }
    }
    // La marca que Stripe da cuando no la sabe (`unknown`, o `Unknown` en una fuente vieja): como sin marca, sólo la terminación.
    for (const [locale, frase] of [
      ['es', 'al terminar se cobrará tu plan en tu tarjeta ••••4242;'],
      ['en', "we'll charge your plan to your card ••••4242;"],
    ] as const) {
      for (const brand of ['unknown', 'Unknown']) {
        spy.mockClear()
        await emailService.sendPlanFreeTrialEndingEmail('a@x.com', {
          locale,
          venueName: 'Taqueria',
          endDate: FIN,
          empezo: true,
          tarjeta: { brand, last4: '4242' },
        })
        const { html, text } = enviado()
        for (const cuerpo of [html, text]) {
          expect(cuerpo).toContain(frase)
          expect(cuerpo).not.toMatch(/unknown/i)
        }
      }
    }
    // Sin marca: sólo la terminación.
    spy.mockClear()
    await emailService.sendPlanFreeTrialEndingEmail('a@x.com', {
      locale: 'es',
      venueName: 'Taqueria',
      endDate: FIN,
      empezo: true,
      montoAlTerminarCents: 92684,
      tarjeta: { brand: null, last4: '1234' },
    })
    expect(enviado().text).toContain('al terminar se cobrarán $926.84 en tu tarjeta ••••1234;')
  })
})

/**
 * Codex b2-code #6: la bienvenida de una prueba sin tarjeta que ya tiene la cancelación programada (`noHabraCobro`): al terminar no
 * se cobra nada, como un `ENDS_FREE`. No menciona la tarjeta ni el monto (aunque lleguen) ni la nota del saldo.
 */
describe('sendPlanFreeTrialEndingEmail — prueba sin tarjeta con la cancelación programada (noHabraCobro)', () => {
  const LIGA = 'https://dashboard.avoqado.io/venues/negocio/settings/billing/subscriptions'

  it.each([
    ['es', 'Al terminar no se te cobrará nada. Si quieres quedarte en Pro, puedes hacerlo desde «Tu plan».', /se cobrar|Stripe/],
    [
      'en',
      "When it ends, you won't be charged anything. If you want to stay on Pro, you can do it from «Your plan».",
      /we'll charge|Stripe/,
    ],
  ] as const)('%s: dice que no habrá cobro, sin tarjeta, sin monto y sin la nota del saldo', async (locale, sinCobro, prometeCobro) => {
    await emailService.sendPlanFreeTrialEndingEmail('duena@example.com', {
      locale,
      venueName: 'Negocio de prueba',
      endDate: FIN,
      timeZone: 'America/Mexico_City',
      billingUrl: LIGA,
      empezo: true,
      montoAlTerminarCents: 92684,
      tarjeta: { brand: 'visa', last4: '4242' },
      noHabraCobro: true,
      idempotencyKey: 'plan-trial-no-card-start:sub_1',
    })
    const { subject, html, text } = enviado()

    expect(subject).not.toMatch(EMOJI_RE)
    for (const cuerpo of [html, text]) {
      expect(cuerpo).toContain(sinCobro)
      expect(cuerpo).not.toContain('4242')
      expect(cuerpo).not.toMatch(/\$\d/)
      expect(cuerpo).not.toMatch(prometeCobro)
    }
    expect(html.split('https://avoqado.io/isotipo.svg').length - 1).toBeGreaterThanOrEqual(2)
    expect(html).toMatch(/background-color:\s*#000000/)
    expect(text.length).toBeGreaterThan(0)
  })

  it('con noHabraCobro false, el texto de hoy (con la tarjeta, el monto y la nota)', async () => {
    await emailService.sendPlanFreeTrialEndingEmail('duena@example.com', {
      locale: 'es',
      venueName: 'Negocio de prueba',
      endDate: FIN,
      empezo: true,
      montoAlTerminarCents: 92684,
      tarjeta: { brand: 'visa', last4: '4242' },
      noHabraCobro: false,
    })
    const { text } = enviado()
    expect(text).toContain('al terminar se cobrarán $926.84 en tu tarjeta Visa ••••4242')
    expect(text).toContain('Si tu cuenta tiene saldo a favor o pendiente en Stripe, se aplica en tu recibo')
  })
})
