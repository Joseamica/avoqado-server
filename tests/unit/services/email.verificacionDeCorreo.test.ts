import emailService from '../../../src/services/email.service'

// Sólo importa lo que sendEmailVerification le pasa al transporte.
const sendSpy = jest.spyOn(emailService as any, 'sendEmail').mockResolvedValue(true)

beforeEach(() => sendSpy.mockClear())

// 27-oct: el registro directo recibía «Verifica tu correo electronico» y «Hola Usuario», sin acentos.
describe('sendEmailVerification — el correo del código', () => {
  it('pone el código en el asunto y escribe con acentos', async () => {
    await emailService.sendEmailVerification('ana@example.com', { firstName: 'Ana', verificationCode: '102494' })

    const opts = sendSpy.mock.calls[0][0] as any
    expect(opts.subject).toBe('102494 es tu código de Avoqado')
    const cuerpos = `${opts.html}\n${opts.text}`
    expect(cuerpos).toContain('Hola, Ana:')
    expect(cuerpos).toContain('TU CÓDIGO DE VERIFICACIÓN')
    expect(cuerpos).toContain('Este código vence en 10 minutos')
    expect(cuerpos).not.toMatch(/codigo|electronico|expirara|Contactanos|Politica/)
  })

  it('sin nombre (o con el relleno «Usuario») saluda sin inventar uno', async () => {
    await emailService.sendEmailVerification('x@example.com', { firstName: 'Usuario', verificationCode: '111111' })
    await emailService.sendEmailVerification('y@example.com', { firstName: '', verificationCode: '222222' })

    for (const [opts] of sendSpy.mock.calls as any[]) {
      expect(`${opts.html}\n${opts.text}`).not.toContain('Usuario')
      expect(opts.text).toContain('Hola:')
    }
  })
})
