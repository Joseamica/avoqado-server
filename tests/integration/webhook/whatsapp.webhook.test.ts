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
const CENTRAL = '111000111'
const VENTAS = '172120185993202'
// Meta stamps every `messages` delivery with the number that received it; only the central one is ever answered.
const metadata = (phoneNumberId = CENTRAL) => ({ display_phone_number: '525640070001', phone_number_id: phoneNumberId })

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
            metadata: metadata(),
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
    process.env.WHATSAPP_PHONE_NUMBER_ID = CENTRAL
    process.env.WHATSAPP_SALES_PHONE_NUMBER_ID = VENTAS
  })

  beforeEach(async () => {
    await prisma.crmWhatsappMessage.deleteMany({ where: { wamid: { startsWith: 'wamid.TEST_' } } })
    await prisma.whatsappInboundEvent.deleteMany({
      where: { wamid: { startsWith: 'wamid.TEST_' } },
    })
    await prisma.whatsappContactWindow.deleteMany({
      where: { phone: { in: ['+525511112222', '+525500001111'] } },
    })
  })

  afterAll(async () => {
    delete process.env.WHATSAPP_SALES_PHONE_NUMBER_ID
    await prisma.crmWhatsappMessage.deleteMany({ where: { wamid: { startsWith: 'wamid.TEST_' } } })
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
                metadata: metadata(),
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

  // CRM fase 3: the sales number in coexistence. Stored once in the CRM, never answered, and it never touches the central
  // number's tables (its 24 h window would let the central think it may write to a prospect).
  it('sales number: a loose text is stored once in the CRM (also on a Meta retry) and never answered', async () => {
    const { sendServiceMessage } = jest.requireMock('@/services/whatsapp.service') as { sendServiceMessage: jest.Mock }
    sendServiceMessage.mockClear()
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: metadata(VENTAS),
                contacts: [{ profile: { name: 'Prospecto' }, wa_id: '5215500001111' }],
                messages: [
                  { id: 'wamid.TEST_SALES1', from: '5215500001111', type: 'text', text: { body: 'hola' }, timestamp: '1762100000' },
                ],
              },
            },
          ],
        },
      ],
    }

    expect((await postWebhook(payload)).status).toBe(200)
    expect((await postWebhook(payload)).status).toBe(200)

    const rows = await prisma.crmWhatsappMessage.findMany({ where: { wamid: 'wamid.TEST_SALES1' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      phoneNumberId: VENTAS,
      contactPhone: '+525500001111',
      contactName: 'Prospecto',
      direction: 'ENTRA',
      body: 'hola',
    })
    expect(sendServiceMessage).not.toHaveBeenCalled()
    expect(await prisma.whatsappInboundEvent.findUnique({ where: { wamid: 'wamid.TEST_SALES1' } })).toBeNull()
    expect(await prisma.whatsappContactWindow.findUnique({ where: { phone: '+525500001111' } })).toBeNull()
  })

  it('sales number: an echo of what the founder sent from his phone is stored as SALE', async () => {
    const res = await postWebhook({
      entry: [
        {
          changes: [
            {
              field: 'smb_message_echoes',
              value: {
                metadata: metadata(VENTAS),
                message_echoes: [
                  {
                    from: '525640070001',
                    to: '5215500001111',
                    id: 'wamid.TEST_ECHO1',
                    timestamp: '1762100001',
                    type: 'text',
                    text: { body: 'te llamo' },
                  },
                ],
              },
            },
          ],
        },
      ],
    })

    expect(res.status).toBe(200)
    const row = await prisma.crmWhatsappMessage.findUnique({ where: { wamid: 'wamid.TEST_ECHO1' } })
    expect(row).toMatchObject({ direction: 'SALE', origin: 'ECO', contactPhone: '+525500001111', body: 'te llamo' })
  })
})
