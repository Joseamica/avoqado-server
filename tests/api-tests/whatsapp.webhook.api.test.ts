import request from 'supertest'

import app from '@/app'

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
