jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminalOrder: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}))

const sendPaymentConfirmedMock = jest.fn()
const sendSerialAssignmentMock = jest.fn()
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: {
    sendTerminalOrderPaymentConfirmed: sendPaymentConfirmedMock,
    sendTerminalOrderSerialAssignmentRequest: sendSerialAssignmentMock,
  },
}))

import { handleTerminalOrderCheckoutCompleted } from '@/services/stripe-webhooks/terminalOrderCheckoutCompleted.handler'
import prisma from '@/utils/prismaClient'

const baseSession: any = {
  id: 'cs_test_1',
  payment_intent: 'pi_test_1',
  payment_status: 'paid',
  metadata: { terminalOrderId: 'ord_1', venueId: 'venue_1' },
}

const baseOrder = {
  id: 'ord_1',
  orderNumber: 'AVO-0001',
  paymentStatus: 'AWAITING_PAYMENT',
  totalCents: 464_000,
  currency: 'MXN',
  contactEmail: 'buyer@example.com',
  items: [],
}

describe('handleTerminalOrderCheckoutCompleted', () => {
  // Plan 3 wired in signSerialAssignmentToken() inside the handler — it needs a
  // valid (>=16 chars) secret to sign the JWT that goes into the order row.
  const ORIG_SECRET = process.env.TERMINAL_ORDER_TOKEN_SECRET
  beforeAll(() => {
    process.env.TERMINAL_ORDER_TOKEN_SECRET = 'test-secret-32chars-min-required-x'
  })
  afterAll(() => {
    process.env.TERMINAL_ORDER_TOKEN_SECRET = ORIG_SECRET
  })

  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue(baseOrder)
    ;(prisma.terminalOrder.update as jest.Mock).mockResolvedValue({
      ...baseOrder,
      paymentStatus: 'PAID',
    })
  })

  it('is a noop if metadata.terminalOrderId is missing', async () => {
    await handleTerminalOrderCheckoutCompleted({ ...baseSession, metadata: {} })
    expect(prisma.terminalOrder.update).not.toHaveBeenCalled()
  })

  it('is a noop if order not found', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue(null)
    await handleTerminalOrderCheckoutCompleted(baseSession)
    expect(prisma.terminalOrder.update).not.toHaveBeenCalled()
  })

  it('is idempotent — does nothing if order already PAID', async () => {
    ;(prisma.terminalOrder.findUnique as jest.Mock).mockResolvedValue({
      ...baseOrder,
      paymentStatus: 'PAID',
    })
    await handleTerminalOrderCheckoutCompleted(baseSession)
    expect(prisma.terminalOrder.update).not.toHaveBeenCalled()
    expect(sendPaymentConfirmedMock).not.toHaveBeenCalled()
  })

  it('updates order to PAID + AWAITING_SERIALS and triggers both emails', async () => {
    await handleTerminalOrderCheckoutCompleted(baseSession)
    expect(prisma.terminalOrder.update).toHaveBeenCalledWith({
      where: { id: 'ord_1' },
      data: {
        paymentStatus: 'PAID',
        stripePaymentIntentId: 'pi_test_1',
        fulfillmentStatus: 'AWAITING_SERIALS',
        // Plan 3 — signed JWT + 30-day expiry persisted on the order so the
        // email's "Asignar serials" magic link works without login.
        serialAssignmentToken: expect.any(String),
        serialAssignmentTokenExpiresAt: expect.any(Date),
      },
    })
    expect(sendPaymentConfirmedMock).toHaveBeenCalledTimes(1)
    expect(sendSerialAssignmentMock).toHaveBeenCalledTimes(1)
  })
})
