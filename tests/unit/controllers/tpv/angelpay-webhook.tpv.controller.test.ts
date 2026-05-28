import type { Request, Response } from 'express'

import { handleAngelPayWebhook, angelpayWebhookHealthCheck } from '@/controllers/tpv/angelpay-webhook.tpv.controller'
import * as service from '@/services/tpv/angelpay-webhook.service'

jest.mock('svix', () => {
  class Webhook {
    constructor(public secret: string) {}
    verify(body: Buffer, headers: Record<string, string>) {
      if (headers['svix-signature'] === 'bad') throw new Error('invalid signature')
      return JSON.parse(body.toString('utf8'))
    }
  }
  return { Webhook }
})

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

function mkReq(opts: { body?: object; headers?: Record<string, string>; params?: Record<string, string> }): Request {
  const raw = Buffer.from(JSON.stringify(opts.body ?? {}))
  return {
    body: raw,
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

const merchantRow = {
  id: 'ma_1',
  externalMerchantId: '351',
  angelpayWebhookSecret: 'whsec_x',
  venueConfigsPrimary: [{ venueId: 'venue_1' }],
  venueConfigsSecondary: [],
  venueConfigsTertiary: [],
}

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

  it('returns 401 when svix headers are missing', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
    const res = mkRes()
    await handleAngelPayWebhook(mkReq({ params: { merchantAccountId: 'ma_1' } }), res, jest.fn())
    expect(res.__status).toBe(401)
  })

  it('accepts webhook-* alias headers when svix-* are absent', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
    mockedProcess.mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt_1', paymentId: 'pay_1' })
    const res = mkRes()
    await handleAngelPayWebhook(
      mkReq({
        params: { merchantAccountId: 'ma_1' },
        body: { event_type: 'send_transaction', id_merchant: 351, payload: { amount: 10 } },
        headers: { 'webhook-id': 'msg_a', 'webhook-timestamp': '1', 'webhook-signature': 'good' },
      }),
      res,
      jest.fn(),
    )
    expect(res.__status).toBe(200)
    expect(mockedProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        svixId: 'msg_a',
        merchantAccount: expect.objectContaining({ id: 'ma_1', externalMerchantId: '351', venueId: 'venue_1' }),
      }),
    )
  })

  it('returns 401 when signature verification throws', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
    const res = mkRes()
    await handleAngelPayWebhook(
      mkReq({
        params: { merchantAccountId: 'ma_1' },
        body: { event_type: 'send_transaction', id_merchant: 351, payload: { amount: 10 } },
        headers: { 'svix-id': 'msg_b', 'svix-timestamp': '1', 'svix-signature': 'bad' },
      }),
      res,
      jest.fn(),
    )
    expect(res.__status).toBe(401)
    expect(mockedProcess).not.toHaveBeenCalled()
  })

  it('returns 200 + action body on success', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
    mockedProcess.mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt_9', paymentId: 'pay_9' })
    const res = mkRes()
    await handleAngelPayWebhook(
      mkReq({
        params: { merchantAccountId: 'ma_1' },
        body: { event_type: 'send_transaction', id_merchant: 351, payload: { amount: 10 } },
        headers: { 'svix-id': 'msg_c', 'svix-timestamp': '1', 'svix-signature': 'good' },
      }),
      res,
      jest.fn(),
    )
    expect(res.__status).toBe(200)
    expect(res.__body).toMatchObject({ action: 'MATCHED', eventLogId: 'evt_9', paymentId: 'pay_9' })
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
