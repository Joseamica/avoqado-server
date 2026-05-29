/**
 * Integration test — POST /api/v1/webhooks/angelpay/:merchantAccountId
 *
 * Exercises the full Express stack (controller → service) with a REAL
 * Svix-signed payload. The service layer is mocked so no Prisma/DB
 * connection is required, but signature verification runs against
 * the real svix library (Webhook.verify).
 *
 * Signing approach: svix's own `Webhook.sign()` (confirmed public method
 * in svix ^1.84.1). Returns the `v1,<hmac-sha256-base64>` string that
 * svix's verifier expects. No manual HMAC needed.
 */

import crypto from 'crypto'

import express from 'express'
import request from 'supertest'
import { Webhook } from 'svix'

// ── Mock service + Prisma ─────────────────────────────────────────────────────
// Must be hoisted above imports that consume the module.
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

// Generate a fresh Svix-format secret for this test run
const RAW_KEY = crypto.randomBytes(32)
const TEST_SECRET = 'whsec_' + RAW_KEY.toString('base64')

const merchantRow = {
  id: 'ma_1',
  externalMerchantId: '351',
  angelpayWebhookSecret: TEST_SECRET,
}

const mockedMerchantAccountFindFirst = prisma.merchantAccount.findFirst as jest.Mock

/** Build a correctly Svix-signed request helper */
function makeSvixHeaders(body: string, msgId: string, ts: Date): { 'svix-id': string; 'svix-timestamp': string; 'svix-signature': string } {
  const wh = new Webhook(TEST_SECRET)
  const signature = wh.sign(msgId, ts, body)
  return {
    'svix-id': msgId,
    'svix-timestamp': String(Math.floor(ts.getTime() / 1000)),
    'svix-signature': signature,
  }
}

const VALID_BODY = JSON.stringify({
  event_type: 'send_transaction',
  id_merchant: 351,
  payload: { amount: 10, integratorReference: 'ref-int-1', terminalSerial: '12345678', status: 'approved' },
})

// ── Minimal Express app (mirrors webhook.routes.ts setup) ─────────────────────

const app = express()
// express.raw() ensures req.body is a Buffer — required for svix verify
app.post('/webhooks/angelpay/:merchantAccountId', express.raw({ type: 'application/json' }), handleAngelPayWebhook)

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /webhooks/angelpay/:merchantAccountId (integration — real Svix sign+verify)', () => {
  beforeAll(() => {
    mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
  })

  beforeEach(() => {
    // Clear call history between tests to avoid state leaking across assertions
    ;(service.processAngelPayWebhook as jest.Mock).mockClear()
    mockedMerchantAccountFindFirst.mockClear()
    mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
  })

  afterAll(() => {
    jest.restoreAllMocks()
  })

  it('accepts a properly Svix-signed payload and returns 200 with MATCHED action', async () => {
    const msgId = 'msg_int_1'
    const ts = new Date(Math.floor(Date.now() / 1000) * 1000) // truncate to seconds
    const svixHeaders = makeSvixHeaders(VALID_BODY, msgId, ts)

    const res = await request(app)
      .post('/webhooks/angelpay/ma_1')
      .set('Content-Type', 'application/json')
      .set('svix-id', svixHeaders['svix-id'])
      .set('svix-timestamp', svixHeaders['svix-timestamp'])
      .set('svix-signature', svixHeaders['svix-signature'])
      .send(VALID_BODY)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ action: 'MATCHED' })
    expect(service.processAngelPayWebhook).toHaveBeenCalledTimes(1)
  })

  it('rejects a request with no Svix headers with 401', async () => {
    const res = await request(app).post('/webhooks/angelpay/ma_1').set('Content-Type', 'application/json').send(VALID_BODY)

    expect(res.status).toBe(401)
    expect(service.processAngelPayWebhook).not.toHaveBeenCalled()
  })

  it('rejects a request with a tampered body (signature mismatch) with 401', async () => {
    const msgId = 'msg_int_tampered'
    const ts = new Date(Math.floor(Date.now() / 1000) * 1000)
    // Sign the original body, then send a different body
    const svixHeaders = makeSvixHeaders(VALID_BODY, msgId, ts)
    const tamperedBody = JSON.stringify({
      event_type: 'send_transaction',
      id_merchant: 999,
      payload: { amount: 999 },
    })

    const res = await request(app)
      .post('/webhooks/angelpay/ma_1')
      .set('Content-Type', 'application/json')
      .set('svix-id', svixHeaders['svix-id'])
      .set('svix-timestamp', svixHeaders['svix-timestamp'])
      .set('svix-signature', svixHeaders['svix-signature'])
      .send(tamperedBody)

    expect(res.status).toBe(401)
    expect(service.processAngelPayWebhook).not.toHaveBeenCalled()
  })

  it('returns 404 when merchantAccountId is unknown', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValueOnce(null)

    const res = await request(app).post('/webhooks/angelpay/unknown_id').set('Content-Type', 'application/json').send(VALID_BODY)

    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ error: 'unknown merchant' })
    expect(service.processAngelPayWebhook).not.toHaveBeenCalled()
  })

  it('returns 503 when merchant has no angelpayWebhookSecret', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValueOnce({ ...merchantRow, angelpayWebhookSecret: null })

    const res = await request(app).post('/webhooks/angelpay/ma_1').set('Content-Type', 'application/json').send(VALID_BODY)

    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ error: 'webhook not provisioned for this merchant' })
  })

  it('accepts webhook-* alias headers (AngelPay reference impl emits both)', async () => {
    const msgId = 'msg_int_alias'
    const ts = new Date(Math.floor(Date.now() / 1000) * 1000)
    const svixHeaders = makeSvixHeaders(VALID_BODY, msgId, ts)

    const res = await request(app)
      .post('/webhooks/angelpay/ma_1')
      .set('Content-Type', 'application/json')
      // Use webhook-* aliases instead of svix-*
      .set('webhook-id', svixHeaders['svix-id'])
      .set('webhook-timestamp', svixHeaders['svix-timestamp'])
      .set('webhook-signature', svixHeaders['svix-signature'])
      .send(VALID_BODY)

    expect(res.status).toBe(200)
    expect(service.processAngelPayWebhook).toHaveBeenCalledTimes(1)
  })
})
