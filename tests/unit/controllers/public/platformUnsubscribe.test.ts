/**
 * La página pública de baja de los correos de Avoqado: el GET sólo muestra (los clientes de correo precargan ligas) y el POST
 * da de baja — es el destino del clic de RFC 8058 y del botón. Un token malo no revela nada y no escribe nada.
 */
import { getPlatformUnsubscribePage, postPlatformUnsubscribe } from '@/controllers/public/platformUnsubscribe.public.controller'
import { optOut } from '@/services/crm/email/optOut.service'
import { signPlatformUnsubscribeToken } from '@/utils/platformUnsubscribeToken'

jest.mock('@/services/crm/email/optOut.service', () => ({ optOut: jest.fn() }))

const mockOptOut = optOut as jest.Mock

function mockRes() {
  const res: any = { statusCode: 200, body: '' }
  res.status = jest.fn((c: number) => {
    res.statusCode = c
    return res
  })
  res.type = jest.fn(() => res)
  res.send = jest.fn((b: string) => {
    res.body = b
    return res
  })
  return res
}

// asyncHandler no devuelve su promesa (como Express): hay que dejar que la cadena asíncrona termine antes de afirmar.
const flush = () => new Promise(resolve => setImmediate(resolve))

const TOKEN = signPlatformUnsubscribeToken('ana@example.com')
const req = (query: Record<string, unknown>): any => ({ query, originalUrl: '/api/v1/public/avoqado/unsubscribe?token=x', ip: '1.2.3.4' })

async function run(handler: typeof getPlatformUnsubscribePage, query: Record<string, unknown>) {
  const res = mockRes()
  await handler(req(query), res, jest.fn())
  await flush()
  return res
}

beforeEach(() => mockOptOut.mockReset().mockResolvedValue(undefined))

describe('GET /avoqado/unsubscribe', () => {
  it('🔴 con un token válido muestra la pregunta y el botón, y NO escribe nada', async () => {
    const res = await run(getPlatformUnsubscribePage, { token: TOKEN })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('¿Dejar de recibir los correos de Avoqado?')
    expect(res.body).toContain('Sí, darme de baja')
    expect(res.body).toContain('<form method="POST"')
    expect(mockOptOut).not.toHaveBeenCalled()
  })

  it('el formulario manda el POST a esta misma liga con el token, y no repite el correo en la página', async () => {
    const res = await run(getPlatformUnsubscribePage, { token: TOKEN })
    expect(res.body).toContain(`action="?token=${TOKEN}"`)
    expect(res.body).not.toContain('ana@example.com')
  })

  it.each([
    ['sin token', {}],
    ['alterado', { token: `${TOKEN.slice(0, -2)}AA` }],
    ['basura', { token: 'x.y' }],
    ['repetido (?token=a&token=b)', { token: [TOKEN, TOKEN] }],
    ['objeto (?token[a]=b)', { token: { a: 'b' } }],
  ])('token %s: 400 con «Esta liga no es válida» y sin escribir', async (_nombre, query) => {
    const res = await run(getPlatformUnsubscribePage, query)
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('Esta liga no es válida')
    expect(mockOptOut).not.toHaveBeenCalled()
  })
})

describe('POST /avoqado/unsubscribe', () => {
  it('con un token válido da de baja al correo del token (origen UN_CLIC, sin staff) y contesta «Listo»', async () => {
    const res = await run(postPlatformUnsubscribe, { token: TOKEN })

    expect(mockOptOut).toHaveBeenCalledTimes(1)
    expect(mockOptOut).toHaveBeenCalledWith('ana@example.com', 'UN_CLIC')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Listo: ya no te llegarán correos de Avoqado')
  })

  it('el correo sale del token firmado: nada de lo demás que mande el cliente lo cambia', async () => {
    const res = mockRes()
    const r = req({ token: TOKEN, email: 'victima@example.com' })
    r.body = { email: 'victima@example.com' }
    await postPlatformUnsubscribe(r, res, jest.fn())
    await flush()
    expect(mockOptOut).toHaveBeenCalledWith('ana@example.com', 'UN_CLIC')
  })

  it('es idempotente: el reintento de Gmail o Yahoo contesta igual de bien', async () => {
    const a = await run(postPlatformUnsubscribe, { token: TOKEN })
    const b = await run(postPlatformUnsubscribe, { token: TOKEN })
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)
    expect(mockOptOut).toHaveBeenCalledTimes(2) // el servicio es el idempotente (skipDuplicates)
  })

  it.each([
    ['sin token', {}],
    ['alterado', { token: `${TOKEN.slice(0, -2)}AA` }],
    ['de otro propósito', { token: 'e30.AAAA' }],
    ['repetido', { token: [TOKEN, TOKEN] }],
  ])('token %s: 400 con «Esta liga no es válida» y NO da de baja a nadie', async (_nombre, query) => {
    const res = await run(postPlatformUnsubscribe, query)
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('Esta liga no es válida')
    expect(mockOptOut).not.toHaveBeenCalled()
  })

  it('si la base falla, NO contesta «Listo» (el cliente de correo reintentará): el error sigue su camino', async () => {
    mockOptOut.mockRejectedValue(new Error('db caída'))
    const res = mockRes()
    const next = jest.fn()
    await postPlatformUnsubscribe(req({ token: TOKEN }), res, next)
    await flush()
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'db caída' }))
    expect(res.send).not.toHaveBeenCalled()
  })
})
