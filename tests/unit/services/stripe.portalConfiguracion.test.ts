/**
 * R0 (Codex, 21-sep-2026): los dos emisores del Billing Portal de Stripe no fijaban configuración, así que
 * mandaba la de la cuenta — y si ésa deja cambiar de plan o de precio, el cliente se saltaría toda la
 * coordinación de la compra. Con `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` puesta, las sesiones nuevas usan
 * la configuración restringida. (Crear esa configuración en la cuenta de producción es un paso humano.)
 */
const mockPortal = jest.fn()
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ billingPortal: { sessions: { create: mockPortal } } })))
jest.mock('../../../src/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import { createCustomerPortalSession, generateBillingPortalUrl } from '../../../src/services/stripe.service'

const ORIGINAL = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID
beforeEach(() => {
  mockPortal.mockReset().mockResolvedValue({ url: 'https://billing.stripe.com/p/x' })
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
})
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID
  else process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = ORIGINAL
})

describe('el Billing Portal usa la configuración restringida', () => {
  it.each([
    ['createCustomerPortalSession', () => createCustomerPortalSession('cus_1', 'https://dash/x')],
    ['generateBillingPortalUrl', () => generateBillingPortalUrl('cus_1', 'https://dash/x')],
  ])('🔴 %s manda `configuration` cuando está definida', async (_n, abrir) => {
    process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = 'bpc_restringida'

    await abrir()

    expect(mockPortal).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_1', configuration: 'bpc_restringida' }))
  })

  it('sin la variable, se comporta como antes (no manda `configuration`)', async () => {
    delete process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID

    await createCustomerPortalSession('cus_1', 'https://dash/x')

    expect(mockPortal.mock.calls[0][0]).not.toHaveProperty('configuration')
  })
})
