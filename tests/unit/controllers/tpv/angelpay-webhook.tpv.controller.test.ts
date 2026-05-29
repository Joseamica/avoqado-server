import crypto from 'crypto'

import type { Request, Response } from 'express'

import { handleAngelPayWebhook, angelpayWebhookHealthCheck } from '@/controllers/tpv/angelpay-webhook.tpv.controller'
import * as service from '@/services/tpv/angelpay-webhook.service'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute the real AngelPay HMAC-SHA256 hex signature.
 * key = full secret string with "whsec_" prefix as raw UTF-8
 * body = raw JSON string bytes
 */
function sign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('@/services/tpv/angelpay-webhook.service', () => ({
  ...jest.requireActual('@/services/tpv/angelpay-webhook.service'),
  processAngelPayWebhook: jest.fn(),
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    merchantAccount: {
      findFirst: jest.fn(),
    },
  },
}))

import prisma from '@/utils/prismaClient'
const mockedMerchantAccountFindFirst = prisma.merchantAccount.findFirst as jest.Mock

const mockedProcess = service.processAngelPayWebhook as jest.Mock

// ── Request / Response builders ───────────────────────────────────────────────

/**
 * Build a minimal Express-like Request.
 * body should be a Buffer (the raw bytes that were signed).
 */
function mkReq(opts: {
  bodyBuf?: Buffer
  headers?: Record<string, string>
  params?: Record<string, string>
}): Request {
  return {
    body: opts.bodyBuf ?? Buffer.from('{}'),
    params: opts.params ?? {},
    header(name: string) {
      return opts.headers?.[name.toLowerCase()]
    },
  } as unknown as Request
}

function mkRes(): Response & { __status?: number; __body?: unknown } {
  const res: any = {}
  res.status = (n: number) => {
    res.__status = n
    return res
  }
  res.json = (b: unknown) => {
    res.__body = b
    return res
  }
  return res
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_SECRET = 'whsec_x'

const merchantRow = {
  id: 'ma_1',
  externalMerchantId: '351',
  angelpayWebhookSecret: TEST_SECRET,
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleAngelPayWebhook', () => {
  beforeEach(() => {
    mockedProcess.mockReset()
    mockedMerchantAccountFindFirst.mockReset()
  })

  it('returns 404 when merchantAccountId is unknown', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue(null)
    const res = mkRes()
    await handleAngelPayWebhook(mkReq({ params: { merchantAccountId: 'unknown' } }), res, jest.fn())
    expect(res.__status).toBe(404)
    expect(mockedProcess).not.toHaveBeenCalled()
  })

  it('returns 503 when merchant has no angelpayWebhookSecret', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue({ ...merchantRow, angelpayWebhookSecret: null })
    const res = mkRes()
    await handleAngelPayWebhook(mkReq({ params: { merchantAccountId: 'ma_1' } }), res, jest.fn())
    expect(res.__status).toBe(503)
  })

  it('returns 401 when x-webhook-signature header is missing', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
    const res = mkRes()
    // No x-webhook-signature or x-webhook-event-id
    await handleAngelPayWebhook(
      mkReq({ params: { merchantAccountId: 'ma_1' }, headers: {} }),
      res,
      jest.fn(),
    )
    expect(res.__status).toBe(401)
    expect((res.__body as any).error).toBe('missing signature headers')
    expect(mockedProcess).not.toHaveBeenCalled()
  })

  it('returns 401 when signature is invalid (wrong HMAC)', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
    const res = mkRes()
    const bodyStr = JSON.stringify({ event_type: 'send_transaction', payload: { amount: '100' } })
    await handleAngelPayWebhook(
      mkReq({
        params: { merchantAccountId: 'ma_1' },
        bodyBuf: Buffer.from(bodyStr),
        headers: {
          'x-webhook-event-id': 'evt_bad',
          'x-webhook-signature': 'deadbeef00000000000000000000000000000000000000000000000000000000',
        },
      }),
      res,
      jest.fn(),
    )
    expect(res.__status).toBe(401)
    expect((res.__body as any).error).toBe('invalid signature')
    expect(mockedProcess).not.toHaveBeenCalled()
  })

  it('returns 200 + action body on valid signature and successful processing', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
    mockedProcess.mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt_9', paymentId: 'pay_9' })

    const bodyStr = JSON.stringify({ event_type: 'send_transaction', payload: { amount: '10000', integratorReference: 'ref-x', status: 'approved' } })
    const sig = sign(TEST_SECRET, bodyStr)

    const res = mkRes()
    await handleAngelPayWebhook(
      mkReq({
        params: { merchantAccountId: 'ma_1' },
        bodyBuf: Buffer.from(bodyStr),
        headers: {
          'x-webhook-event-id': 'evt_1',
          'x-webhook-timestamp': '2026-05-29T00:53:14.104341+00:00',
          'x-webhook-signature': sig,
        },
      }),
      res,
      jest.fn(),
    )

    expect(res.__status).toBe(200)
    expect(res.__body).toMatchObject({ action: 'MATCHED', eventLogId: 'evt_9', paymentId: 'pay_9' })
    expect(mockedProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'evt_1',
        merchantAccount: expect.objectContaining({ id: 'ma_1', externalMerchantId: '351' }),
      }),
    )
  })
})

describe('angelpayWebhookHealthCheck', () => {
  it('returns 200 with success + timestamp', () => {
    const res = mkRes()
    angelpayWebhookHealthCheck({} as Request, res)
    expect(res.__status).toBe(200)
    expect(res.__body).toMatchObject({ success: true })
    expect((res.__body as any).timestamp).toBeDefined()
  })
})
