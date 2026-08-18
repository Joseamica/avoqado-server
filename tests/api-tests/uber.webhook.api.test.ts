import crypto from 'crypto'
import request from 'supertest'
import app from '@/app'
import { persistUberWebhookEvent } from '@/services/delivery-channels/providers/uber-eats/uber.webhookIngress'

jest.mock('@/services/delivery-channels/providers/uber-eats/uber.webhookIngress', () => ({
  persistUberWebhookEvent: jest.fn(),
}))
const persistMock = persistUberWebhookEvent as jest.MockedFunction<typeof persistUberWebhookEvent>

// Camino HTTP del webhook: montaje raw, códigos y — lo que Uber exige — BODY VACÍO.
describe('POST /api/v1/webhooks/delivery/uber', () => {
  const body = { event_id: 'evt-1', event_type: 'orders.notification', meta: { resource_id: 'o1', user_id: 's1' } }
  const raw = Buffer.from(JSON.stringify(body))
  const post = (sig?: string) => {
    const r = request(app).post('/api/v1/webhooks/delivery/uber').set('Content-Type', 'application/json')
    return (sig ? r.set('X-Uber-Signature', sig) : r).send(raw)
  }
  beforeEach(() => persistMock.mockReset())

  it('evento persistido ⇒ 200 con BODY VACÍO (Uber lo exige así)', async () => {
    persistMock.mockResolvedValue({ outcome: 'PERSISTED', eventRowId: 'row-1' })
    const res = await post(crypto.randomBytes(32).toString('hex'))
    expect(res.status).toBe(200)
    expect(res.text).toBe('') // sendStatus(200) mandaría "OK" y rompería el contrato
  })

  it('duplicado ⇒ 200 vacío también (reintentar no aporta nada)', async () => {
    persistMock.mockResolvedValue({ outcome: 'DUPLICATE' })
    const res = await post(crypto.randomBytes(32).toString('hex'))
    expect(res.status).toBe(200)
    expect(res.text).toBe('')
  })

  it('firma inválida ⇒ 401', async () => {
    persistMock.mockResolvedValue({ outcome: 'INVALID_SIGNATURE' })
    expect((await post('f'.repeat(64))).status).toBe(401)
  })

  it('payload sin event_id ⇒ 400', async () => {
    persistMock.mockResolvedValue({ outcome: 'MALFORMED' })
    expect((await post(crypto.randomBytes(32).toString('hex'))).status).toBe(400)
  })

  it('fallo al persistir ⇒ 503 para que Uber REINTENTE (persist-first)', async () => {
    persistMock.mockRejectedValue(new Error('db caída'))
    expect((await post(crypto.randomBytes(32).toString('hex'))).status).toBe(503)
  })

  it('el body llega como Buffer al servicio (la firma se calcula sobre bytes crudos)', async () => {
    persistMock.mockResolvedValue({ outcome: 'PERSISTED' })
    await post(crypto.randomBytes(32).toString('hex'))
    expect(Buffer.isBuffer(persistMock.mock.calls[0][0].rawBody)).toBe(true)
  })

  it('health responde', async () => {
    const res = await request(app).get('/api/v1/webhooks/delivery/uber/health')
    expect(res.status).toBe(200)
    expect(res.body.provider).toBe('UBER_EATS')
  })
})
