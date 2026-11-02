jest.mock('@/services/whatsapp.service', () => ({
  sendServiceMessage: jest.fn().mockResolvedValue({ messageId: 'wamid.RESPUESTA' }),
  WhatsappCloudApiError: class WhatsappCloudApiError extends Error {},
}))

import { createHmac } from 'crypto'

import request from 'supertest'

import app from '@/app'
import logger from '@/config/logger'
import { sendServiceMessage } from '@/services/whatsapp.service'
import prisma from '@/utils/prismaClient'

// Only the GET verification handshake lives here — it's mock-safe (no DB).
// POST inbound dispatch tests need real DB and live in
// tests/integration/webhook/whatsapp.webhook.test.ts.
describe('GET /api/v1/webhooks/whatsapp', () => {
  beforeAll(() => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token'
  })

  it('returns challenge string on valid handshake', async () => {
    const res = await request(app)
      .get('/api/v1/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': '12345' })
    expect(res.status).toBe(200)
    expect(res.text).toBe('12345')
  })

  it('returns 403 on invalid token', async () => {
    const res = await request(app)
      .get('/api/v1/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '12345' })
    expect(res.status).toBe(403)
  })

  it('returns 403 on missing mode', async () => {
    const res = await request(app).get('/api/v1/webhooks/whatsapp').query({})
    expect(res.status).toBe(403)
  })
})

// CRM fase 3: un aviso del WhatsApp de ventas, firmado y por la ruta real (parser crudo → freno → firma → servicio).
describe('POST /api/v1/webhooks/whatsapp — número de ventas', () => {
  const APP_SECRET = 'test-app-secret'
  const VENTAS = '172120185993202'
  const db = prisma as any
  const firmado = (payload: unknown) => {
    const body = JSON.stringify(payload)
    const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex')
    return request(app).post('/api/v1/webhooks/whatsapp').set('X-Hub-Signature-256', sig).set('Content-Type', 'application/json').send(body)
  }

  beforeAll(() => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET
    process.env.WHATSAPP_PHONE_NUMBER_ID = '111000111'
    process.env.WHATSAPP_SALES_PHONE_NUMBER_ID = VENTAS
  })
  afterAll(() => {
    delete process.env.WHATSAPP_SALES_PHONE_NUMBER_ID
  })
  beforeEach(() => {
    db.crmWhatsappMessage.createMany.mockResolvedValue({ count: 0 })
  })

  it('un historial de más de 100 KB entra completo (antes: 413) y no se le contesta a nadie', async () => {
    const messages = Array.from({ length: 1500 }, (_, i) => ({
      id: `wamid.H${i}`,
      from: '5215511112222',
      timestamp: '1762100000',
      type: 'text',
      text: { body: `mensaje viejo número ${i} con algo de texto` },
    }))
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba',
          changes: [
            {
              field: 'history',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '525640070001', phone_number_id: VENTAS },
                history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads: [{ id: '5215511112222', messages }] }],
              },
            },
          ],
        },
      ],
    }
    expect(JSON.stringify(payload).length).toBeGreaterThan(100 * 1024)

    const res = await firmado(payload)

    expect(res.status).toBe(200)
    expect(db.crmWhatsappMessage.createMany.mock.calls.flatMap((c: any[]) => c[0].data)).toHaveLength(1500)
    expect(sendServiceMessage).not.toHaveBeenCalled()
  })

  it('las alertas de plantillas (sin número en el aviso) siguen llegando a su manejador', async () => {
    const res = await firmado({
      entry: [
        { id: 'waba', changes: [{ field: 'message_template_status_update', value: { event: 'PAUSED', message_template_name: 'x' } }] },
      ],
    })

    expect(res.status).toBe(200)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[ADMIN ALERT] Template x PAUSED'))
    expect(sendServiceMessage).not.toHaveBeenCalled()
  })

  // Codex r2 #1: el lector de 20 MB es sólo para el POST de Meta; un GET con cuerpo sigue con el tope general de 100 KB.
  it('un GET con un cuerpo de más de 100 KB no pasa por el lector grande', async () => {
    const res = await request(app)
      .get('/api/v1/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ relleno: 'x'.repeat(200 * 1024) }))
    expect(res.status).toBe(413)
  })

  it('un POST con firma mal formada se va con 403 antes de leerse', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/whatsapp')
      .set('X-Hub-Signature-256', 'sha256=corta')
      .set('Content-Type', 'application/json')
      .send('{}')
    expect(res.status).toBe(403)
  })
})
