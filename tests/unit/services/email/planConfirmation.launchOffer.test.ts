/**
 * S9 — el correo de confirmación habla de la campaña, no de una promoción escrita a mano
 * (spec 2026-09-17 § 3.8).
 *
 * 🔴 El defecto que cierra: la línea «Próxima renovación» decía SIEMPRE el precio de lista.
 * Con `INTRO_PRO_3M` eso ya mentía ($1,158.84 cuando el siguiente cobro son $694.84); con una
 * campaña de $22 la mentira sería de 50×.
 */
import emailService from '@/services/email.service'

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { venue: { findUnique: jest.fn() } } }))

const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(true)
afterEach(() => spy.mockClear())

const base = {
  venueName: 'Bar',
  payNow: true as const,
  interval: 'monthly' as const,
  firstChargeDate: new Date('2026-10-17'),
  billingPortalUrl: 'u',
}

function enviado() {
  const arg = spy.mock.calls[0][0]
  return `${arg.html}\n${arg.text ?? ''}`
}

describe('sendPlanConfirmationEmail — montos de la campaña', () => {
  it('🔴 la renovación usa `nextChargeAmountCents`, no el precio de lista', async () => {
    await emailService.sendPlanConfirmationEmail('a@x.com', {
      ...base,
      locale: 'es',
      firstChargeAmountCents: 115884,
      introAmountCents: 2200,
      introMonths: 3,
      nextChargeAmountCents: 2200,
    })
    const cuerpo = enviado()
    expect(cuerpo).toContain('Próxima renovación')
    expect(cuerpo).toContain('$22.00')
    // La afirmación que de verdad guarda el defecto: el precio de lista NO puede aparecer
    // como el próximo cobro.
    expect(cuerpo).not.toMatch(/Próxima renovación[^<\n]*1,158\.84/)
  })

  it('`introMonths` pinta SU número, en es y en en', async () => {
    await emailService.sendPlanConfirmationEmail('a@x.com', {
      ...base,
      locale: 'es',
      firstChargeAmountCents: 115884,
      introAmountCents: 2200,
      introMonths: 6,
      nextChargeAmountCents: 2200,
    })
    expect(enviado()).toContain('los primeros 6 meses')
    spy.mockClear()

    await emailService.sendPlanConfirmationEmail('a@x.com', {
      ...base,
      locale: 'en',
      firstChargeAmountCents: 115884,
      introAmountCents: 2200,
      introMonths: 6,
      nextChargeAmountCents: 2200,
    })
    expect(enviado()).toContain('the first 6 months')
  })

  it('un solo mes se dice en singular, no «los primeros 1 meses»', async () => {
    await emailService.sendPlanConfirmationEmail('a@x.com', {
      ...base,
      locale: 'es',
      firstChargeAmountCents: 115884,
      introAmountCents: 2200,
      introMonths: 1,
      nextChargeAmountCents: 115884,
    })
    const cuerpo = enviado()
    expect(cuerpo).toContain('el primer mes')
    expect(cuerpo).not.toContain('los primeros 1 meses')
  })

  it('🔴 COMPATIBILIDAD: sin los campos nuevos el texto queda EXACTAMENTE como antes', async () => {
    await emailService.sendPlanConfirmationEmail('a@x.com', {
      ...base,
      locale: 'es',
      firstChargeAmountCents: 115884,
      introAmountCents: 69484,
    })
    const cuerpo = enviado()
    expect(cuerpo).toContain('los primeros 3 meses')
    // Sin `nextChargeAmountCents` se cae a `firstChargeAmountCents`, que es lo que hacía antes.
    expect(cuerpo).toMatch(/Próxima renovación[^<\n]*1,158\.84/)
  })
})

// Founder (16-oct): al terminar el onboarding éste es el único correo que llega; también dice dónde bajar la app.
describe('sendPlanConfirmationEmail — dónde descargar la app', () => {
  const TIENDAS = [
    'https://apps.apple.com/mx/app/avoqado/id6758351745',
    'https://play.google.com/store/apps/details?id=com.avoqado.pos',
    'https://apps.microsoft.com/detail/9PCZG05M3PVC',
  ]

  it.each([
    ['es', true, 'Descarga y empieza a usar tu punto de venta'],
    ['es', false, 'Descarga y empieza a usar tu punto de venta'],
    ['en', true, 'Download and start using your point of sale'],
    ['en', false, 'Download and start using your point of sale'],
  ] as const)('locale %s, payNow %s: trae las tres tiendas en el HTML y en el texto', async (locale, payNow, titulo) => {
    await emailService.sendPlanConfirmationEmail('a@x.com', { ...base, locale, payNow, firstChargeAmountCents: 115884 })
    const { html, text } = spy.mock.calls[0][0]
    expect(html).toContain(titulo)
    expect(text).toContain(titulo)
    for (const url of TIENDAS) {
      expect(html).toContain(`href="${url}"`)
      expect(text).toContain(url)
    }
    expect(html).toContain('src="https://avoqado.io/badges/microsoft-store-es.png"')
  })
})
