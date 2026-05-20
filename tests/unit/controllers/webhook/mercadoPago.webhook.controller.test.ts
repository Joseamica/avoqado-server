import crypto from 'crypto'
import { handleMercadoPagoWebhook } from '@/controllers/webhook/mercadoPago.webhook.controller'
import * as paymentFlowService from '@/services/mercado-pago/payment-flow.service'

jest.mock('@/services/mercado-pago/payment-flow.service')

const SECRET = process.env.MP_WEBHOOK_SECRET!

function buildRes() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  res.send = jest.fn().mockReturnValue(res)
  return res
}

function buildSignedRequest({
  dataId = '9999',
  requestId = 'req-1',
  payload = {
    id: 1,
    live_mode: false,
    type: 'payment',
    action: 'payment.updated',
    data: { id: dataId },
    user_id: 12345678,
    api_version: 'v1',
    date_created: '2026-05-20T19:00:00Z',
  },
  passDataIdInQuery = true,
  ts = String(Math.floor(Date.now() / 1000)),
}: {
  dataId?: string
  requestId?: string
  payload?: any
  passDataIdInQuery?: boolean
  ts?: string
} = {}) {
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`
  const v1 = crypto.createHmac('sha256', SECRET).update(manifest).digest('hex')
  const headers: Record<string, string> = {
    'x-signature': `ts=${ts},v1=${v1}`,
    'x-request-id': requestId,
  }
  return {
    body: Buffer.from(JSON.stringify(payload)),
    headers,
    query: passDataIdInQuery ? { 'data.id': dataId } : {},
    get: (h: string) => headers[h.toLowerCase()],
  } as any
}

beforeEach(() => jest.clearAllMocks())

describe('handleMercadoPagoWebhook', () => {
  it('returns 200 + dispatches when signature is valid', async () => {
    ;(paymentFlowService.handleIpn as jest.Mock).mockResolvedValue({
      status: 'processed',
      checkoutSessionId: 'cs_1',
      paymentId: '9999',
    })

    const req = buildSignedRequest()
    const res = buildRes()
    await handleMercadoPagoWebhook(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(paymentFlowService.handleIpn).toHaveBeenCalled()
    const ipnCall = (paymentFlowService.handleIpn as jest.Mock).mock.calls[0][0]
    expect(ipnCall.requestId).toBe('req-1')
    expect(ipnCall.payload.data.id).toBe('9999')
  })

  it('returns 200 (idempotent) on duplicate delivery', async () => {
    ;(paymentFlowService.handleIpn as jest.Mock).mockResolvedValue({ status: 'duplicate' })

    const req = buildSignedRequest()
    const res = buildRes()
    await handleMercadoPagoWebhook(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'duplicate' }))
  })

  it('returns 401 on invalid signature', async () => {
    const req: any = {
      body: Buffer.from(JSON.stringify({ data: { id: '9999' } })),
      headers: {
        'x-signature': 'ts=1700000000,v1=deadbeef00000000',
        'x-request-id': 'r',
      },
      query: { 'data.id': '9999' },
      get: (h: string) => ({ 'x-signature': 'ts=1700000000,v1=deadbeef00000000', 'x-request-id': 'r' })[h.toLowerCase()],
    }
    const res = buildRes()
    await handleMercadoPagoWebhook(req, res)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(paymentFlowService.handleIpn).not.toHaveBeenCalled()
  })

  it('returns 400 when x-signature or x-request-id is missing', async () => {
    const req: any = {
      body: Buffer.from('{}'),
      headers: {},
      query: {},
      get: () => undefined,
    }
    const res = buildRes()
    await handleMercadoPagoWebhook(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('returns 400 when body is invalid JSON', async () => {
    const req = buildSignedRequest()
    req.body = Buffer.from('not-json-at-all')
    const res = buildRes()
    await handleMercadoPagoWebhook(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('returns 200 (not 500) when handleIpn throws — MP must not retry endlessly', async () => {
    ;(paymentFlowService.handleIpn as jest.Mock).mockRejectedValue(new Error('boom'))

    const req = buildSignedRequest()
    const res = buildRes()
    await handleMercadoPagoWebhook(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'dispatch_failed' }))
  })

  it('falls back to bodyDataId when query lacks data.id', async () => {
    ;(paymentFlowService.handleIpn as jest.Mock).mockResolvedValue({
      status: 'processed',
      checkoutSessionId: 'cs_1',
      paymentId: '9999',
    })
    const req = buildSignedRequest({ passDataIdInQuery: false })
    const res = buildRes()
    await handleMercadoPagoWebhook(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
  })
})
