/**
 * `sendEmailWithResult` acepta `replyTo` (las campañas de plataforma responden a hola@avoqado.io) y SIN él el payload
 * que llega a Resend es idéntico al de antes: los ~40 llamadores y el carril de campañas de los negocios no cambian.
 */

// El servicio captura `RESEND_API_KEY` al importarse, así que se pone antes.
process.env.RESEND_API_KEY = 'test-key'

const sendMock = jest.fn().mockResolvedValue({ data: { id: 'resend-id' }, error: null })

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}))

import emailService from '@/services/email.service'

describe('emailService.sendEmailWithResult — replyTo', () => {
  beforeEach(() => sendMock.mockClear())

  const base = { to: 'isaac.mayoral@playtelecom.com', subject: 'Novedades', html: '<p>hola</p>', text: 'hola' }

  it('con replyTo, Resend lo recibe en el campo replyTo', async () => {
    const result = await emailService.sendEmailWithResult({ ...base, replyTo: 'hola@avoqado.io' })

    expect(result).toMatchObject({ ok: true, resendId: 'resend-id' })
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0][0].replyTo).toBe('hola@avoqado.io')
  })

  it('sin replyTo, el payload no trae ni la llave: queda igual que antes', async () => {
    await emailService.sendEmailWithResult(base)

    const payload = sendMock.mock.calls[0][0]
    expect(payload).not.toHaveProperty('replyTo')
    expect(payload).not.toHaveProperty('reply_to')
    expect(payload).toEqual({
      from: expect.any(String),
      to: base.to,
      subject: base.subject,
      html: base.html,
      text: base.text,
    })
  })

  it('un replyTo vacío tampoco viaja', async () => {
    await emailService.sendEmailWithResult({ ...base, replyTo: '' })

    expect(sendMock.mock.calls[0][0]).not.toHaveProperty('replyTo')
  })

  it('sendEmail (el de los ~40 llamadores) no conoce replyTo: no lo manda aunque se lo cuelen', async () => {
    await emailService.sendEmail({ ...base, replyTo: 'hola@avoqado.io' } as never)

    expect(sendMock.mock.calls[0][0]).not.toHaveProperty('replyTo')
  })
})
