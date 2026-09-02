const constructEvent = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    webhooks: { constructEvent },
  })),
)
const controllerEnv = {
  STRIPE_SECRET_KEY: 'sk_test_platform',
  STRIPE_WEBHOOK_SECRET: 'whsec_platform',
  PLATFORM_WEBHOOK_ORCHESTRATOR_MODE: 'SHADOW',
}
jest.mock('@/config/env', () => ({ env: controllerEnv }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const observe = jest.fn()
const processIngress = jest.fn()
jest.mock('@/services/stripe-webhooks/platformWebhookRuntime.service', () => ({
  platformWebhookRuntime: {
    mode: 'SHADOW',
    inbox: { observe },
    processor: { processIngress },
  },
}))
const verifyConnectEvent = jest.fn()
const processConnectEvent = jest.fn()
jest.mock('@/services/payments/providers/stripe-connect.provider', () => ({
  StripeConnectProvider: jest.fn().mockImplementation(() => ({ verifyWebhookSignature: verifyConnectEvent })),
}))
jest.mock('@/services/payments/reservation-deposit-webhook.service', () => ({
  processStripeConnectWebhookEvent: processConnectEvent,
}))

import { WebhookEventConflictError } from '@/services/stripe-webhooks/platformWebhookInbox.service'
import { handleStripeConnectWebhook, handleStripeWebhook } from '@/controllers/webhook.controller'

function response() {
  const res: any = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status: jest.fn((code: number) => {
      res.statusCode = code
      return res
    }),
    set: jest.fn((name: string, value: string) => {
      res.headers[name] = value
      return res
    }),
    json: jest.fn((body: unknown) => {
      res.body = body
      return res
    }),
  }
  return res
}

const event = { id: 'evt-controller', type: 'invoice.paid', data: { object: { id: 'in-1' } } }

beforeEach(() => {
  jest.clearAllMocks()
  controllerEnv.STRIPE_WEBHOOK_SECRET = 'whsec_platform'
  constructEvent.mockReturnValue(event)
  observe.mockResolvedValue({ event: { id: 'whe-controller' }, created: true })
  processIngress.mockResolvedValue({ classification: 'COMPLETED', effect: 'COMPLETED' })
  verifyConnectEvent.mockResolvedValue({
    id: 'evt-connect',
    type: 'payment_intent.succeeded',
    account: 'acct-connect',
    data: { object: {} },
  })
  processConnectEvent.mockResolvedValue(undefined)
})

describe('Stripe Connect remains outside the platform orchestrator', () => {
  it('keeps the existing provider verification and Connect processor path with zero platform inbox calls', async () => {
    const body = Buffer.from('{"connect":true}')
    const res = response()

    await handleStripeConnectWebhook({ headers: { 'stripe-signature': 'sig-connect' }, body } as any, res, jest.fn())

    expect(verifyConnectEvent).toHaveBeenCalledWith(body, 'sig-connect', 'connect')
    expect(processConnectEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt-connect', account: 'acct-connect' }))
    expect(observe).not.toHaveBeenCalled()
    expect(processIngress).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      success: true,
      message: 'Connect webhook processed successfully',
      eventId: 'evt-connect',
      eventType: 'payment_intent.succeeded',
    })
  })

  it('keeps Connect signature rejection on its existing path with zero platform inbox calls', async () => {
    verifyConnectEvent.mockRejectedValueOnce(new Error('signature mismatch'))
    const res = response()

    await handleStripeConnectWebhook(
      { headers: { 'stripe-signature': 'sig-connect-invalid' }, body: Buffer.from('{}') } as any,
      res,
      jest.fn(),
    )

    expect(processConnectEvent).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
    expect(processIngress).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ success: false, error: 'Invalid signature' })
  })
})

describe('Stripe platform controller persist-first acknowledgement', () => {
  it('returns 503 + Retry-After when no durable row can be created or observed', async () => {
    observe.mockRejectedValueOnce(new Error('db unavailable'))
    const res = response()

    await handleStripeWebhook({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as any, res, jest.fn())

    expect(res.statusCode).toBe(503)
    expect(res.headers['Retry-After']).toBe('5')
    expect(res.body).toEqual({ success: false, code: 'PLATFORM_WEBHOOK_NOT_DURABLE' })
    expect(processIngress).not.toHaveBeenCalled()
  })

  it('acknowledges an immutable content conflict without processing the incoming payload', async () => {
    observe.mockRejectedValueOnce(new WebhookEventConflictError(event.id))
    const res = response()

    await handleStripeWebhook({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as any, res, jest.fn())

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ success: false, code: 'PLATFORM_WEBHOOK_IMMUTABLE_CONFLICT' })
    expect(processIngress).not.toHaveBeenCalled()
  })

  it('returns accepted 200 after durability even when inline processing fails', async () => {
    processIngress.mockRejectedValueOnce(new Error('effect failed'))
    const res = response()

    await handleStripeWebhook({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as any, res, jest.fn())

    expect(observe).toHaveBeenCalledWith({ stripeEventId: event.id, eventType: event.type, payload: event })
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      success: true,
      code: 'PLATFORM_WEBHOOK_ACCEPTED',
      message: 'Webhook processed successfully',
      eventId: event.id,
      eventType: event.type,
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(processIngress).toHaveBeenCalledWith('whe-controller', { mode: 'SHADOW', created: true })
  })

  it('acknowledges immediately after durability when inline processing never resolves', async () => {
    processIngress.mockReturnValueOnce(new Promise(() => undefined))
    const res = response()

    await expect(
      handleStripeWebhook({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as any, res, jest.fn()),
    ).resolves.toBeUndefined()

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(expect.objectContaining({ code: 'PLATFORM_WEBHOOK_ACCEPTED' }))
  })

  it('captures a best-effort rejection after ACK without leaking an unhandled rejection', async () => {
    const rejection = new Error('late effect failure')
    processIngress.mockRejectedValueOnce(rejection)
    const unhandled = jest.fn()
    process.once('unhandledRejection', unhandled)
    const res = response()

    await handleStripeWebhook({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as any, res, jest.fn())
    await new Promise(resolve => setImmediate(resolve))

    process.removeListener('unhandledRejection', unhandled)
    expect(res.statusCode).toBe(200)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it.each([
    [{}, 400, 'Missing stripe-signature header'],
    [{ 'stripe-signature': 'invalid' }, 400, 'Invalid signature'],
  ])('does not persist when signature verification fails', async (headers, status, error) => {
    if ('stripe-signature' in headers && headers['stripe-signature'])
      constructEvent.mockImplementationOnce(() => {
        throw new Error('bad signature')
      })
    const res = response()

    await handleStripeWebhook({ headers, body: Buffer.from('{}') } as any, res, jest.fn())

    expect(res.statusCode).toBe(status)
    expect(res.body).toEqual({ success: false, error })
    expect(observe).not.toHaveBeenCalled()
  })

  it('preserves the safe 500 response and does not persist when the platform secret is absent', async () => {
    controllerEnv.STRIPE_WEBHOOK_SECRET = ''
    const res = response()

    await handleStripeWebhook({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as any, res, jest.fn())

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ success: false, error: 'Webhook secret not configured' })
    expect(constructEvent).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
  })
})
