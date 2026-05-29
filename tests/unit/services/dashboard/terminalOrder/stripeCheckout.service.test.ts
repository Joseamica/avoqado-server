// Mock Stripe constructor — must be hoisted before the import
const sessionsCreateMock = jest.fn()
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: sessionsCreateMock } },
  }))
})

jest.mock('../../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminalOrder: { update: jest.fn() },
  },
}))

import { createCheckoutSessionForOrder } from '@/services/dashboard/terminalOrder/stripeCheckout.service'

const prisma = require('../../../../../src/utils/prismaClient').default

const orderWithItems = {
  id: 'ord_1',
  orderNumber: 'AVO-0001',
  venueId: 'venue_1',
  contactEmail: 'buyer@example.com',
  totalCents: 464_000,
  subtotalCents: 400_000,
  taxCents: 64_000,
  currency: 'MXN',
  paymentMethod: 'CARD_STRIPE',
  paymentStatus: 'AWAITING_PAYMENT',
  items: [{ productName: 'PAX A910S', quantity: 1, unitPriceCents: 400_000 }],
}

describe('createCheckoutSessionForOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    sessionsCreateMock.mockResolvedValue({ id: 'cs_test_123', url: 'https://checkout.stripe.com/test' })
  })

  it('creates a session with metadata.terminalOrderId and totalCents amounts', async () => {
    await createCheckoutSessionForOrder({
      order: orderWithItems as any,
      successUrl: 'https://app/success',
      cancelUrl: 'https://app/cancel',
    })

    const args = sessionsCreateMock.mock.calls[0][0]
    expect(args.mode).toBe('payment')
    expect(args.customer_email).toBe('buyer@example.com')
    expect(args.metadata.terminalOrderId).toBe('ord_1')
    expect(args.metadata.venueId).toBe('venue_1')
    expect(args.success_url).toBe('https://app/success')
    expect(args.cancel_url).toBe('https://app/cancel')
    expect(args.payment_intent_data.receipt_email).toBe('buyer@example.com')
  })

  it('emits one line_item per order item plus a tax line', async () => {
    await createCheckoutSessionForOrder({
      order: orderWithItems as any,
      successUrl: 's',
      cancelUrl: 'c',
    })
    const args = sessionsCreateMock.mock.calls[0][0]
    expect(args.line_items).toHaveLength(2)
    expect(args.line_items[0].price_data.unit_amount).toBe(400_000)
    expect(args.line_items[0].quantity).toBe(1)
    expect(args.line_items[1].price_data.unit_amount).toBe(64_000)
    expect(args.line_items[1].quantity).toBe(1)
    expect(args.line_items[0].price_data.currency).toBe('mxn')
  })

  it('persists stripeCheckoutSessionId on the order', async () => {
    await createCheckoutSessionForOrder({
      order: orderWithItems as any,
      successUrl: 's',
      cancelUrl: 'c',
    })
    expect(prisma.terminalOrder.update).toHaveBeenCalledWith({
      where: { id: 'ord_1' },
      data: { stripeCheckoutSessionId: 'cs_test_123' },
    })
  })

  it('returns the redirect URL', async () => {
    const result = await createCheckoutSessionForOrder({
      order: orderWithItems as any,
      successUrl: 's',
      cancelUrl: 'c',
    })
    expect(result).toEqual({
      sessionId: 'cs_test_123',
      redirectUrl: 'https://checkout.stripe.com/test',
    })
  })
})
