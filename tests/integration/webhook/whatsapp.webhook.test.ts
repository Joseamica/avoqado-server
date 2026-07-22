import { createHmac } from 'crypto'

import request from 'supertest'

import app from '@/app'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/whatsapp.service', () => ({
  sendServiceMessage: jest.fn().mockResolvedValue({ messageId: 'wamid.TEST_REPLY' }),
  WhatsappCloudApiError: class WhatsappCloudApiError extends Error {
    cloudApiErrorCode = 'TEST'
  },
}))

const APP_SECRET = 'test-app-secret'

function postWebhook(payload: unknown) {
  const body = JSON.stringify(payload)
  const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex')
  return request(app).post('/api/v1/webhooks/whatsapp').set('X-Hub-Signature-256', sig).set('Content-Type', 'application/json').send(body)
}

const textMessagePayload = (wamid: string, fromPhone = '525511112222', body = 'hola') => ({
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            messages: [
              {
                id: wamid,
                from: fromPhone,
                type: 'text',
                text: { body },
                timestamp: String(Math.floor(Date.now() / 1000)),
              },
            ],
          },
        },
      ],
    },
  ],
})

describe('POST /api/v1/webhooks/whatsapp (dispatch — integration with real DB)', () => {
  beforeAll(() => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token'
    process.env.WHATSAPP_APP_SECRET = APP_SECRET
  })

  beforeEach(async () => {
    await prisma.whatsappInboundEvent.deleteMany({
      where: { wamid: { startsWith: 'wamid.TEST_' } },
    })
    await prisma.whatsappContactWindow.deleteMany({
      where: { phone: { in: ['+525511112222', '+525500001111'] } },
    })
  })

  afterAll(async () => {
    await prisma.whatsappInboundEvent.deleteMany({
      where: { wamid: { startsWith: 'wamid.TEST_' } },
    })
    await prisma.whatsappContactWindow.deleteMany({
      where: { phone: { in: ['+525511112222', '+525500001111'] } },
    })
    await prisma.$disconnect()
  })

  it('rejects POST without HMAC signature with 403', async () => {
    const res = await request(app).post('/api/v1/webhooks/whatsapp').set('Content-Type', 'application/json').send({})
    expect(res.status).toBe(403)
  })

  it('inserts WhatsappInboundEvent for a new wamid and returns 200', async () => {
    const res = await postWebhook(textMessagePayload('wamid.TEST_NEW1'))
    expect(res.status).toBe(200)
    const ev = await prisma.whatsappInboundEvent.findUnique({ where: { wamid: 'wamid.TEST_NEW1' } })
    expect(ev).not.toBeNull()
    expect(ev?.messageType).toBe('text')
    expect(ev?.processedAt).not.toBeNull()
    // Since venue-chat routing (dcf9c5a2), plain text without quote context is
    // answered with the "no context" nudge instead of being silently ignored.
    expect(ev?.routedAs).toBe('VENUE_REPLY_NO_CONTEXT')
  })

  it('skips duplicate wamid and returns 200', async () => {
    await postWebhook(textMessagePayload('wamid.TEST_DUP1'))
    const res = await postWebhook(textMessagePayload('wamid.TEST_DUP1'))
    expect(res.status).toBe(200)
    const count = await prisma.whatsappInboundEvent.count({ where: { wamid: 'wamid.TEST_DUP1' } })
    expect(count).toBe(1)
  })

  it('upserts WhatsappContactWindow for the sender phone', async () => {
    await postWebhook(textMessagePayload('wamid.TEST_WIN1', '525500001111'))
    const w = await prisma.whatsappContactWindow.findUnique({ where: { phone: '+525500001111' } })
    expect(w).not.toBeNull()
    expect(w?.lastInboundAt).not.toBeNull()
  })

  it('processes batched messages — duplicate of one does not skip the others', async () => {
    await postWebhook(textMessagePayload('wamid.TEST_BATCH_A'))
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  { id: 'wamid.TEST_BATCH_A', from: '525511112222', type: 'text', text: { body: 'a' }, timestamp: '1' },
                  { id: 'wamid.TEST_BATCH_B', from: '525511112222', type: 'text', text: { body: 'b' }, timestamp: '1' },
                ],
              },
            },
          ],
        },
      ],
    }
    const res = await postWebhook(payload)
    expect(res.status).toBe(200)
    const b = await prisma.whatsappInboundEvent.findUnique({ where: { wamid: 'wamid.TEST_BATCH_B' } })
    expect(b).not.toBeNull()
  })

  it('handles statuses-only payload (no messages array) — does not persist statuses', async () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [{ id: 'wamid.TEST_STATUS_X', status: 'delivered', timestamp: '1', recipient_id: '525511112222' }],
              },
            },
          ],
        },
      ],
    }
    const res = await postWebhook(payload)
    expect(res.status).toBe(200)
    const ev = await prisma.whatsappInboundEvent.findUnique({ where: { wamid: 'wamid.TEST_STATUS_X' } })
    expect(ev).toBeNull()
  })
})
