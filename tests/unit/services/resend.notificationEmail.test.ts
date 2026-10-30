/**
 * `sendNotificationEmail` (la plantilla genérica de avisos) y su baja en un clic (D4, Task 4).
 *
 * 🔴 Sin `opts` la salida debe ser IDÉNTICA byte a byte a la de antes de agregar `opts`: la usan el aviso de retardo y
 * `notification.service`. Las huellas sha256 de abajo se tomaron de la plantilla ANTES del cambio (28-oct); si cambias la
 * plantilla a propósito, vuelve a tomarlas y dilo en el PR.
 */
import crypto from 'crypto'

const mockSend = jest.fn()

jest.mock('resend', () => ({
  __esModule: true,
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}))

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

describe('sendNotificationEmail', () => {
  beforeEach(() => {
    jest.resetModules()
    mockSend.mockReset()
    mockSend.mockResolvedValue({ data: { id: 'n-1' }, error: null })
    process.env.RESEND_API_KEY = 're_test_key'
  })
  afterAll(() => {
    delete process.env.RESEND_API_KEY
  })

  it('sin opts: html y text idénticos a los de antes y sin encabezados', async () => {
    const mod = await import('../../../src/services/resend.service')
    const ok = await mod.sendNotificationEmail(
      'ana.duena@gmail.com',
      'Asunto',
      'Ana no ha checado',
      'Entraba a las 9:00\nVan 20 minutos',
      'https://dashboard.avoqado.io/x',
      'Ver asistencia',
    )
    expect(ok).toBe(true)
    const args = mockSend.mock.calls[0][0]
    expect(Object.keys(args).sort()).toEqual(['from', 'html', 'subject', 'text', 'to'])
    expect(sha(args.html)).toBe('43dd6367718a2164de94a1f1db5d22ab6080eaac9ce533f9e4fbab39797abb99')
    expect(sha(args.text)).toBe('2506e4c02c68db312d0276b7a72b549aa8e966e4a1e5a12d2417b5aab436d4c2')
  })

  it('sin opts y sin liga: también idéntico', async () => {
    const mod = await import('../../../src/services/resend.service')
    await mod.sendNotificationEmail('ana.duena@gmail.com', 'Asunto', 'Titulo', 'Mensaje')
    const args = mockSend.mock.calls[0][0]
    expect(args.headers).toBeUndefined()
    expect(sha(args.html)).toBe('635630bb46885743721e48fc37bd990cb5523feadd8818078aa6d01cabfbe2cc')
    expect(sha(args.text)).toBe('d31e1e874d034d09b5f8cf61a6b9cf61e67b447d3fcab9893d87cbec1def2f46')
  })

  it('con unsubscribeUrl: liga «Dejar de recibir estos correos» en el pie y en el texto, y los encabezados de un clic', async () => {
    const mod = await import('../../../src/services/resend.service')
    const url = 'https://api.avoqado.io/api/v1/public/unsubscribe?token=abc.def'
    await mod.sendNotificationEmail('ana.duena@gmail.com', 'Asunto', 'Titulo', 'Mensaje', 'https://x', 'Ver reserva', {
      unsubscribeUrl: url,
    })
    const args = mockSend.mock.calls[0][0]
    expect(args.html).toContain(`<a href="${url}"`)
    expect(args.html).toContain('Dejar de recibir estos correos')
    expect(args.text).toContain(`Dejar de recibir estos correos: ${url}`)
    expect(args.headers).toEqual({
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
    // La plantilla sigue con su logo dos veces y el CTA negro.
    expect(args.html.split('https://avoqado.io/isotipo.svg').length - 1).toBe(2)
    expect(args.html).toContain('background: #000000')
  })
})
