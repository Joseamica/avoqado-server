/**
 * Integration test — POST /api/v1/webhooks/angelpay/:merchantAccountId
 *
 * Exercises the full Express stack (controller → service) with a REAL
 * HMAC-SHA256 signed payload matching the actual AngelPay production scheme.
 * The service layer is mocked so no Prisma/DB connection is required,
 * but signature verification runs against the real crypto implementation.
 *
 * Real AngelPay signature scheme (reverse-engineered from live capture, 2026-05-29):
 *   HMAC_SHA256(key=fullSecretWithWhsecPrefix, body=rawBytes).hexdigest()
 *   key is NOT base64-decoded — the full "whsec_..." string is used as raw UTF-8
 */

import crypto from 'crypto'

import express from 'express'
import request from 'supertest'

// ── Mock service + Prisma ─────────────────────────────────────────────────────
jest.mock('@/services/tpv/angelpay-webhook.service', () => ({
  ...jest.requireActual('@/services/tpv/angelpay-webhook.service'),
  processAngelPayWebhook: jest.fn().mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt_int', paymentId: 'pay_int' }),
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    merchantAccount: {
      findFirst: jest.fn(),
    },
  },
}))

import * as service from '@/services/tpv/angelpay-webhook.service'
import prisma from '@/utils/prismaClient'
import { handleAngelPayWebhook } from '@/controllers/tpv/angelpay-webhook.tpv.controller'

// ── Test fixtures ─────────────────────────────────────────────────────────────

// Use a fixed whsec_-prefixed secret (same format as production)
const TEST_SECRET = 'whsec_' + crypto.randomBytes(32).toString('hex')

const merchantRow = {
  id: 'ma_1',
  externalMerchantId: '351',
  angelpayWebhookSecret: TEST_SECRET,
}

const mockedMerchantAccountFindFirst = prisma.merchantAccount.findFirst as jest.Mock

/**
 * Sign a body string with the real AngelPay HMAC scheme.
 * Returns the lowercase hex digest to send as X-Webhook-Signature.
 */
function signBody(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

// Real-shape production body (no id_merchant, amount in centavos)
const VALID_BODY = JSON.stringify({
  event_type: 'send_transaction',
  payload: {
    amount: '000000001000', // 1000 cents = $10.00 MXN
    integratorReference: 'ref-int-1',
    terminalSerial: 'N860W175781',
    status: 'approved',
    transactionId: '260528195230',
    timestamp: '2026-05-29T00:52:32.000Z',
    description: 'APROBADA',
  },
})

// ── Minimal Express app ───────────────────────────────────────────────────────

const app = express()
// express.raw() ensures req.body is a Buffer — required for HMAC verification
app.post('/webhooks/angelpay/:merchantAccountId', express.raw({ type: 'application/json' }), handleAngelPayWebhook)

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /webhooks/angelpay/:merchantAccountId (integration — real HMAC sign+verify)', () => {
  beforeAll(() => {
    mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
  })

  beforeEach(() => {
    ;(service.processAngelPayWebhook as jest.Mock).mockClear()
    mockedMerchantAccountFindFirst.mockClear()
    mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
  })

  afterAll(() => {
    jest.restoreAllMocks()
  })

  it('accepts a properly HMAC-signed payload and returns 200 with MATCHED action', async () => {
    const sig = signBody(TEST_SECRET, VALID_BODY)

    const res = await request(app)
      .post('/webhooks/angelpay/ma_1')
      .set('Content-Type', 'application/json')
      .set('x-webhook-event-id', 'evt_int_1')
      .set('x-webhook-timestamp', '2026-05-29T00:53:14.104341+00:00')
      .set('x-webhook-event', 'send_transaction')
      .set('x-webhook-signature', sig)
      .send(VALID_BODY)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ action: 'MATCHED' })
    expect(service.processAngelPayWebhook).toHaveBeenCalledTimes(1)
    // Confirm eventId is passed through correctly
    expect(service.processAngelPayWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt_int_1' }),
    )
  })

  it('rejects a request with no X-Webhook-Signature header with 401', async () => {
    const res = await request(app)
      .post('/webhooks/angelpay/ma_1')
      .set('Content-Type', 'application/json')
      .send(VALID_BODY)

    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ error: 'missing signature headers' })
    expect(service.processAngelPayWebhook).not.toHaveBeenCalled()
  })

  it('rejects a request with a tampered body (signature mismatch) with 401', async () => {
    // Sign the original body, then send a different body
    const sig = signBody(TEST_SECRET, VALID_BODY)
    const tamperedBody = JSON.stringify({
      event_type: 'send_transaction',
      payload: { amount: '000000099900', integratorReference: 'evil' },
    })

    const res = await request(app)
      .post('/webhooks/angelpay/ma_1')
      .set('Content-Type', 'application/json')
      .set('x-webhook-event-id', 'evt_tampered')
      .set('x-webhook-signature', sig) // signature is for original body, not tampered
      .send(tamperedBody)

    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ error: 'invalid signature' })
    expect(service.processAngelPayWebhook).not.toHaveBeenCalled()
  })

  it('rejects a request with a wrong/garbage signature with 401', async () => {
    const res = await request(app)
      .post('/webhooks/angelpay/ma_1')
      .set('Content-Type', 'application/json')
      .set('x-webhook-event-id', 'evt_garbage')
      .set('x-webhook-signature', 'deadbeef00000000000000000000000000000000000000000000000000000000')
      .send(VALID_BODY)

    expect(res.status).toBe(401)
    expect(service.processAngelPayWebhook).not.toHaveBeenCalled()
  })

  it('returns 404 when merchantAccountId is unknown', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValueOnce(null)

    const res = await request(app)
      .post('/webhooks/angelpay/unknown_id')
      .set('Content-Type', 'application/json')
      .send(VALID_BODY)

    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ error: 'unknown merchant' })
    expect(service.processAngelPayWebhook).not.toHaveBeenCalled()
  })

  it('returns 503 when merchant has no angelpayWebhookSecret', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValueOnce({ ...merchantRow, angelpayWebhookSecret: null })

    const res = await request(app)
      .post('/webhooks/angelpay/ma_1')
      .set('Content-Type', 'application/json')
      .send(VALID_BODY)

    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ error: 'webhook not provisioned for this merchant' })
  })
})
