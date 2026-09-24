// El receptor HTTP del webhook de Facturapi: que el cuerpo llegue CRUDO (la firma es un HMAC del cuerpo tal
// cual) y que cada desenlace se traduzca al status correcto.
import express from 'express'
import request from 'supertest'

jest.mock('../../../../src/config/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }))

const mockProcesar = jest.fn()
jest.mock('../../../../src/services/fiscal/facturapiWebhook.service', () => ({
  procesarAvisoDeFacturapi: (...a: any[]) => mockProcesar(...a),
  defaultProcesarAvisoDeps: () => ({}),
}))

import { handleFacturapiWebhook } from '../../../../src/controllers/webhook/facturapi.webhook.controller'

function app() {
  const a = express()
  // Mismo montaje que src/app.ts
  a.post('/api/v1/webhooks/facturapi/:emisorId', express.raw({ type: '*/*', limit: '1mb' }), handleFacturapiWebhook)
  return a
}

describe('POST /api/v1/webhooks/facturapi/:emisorId', () => {
  beforeEach(() => mockProcesar.mockReset())

  it('pasa el cuerpo CRUDO byte por byte, el emisor de la URL y la firma del header', async () => {
    mockProcesar.mockResolvedValue({ http: 200, resultado: 'REVISADA' })
    const cuerpo = '{"type":"invoice.cancellation_status_updated",  "data":{"object":{"id":"fa-1"}}}'
    const res = await request(app())
      .post('/api/v1/webhooks/facturapi/e1')
      .set('Content-Type', 'application/json')
      .set('Facturapi-Signature', 'abc123')
      .send(cuerpo)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true, resultado: 'REVISADA' })
    const [params] = mockProcesar.mock.calls[0]
    expect(params.emisorId).toBe('e1')
    expect(params.firma).toBe('abc123')
    expect(Buffer.isBuffer(params.cuerpo)).toBe(true)
    expect(params.cuerpo.toString('utf8')).toBe(cuerpo) // sin re-serializar: los espacios siguen ahí
  })

  it('firma inválida ⇒ 401', async () => {
    mockProcesar.mockResolvedValue({ http: 401, resultado: 'FIRMA_INVALIDA' })
    const res = await request(app()).post('/api/v1/webhooks/facturapi/e1').set('Content-Type', 'application/json').send('{}')
    expect(res.status).toBe(401)
    expect(res.body.received).toBe(false)
  })

  it('si procesar falla (p. ej. el PAC no contesta) ⇒ 503 para que Facturapi reintente', async () => {
    mockProcesar.mockRejectedValue(new Error('PAC caído'))
    const res = await request(app()).post('/api/v1/webhooks/facturapi/e1').set('Content-Type', 'application/json').send('{}')
    expect(res.status).toBe(503)
  })
})
