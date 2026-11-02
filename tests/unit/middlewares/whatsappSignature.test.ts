import { createHmac } from 'crypto'

import { requireWhatsappSignatureHeader, verifyWhatsappSignature } from '@/middlewares/whatsappSignature.middleware'

const APP_SECRET = 'test-app-secret'

function signedRequest(body: string) {
  const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex')
  return { header: (name: string) => (name === 'X-Hub-Signature-256' ? sig : ''), body: Buffer.from(body) }
}

describe('verifyWhatsappSignature', () => {
  beforeAll(() => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET
  })

  it('passes through valid signature', () => {
    const req = signedRequest('{"hello":"world"}') as unknown as Parameters<typeof verifyWhatsappSignature>[0]
    const res = { sendStatus: jest.fn() } as unknown as Parameters<typeof verifyWhatsappSignature>[1]
    const next = jest.fn()
    verifyWhatsappSignature(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.sendStatus as jest.Mock).not.toHaveBeenCalled()
  })

  it('rejects missing signature with 403', () => {
    const req = { header: () => '', body: Buffer.from('{}') } as unknown as Parameters<typeof verifyWhatsappSignature>[0]
    const res = { sendStatus: jest.fn() } as unknown as Parameters<typeof verifyWhatsappSignature>[1]
    const next = jest.fn()
    verifyWhatsappSignature(req, res, next)
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects mismatched signature length without throwing', () => {
    const req = { header: () => 'sha256=short', body: Buffer.from('{}') } as unknown as Parameters<typeof verifyWhatsappSignature>[0]
    const res = { sendStatus: jest.fn() } as unknown as Parameters<typeof verifyWhatsappSignature>[1]
    const next = jest.fn()
    expect(() => verifyWhatsappSignature(req, res, next)).not.toThrow()
    expect(res.sendStatus).toHaveBeenCalledWith(403)
  })

  it('rejects wrong signature with 403', () => {
    const req = {
      header: () => 'sha256=' + 'f'.repeat(64),
      body: Buffer.from('{"hello":"world"}'),
    } as unknown as Parameters<typeof verifyWhatsappSignature>[0]
    const res = { sendStatus: jest.fn() } as unknown as Parameters<typeof verifyWhatsappSignature>[1]
    const next = jest.fn()
    verifyWhatsappSignature(req, res, next)
    expect(res.sendStatus).toHaveBeenCalledWith(403)
  })

  it('rejects non-Buffer body with 403 (express.raw not mounted)', () => {
    const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update('{"hello":"world"}').digest('hex')
    const req = {
      header: () => sig,
      body: { hello: 'world' },
    } as unknown as Parameters<typeof verifyWhatsappSignature>[0]
    const res = { sendStatus: jest.fn() } as unknown as Parameters<typeof verifyWhatsappSignature>[1]
    const next = jest.fn()
    verifyWhatsappSignature(req, res, next)
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })
})

// CRM fase 3: la ruta acepta avisos de historial de hasta 5 MB. Antes de leer el cuerpo, lo que no trae una firma bien
// formada se va con 403. Sin contador a propósito (rondas 1-3 de Codex): 5 MB ya es el tope del servidor sin firma.
describe('requireWhatsappSignatureHeader', () => {
  type Req = Parameters<typeof requireWhatsappSignatureHeader>[0]
  type Res = Parameters<typeof requireWhatsappSignatureHeader>[1]
  const pasa = (firma?: string) => {
    const req = { header: (name: string) => (name === 'X-Hub-Signature-256' ? firma : undefined) } as unknown as Req
    const res = { sendStatus: jest.fn() } as unknown as Res
    const next = jest.fn()
    requireWhatsappSignatureHeader(req, res, next)
    return { next, status: (res.sendStatus as jest.Mock).mock.calls[0]?.[0] }
  }

  it.each([
    ['sin firma', undefined],
    ['firma mal formada', 'sha256=corta'],
    ['firma en mayúsculas (Meta manda minúsculas)', 'sha256=' + 'A'.repeat(64)],
  ])('%s: 403 sin leer el cuerpo', (_caso, firma) => {
    const { next, status } = pasa(firma)
    expect(status).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('una firma bien formada pasa (si es la buena lo decide verifyWhatsappSignature, ya con el cuerpo)', () => {
    expect(pasa('sha256=' + 'a'.repeat(64)).next).toHaveBeenCalled()
  })
})
