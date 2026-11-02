import { createHmac } from 'crypto'

import { EventEmitter } from 'events'

import { gateWhatsappBody, verifyWhatsappSignature } from '@/middlewares/whatsappSignature.middleware'

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

// CRM fase 3 (Codex r1 #2): la ruta acepta avisos de historial de hasta 20 MB. Antes de leer el cuerpo, lo que no trae una
// firma bien formada se va con 403, y sólo UN cuerpo grande a la vez se lee; el siguiente recibe 503 y Meta lo reintenta.
describe('gateWhatsappBody', () => {
  type Req = Parameters<typeof gateWhatsappBody>[0]
  type Res = Parameters<typeof gateWhatsappBody>[1]
  const FIRMA = 'sha256=' + 'a'.repeat(64)
  const pedido = (headers: Record<string, string>) =>
    ({ method: 'POST', header: (name: string) => headers[name.toLowerCase()] }) as unknown as Req
  const respuesta = () => Object.assign(new EventEmitter(), { sendStatus: jest.fn(), locals: {} }) as unknown as Res & EventEmitter
  const pasa = (req: Req, res = respuesta()) => {
    const next = jest.fn()
    gateWhatsappBody(req, res, next)
    return { res, next, status: (res.sendStatus as jest.Mock).mock.calls[0]?.[0] }
  }

  it.each([
    ['sin firma', {}],
    ['firma mal formada', { 'x-hub-signature-256': 'sha256=corta' }],
  ])('%s: 403 sin leer el cuerpo', (_caso, headers) => {
    const { next, status } = pasa(pedido({ ...headers, 'content-length': '30000000' }))
    expect(status).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('un aviso chico siempre pasa, aunque haya uno grande leyéndose', () => {
    const grande = pasa(pedido({ 'x-hub-signature-256': FIRMA, 'content-length': '5000000' }))
    expect(grande.next).toHaveBeenCalled()
    expect(pasa(pedido({ 'x-hub-signature-256': FIRMA, 'content-length': '2000' })).next).toHaveBeenCalled()
    grande.res.emit('close')
  })

  it('un segundo aviso grande (o sin tamaño) espera: 503; al cerrar el primero, vuelve a pasar', () => {
    const primero = pasa(pedido({ 'x-hub-signature-256': FIRMA, 'content-length': '5000000' }))
    expect(primero.next).toHaveBeenCalled()
    expect(pasa(pedido({ 'x-hub-signature-256': FIRMA, 'content-length': '5000000' })).status).toBe(503)
    expect(pasa(pedido({ 'x-hub-signature-256': FIRMA })).status).toBe(503)

    primero.res.emit('close')
    primero.res.emit('close') // un solo descuento aunque el evento se repita
    const segundo = pasa(pedido({ 'x-hub-signature-256': FIRMA, 'content-length': '5000000' }))
    expect(segundo.next).toHaveBeenCalled()
    expect(pasa(pedido({ 'x-hub-signature-256': FIRMA, 'content-length': '5000000' })).status).toBe(503)
    segundo.res.emit('close')
  })

  // Codex r2 #1: 2 KB comprimidos se inflan a 2 MB; el tamaño declarado no dice nada.
  it('un aviso comprimido cuenta como grande aunque declare pocos bytes', () => {
    const primero = pasa(pedido({ 'x-hub-signature-256': FIRMA, 'content-length': '2000', 'content-encoding': 'gzip' }))
    expect(primero.next).toHaveBeenCalled()
    expect(pasa(pedido({ 'x-hub-signature-256': FIRMA, 'content-length': '2000', 'content-encoding': 'gzip' })).status).toBe(503)
    primero.res.emit('close')
  })

  // Codex r2 #2: si Meta corta la conexión mientras se guarda, el cupo sigue tomado hasta que el guardado termina.
  it('el cupo no se suelta al cortarse la conexión mientras el controlador sigue guardando', () => {
    const primero = pasa(pedido({ 'x-hub-signature-256': FIRMA, 'content-length': '5000000' }))
    const res = primero.res as unknown as { locals: { whatsappHandling?: boolean; releaseWhatsappBody?: () => void } }
    res.locals.whatsappHandling = true
    primero.res.emit('close')
    expect(pasa(pedido({ 'x-hub-signature-256': FIRMA, 'content-length': '5000000' })).status).toBe(503)

    res.locals.releaseWhatsappBody!()
    res.locals.releaseWhatsappBody!() // soltarlo dos veces no regala un cupo
    const segundo = pasa(pedido({ 'x-hub-signature-256': FIRMA, 'content-length': '5000000' }))
    expect(segundo.next).toHaveBeenCalled()
    expect(pasa(pedido({ 'x-hub-signature-256': FIRMA, 'content-length': '5000000' })).status).toBe(503)
    segundo.res.emit('close')
  })
})
