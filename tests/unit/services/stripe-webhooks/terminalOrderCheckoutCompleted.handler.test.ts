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
      },
    })
    expect(sendPaymentConfirmedMock).toHaveBeenCalledTimes(1)
    expect(sendSerialAssignmentMock).toHaveBeenCalledTimes(1)
  })
})
