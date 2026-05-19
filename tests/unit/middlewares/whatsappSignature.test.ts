import { createHmac } from 'crypto'

import { verifyWhatsappSignature } from '@/middlewares/whatsappSignature.middleware'

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
