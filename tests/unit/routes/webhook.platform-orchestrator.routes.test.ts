const platformHandler = jest.fn()
const connectHandler = jest.fn()
const inertHandler = jest.fn()

jest.mock('@/controllers/webhook.controller', () => ({
  handleStripeWebhook: platformHandler,
  handleStripeConnectWebhook: connectHandler,
}))
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

import router from '@/routes/webhook.routes'

function postHandler(path: string) {
  const layer = (router as any).stack.find((candidate: any) => candidate.route?.path === path && candidate.route?.methods?.post)
  return layer?.route?.stack?.at(-1)?.handle
}

describe('platform webhook route aliases', () => {
  it('routes both platform aliases to the persist-first platform controller', () => {
    expect(postHandler('/stripe')).toBe(platformHandler)
    expect(postHandler('/stripe/platform')).toBe(platformHandler)
  })

  it('keeps Stripe Connect on its separate unchanged controller', () => {
    expect(postHandler('/stripe/connect')).toBe(connectHandler)
    expect(postHandler('/stripe/connect')).not.toBe(platformHandler)
  })
})
