/**
 * El correo que le lleva la tarjeta de regalo a quien la RECIBE (1b S3, Q4). Checklist de `.claude/rules/email-templates.md`
 * (sin emoji, isotipo dos veces, CTA negro, texto plano) más lo de la tarjeta: la liga y el folio, NUNCA el código (E8), y la
 * llave de idempotencia que le pasa a Resend.
 */
import emailService from '@/services/email.service'

const LOGO = 'https://avoqado.io/isotipo.svg'
const URL = 'https://pay.avoqado.io/tarjeta/Xk3pQ9vLmN2rT8wYz5aB7cD1eF4gH6jK0sU'
const DATOS = { negocio: 'IQ Collection', monto: '$1,000.00', deParteDe: 'Luis', para: 'Ana', folio: 'JKMN', url: URL }
const LLAVE = 'giftcard:gc1:auto:1a2b3c4d:1'
/** La forma en que se imprime un código de tarjeta (`formatGiftCardCode`): 4-4-4-4-resto. */
const FORMA_DE_CODIGO = /[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]+/

let envio: jest.SpyInstance
beforeEach(() => {
  envio = jest.spyOn(emailService, 'sendEmailWithResult').mockResolvedValue({ ok: true, resendId: 're_1', transient: false })
})
afterEach(() => envio.mockRestore())

async function mandar(d = DATOS) {
  const r = await emailService.sendGiftCardDeliveryEmail('ana@correo.mx', d, LLAVE)
  return { r, m: envio.mock.calls[0][0] }
}

describe('sendGiftCardDeliveryEmail', () => {
  it('cumple el checklist de correos del repo', async () => {
    const { m } = await mandar()
    expect(m.subject).toBe('Tu tarjeta de regalo de IQ Collection')
    expect(m.subject).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(m.subject.length).toBeLessThan(60)
    expect((m.html.match(new RegExp(LOGO, 'g')) || []).length).toBeGreaterThanOrEqual(2)
    expect(m.html).toContain('background-color:#000000')
    expect(m.text.trim().length).toBeGreaterThan(0)
    expect(m.html).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
  })

  it('trae el folio, el monto, de parte de quién y la liga (en el botón y en el texto); NO trae el código', async () => {
    const { m } = await mandar()
    for (const cuerpo of [m.html, m.text]) {
      expect(cuerpo).toContain('JKMN')
      expect(cuerpo).toContain('$1,000.00')
      expect(cuerpo).toContain('Luis')
      expect(cuerpo).toContain(URL)
      expect(cuerpo).not.toMatch(FORMA_DE_CODIGO)
    }
    expect(m.html).toContain('Recibiste una tarjeta de regalo de IQ Collection')
    expect(m.html).toContain('Ver mi tarjeta')
    expect(m.html).toContain('IQ Collection usa tu nombre y tu correo sólo para entregarte esta tarjeta')
  })

  it('pasa la idempotencyKey a sendEmailWithResult y devuelve su resultado', async () => {
    const { r, m } = await mandar()
    expect(m).toEqual(expect.objectContaining({ to: 'ana@correo.mx', idempotencyKey: LLAVE }))
    expect(r).toEqual({ ok: true, resendId: 're_1', transient: false })
  })

  it('escapa en el HTML lo que escribió una persona', async () => {
    const { m } = await mandar({ ...DATOS, deParteDe: '<script>x</script>', para: '<b>Ana</b>' })
    expect(m.html).not.toContain('<script>')
    expect(m.html).not.toContain('<b>Ana</b>')
  })
})
