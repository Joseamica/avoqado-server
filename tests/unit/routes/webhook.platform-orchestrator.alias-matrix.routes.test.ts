import express from 'express'
import request from 'supertest'

const constructEvent = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    webhooks: { constructEvent },
  })),
)
jest.mock('@/config/env', () => ({
  env: {
    STRIPE_SECRET_KEY: 'sk_test_platform',
    STRIPE_WEBHOOK_SECRET: 'whsec_platform',
    PLATFORM_WEBHOOK_ORCHESTRATOR_MODE: 'SHADOW',
  },
}))
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
jest.mock('@/services/payments/providers/stripe-connect.provider', () => ({
  StripeConnectProvider: jest.fn().mockImplementation(() => ({ verifyWebhookSignature: jest.fn() })),
}))
jest.mock('@/services/payments/reservation-deposit-webhook.service', () => ({ processStripeConnectWebhookEvent: jest.fn() }))

const inertHandler = jest.fn()
jest.mock('@/controllers/webhook/whatsapp.webhook.controller', () => ({
  handleWhatsappInbound: inertHandler,
  handleWhatsappVerify: inertHandler,
}))
jest.mock('@/middlewares/whatsappSignature.middleware', () => ({ verifyWhatsappSignature: inertHandler }))
jest.mock('@/controllers/tpv/blumon-webhook.tpv.controller', () => ({
  handleBlumonTPVWebhook: inertHandler,
  blumonWebhookHealthCheck: inertHandler,
}))
jest.mock('@/controllers/tpv/angelpay-webhook.tpv.controller', () => ({
  handleAngelPayWebhook: inertHandler,
  angelpayWebhookHealthCheck: inertHandler,
}))
jest.mock('@/controllers/tpv/b4bit-webhook.tpv.controller', () => ({
  handleB4BitWebhook: inertHandler,
  b4bitWebhookHealthCheck: inertHandler,
}))
jest.mock('@/controllers/webhooks/resend.webhook.controller', () => ({
  handleResendWebhook: inertHandler,
  resendWebhookHealthCheck: inertHandler,
}))
jest.mock('@/middlewares/blumon-ip-whitelist.middleware', () => ({ blumonIPWhitelist: inertHandler }))
jest.mock('@/controllers/delivery-channels/deliverect.webhook.controller', () => ({
  handleDeliverectOrderWebhook: inertHandler,
  deliverectWebhookHealthCheck: inertHandler,
}))
jest.mock('@/controllers/delivery-channels/uber.webhook.controller', () => ({
  handleUberWebhook: inertHandler,
  uberWebhookHealthCheck: inertHandler,
}))

import { WebhookEventConflictError } from '@/services/stripe-webhooks/platformWebhookInbox.service'
import router from '@/routes/webhook.routes'

const stripeEvent = { id: 'evt-alias', type: 'invoice.paid', data: { object: { id: 'in-alias' } } }

function app() {
  const server = express()
  server.use(express.raw({ type: 'application/json' }))
  server.use(router)
  return server
}

beforeEach(() => {
  jest.clearAllMocks()
  constructEvent.mockReturnValue(stripeEvent)
  observe.mockResolvedValue({ event: { id: 'whe-alias' }, created: true })
  processIngress.mockResolvedValue({ classification: 'COMPLETED', effect: 'COMPLETED' })
})

describe.each(['/stripe', '/stripe/platform'])('platform alias HTTP matrix %s', alias => {
  it('returns 503 with Retry-After only when observe cannot confirm durability', async () => {
    observe.mockRejectedValueOnce(new Error('db unavailable'))

    const response = await request(app()).post(alias).set('stripe-signature', 'sig').type('application/json').send('{}')

    expect(response.status).toBe(503)
    expect(response.headers['retry-after']).toBe('5')
    expect(response.body).toEqual({ success: false, code: 'PLATFORM_WEBHOOK_NOT_DURABLE' })
    expect(processIngress).not.toHaveBeenCalled()
  })

  it('returns accepted 200 immediately after durability', async () => {
    processIngress.mockReturnValueOnce(new Promise(() => undefined))

    const response = await request(app()).post(alias).set('stripe-signature', 'sig').type('application/json').send('{}')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      success: true,
      code: 'PLATFORM_WEBHOOK_ACCEPTED',
      message: 'Webhook processed successfully',
      eventId: 'evt-alias',
      eventType: 'invoice.paid',
    })
  })

  it('returns immutable-conflict 200 without dispatching', async () => {
    observe.mockRejectedValueOnce(new WebhookEventConflictError(stripeEvent.id))

    const response = await request(app()).post(alias).set('stripe-signature', 'sig').type('application/json').send('{}')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ success: false, code: 'PLATFORM_WEBHOOK_IMMUTABLE_CONFLICT' })
    expect(processIngress).not.toHaveBeenCalled()
  })
})
