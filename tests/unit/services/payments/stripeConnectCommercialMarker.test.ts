import { prismaMock } from '@tests/__helpers__/setup'

const finalizePaymentLinkCheckout = jest.fn()
const finalizeVenueCheckout = jest.fn()
const fulfillCreditPackPurchase = jest.fn()

jest.mock('@/services/dashboard/paymentLink.service', () => ({
  finalizePaymentLinkCheckout: (...args: unknown[]) => finalizePaymentLinkCheckout(...args),
}))
jest.mock('@/services/dashboard/venueCheckout.service', () => ({
  finalizeVenueCheckout: (...args: unknown[]) => finalizeVenueCheckout(...args),
}))
jest.mock('@/services/dashboard/creditPack.public.service', () => ({
  fulfillPurchase: (...args: unknown[]) => fulfillCreditPackPurchase(...args),
}))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendReservationConfirmedEmail: jest.fn() },
}))
jest.mock('@/services/whatsapp.service', () => ({
  sendReservationConfirmationWhatsApp: jest.fn(),
  formatModifiersForWhatsApp: jest.fn(),
}))

import logger from '@/config/logger'
import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'

const markerEvent = {
  id: 'evt_connect_commercial_1',
  type: 'checkout.session.completed',
  account: 'acct_connect_1',
  livemode: false,
  data: {
    id: 'cs_commercial_wrong_endpoint',
    payment_status: 'paid',
    payment_intent: 'pi_commercial_wrong_endpoint',
    amount_total: 199900,
    metadata: {
      type: 'commercial_subscription_v1',
      acceptanceId: 'acceptance-untrusted-pointer',
    },
  },
}

const nestedInvoiceMarkerCases = [
  {
    shape: 'parent.subscription_details.metadata',
    event: {
      id: 'evt_connect_invoice_parent_1',
      type: 'invoice.paid',
      account: 'acct_connect_1',
      livemode: false,
      data: {
        id: 'in_connect_parent_1',
        parent: {
          subscription_details: {
            metadata: {
              type: 'commercial_subscription_v1',
              acceptanceId: 'acceptance-untrusted-parent',
            },
          },
        },
      },
    },
  },
  {
    shape: 'subscription_details.metadata',
    event: {
      id: 'evt_connect_invoice_legacy_1',
      type: 'invoice.payment_failed',
      account: 'acct_connect_1',
      livemode: false,
      data: {
        id: 'in_connect_legacy_1',
        subscription_details: {
          metadata: {
            type: 'commercial_subscription_v1',
            acceptanceId: 'acceptance-untrusted-legacy',
          },
        },
      },
    },
  },
] as const

function expectNoMerchantOrSaasEffects() {
  expect(finalizePaymentLinkCheckout).not.toHaveBeenCalled()
  expect(finalizeVenueCheckout).not.toHaveBeenCalled()
  expect(fulfillCreditPackPurchase).not.toHaveBeenCalled()
  expect(prismaMock.$transaction).not.toHaveBeenCalled()
  expect(prismaMock.reservation.findFirst).not.toHaveBeenCalled()
  expect(prismaMock.reservation.updateMany).not.toHaveBeenCalled()
  expect(prismaMock.checkoutSession.updateMany).not.toHaveBeenCalled()
  expect(prismaMock.ecommerceMerchant.updateMany).not.toHaveBeenCalled()
  expect(prismaMock.venueFeature.upsert).not.toHaveBeenCalled()
  expect(prismaMock.terminalOrder.updateMany).not.toHaveBeenCalled()
  expect(prismaMock.tokenPurchase.updateMany).not.toHaveBeenCalled()
}

describe('Stripe Connect commercial marker separation', () => {
  beforeEach(() => {
    prismaMock.processedStripeEvent.create.mockResolvedValue({ id: 'processed-connect-marker-1' })
  })

  it('claims and acknowledges the first marker delivery with zero merchant or SaaS effects', async () => {
    await expect(processStripeConnectWebhookEvent(markerEvent)).resolves.toBeUndefined()

    expect(prismaMock.processedStripeEvent.create).toHaveBeenCalledWith({
      data: {
        stripeEventId: markerEvent.id,
        endpoint: 'connect',
        eventType: markerEvent.type,
        account: markerEvent.account,
        payload: markerEvent.data,
      },
    })
    expect(logger.error).toHaveBeenCalledWith(
      'Stripe Connect rejected a SaaS commercial marker',
      expect.objectContaining({
        securityEvent: 'STRIPE_CONNECT_SAAS_MARKER_REJECTED',
        eventId: markerEvent.id,
        eventType: markerEvent.type,
      }),
    )
    expectNoMerchantOrSaasEffects()
  })

  it('keeps a duplicate marker delivery as a no-op', async () => {
    prismaMock.processedStripeEvent.create
      .mockResolvedValueOnce({ id: 'processed-connect-marker-1' })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 'P2002' }))

    await expect(processStripeConnectWebhookEvent(markerEvent)).resolves.toBeUndefined()
    await expect(processStripeConnectWebhookEvent(markerEvent)).resolves.toBeUndefined()

    expect(prismaMock.processedStripeEvent.create).toHaveBeenCalledTimes(2)
    expectNoMerchantOrSaasEffects()
  })

  describe.each(nestedInvoiceMarkerCases)('$shape invoice marker', ({ event }) => {
    it('claims and acknowledges first delivery with a security log and zero effects', async () => {
      await expect(processStripeConnectWebhookEvent(event)).resolves.toBeUndefined()

      expect(prismaMock.processedStripeEvent.create).toHaveBeenCalledWith({
        data: {
          stripeEventId: event.id,
          endpoint: 'connect',
          eventType: event.type,
          account: event.account,
          payload: event.data,
        },
      })
      expect(logger.error).toHaveBeenCalledWith(
        'Stripe Connect rejected a SaaS commercial marker',
        expect.objectContaining({
          securityEvent: 'STRIPE_CONNECT_SAAS_MARKER_REJECTED',
          eventId: event.id,
          eventType: event.type,
        }),
      )
      expectNoMerchantOrSaasEffects()
    })

    it('acknowledges duplicate delivery without repeating effects or the rejection log', async () => {
      prismaMock.processedStripeEvent.create
        .mockResolvedValueOnce({ id: 'processed-connect-marker-1' })
        .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 'P2002' }))

      await expect(processStripeConnectWebhookEvent(event)).resolves.toBeUndefined()
      await expect(processStripeConnectWebhookEvent(event)).resolves.toBeUndefined()

      expect(prismaMock.processedStripeEvent.create).toHaveBeenCalledTimes(2)
      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(logger.info).toHaveBeenCalledWith(
        'Stripe Connect duplicate SaaS commercial marker ignored',
        expect.objectContaining({
          securityEvent: 'STRIPE_CONNECT_SAAS_MARKER_DUPLICATE',
          eventId: event.id,
        }),
      )
      expectNoMerchantOrSaasEffects()
    })
  })
})
