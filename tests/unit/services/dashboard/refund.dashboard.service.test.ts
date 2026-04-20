import { PaymentType, TransactionStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/dashboard/rawMaterial.service', () => ({
  adjustStock: jest.fn(),
}))

describe('refund.dashboard.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
    prismaMock.payment.update.mockResolvedValue({ id: 'payment-original' })
  })

  it('rejects refund quantity that exceeds previously refunded quantity for the same order item', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'payment-original',
          venueId: 'venue-1',
          status: TransactionStatus.COMPLETED,
          type: PaymentType.REGULAR,
          method: 'CASH',
          source: 'APP',
          amount: 10,
          tipAmount: 0,
          orderId: 'order-1',
          shiftId: null,
          merchantAccountId: null,
          processorData: {},
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'refund-1',
          amount: -6.67,
          createdAt: new Date('2026-04-17T10:00:00.000Z'),
          status: TransactionStatus.COMPLETED,
          processorData: {
            refundedItems: [
              {
                orderItemId: 'oi-1',
                quantity: 2,
                amountCents: 667,
                amount: 6.67,
              },
            ],
          },
        },
      ])

    prismaMock.orderItem.findMany.mockResolvedValue([
      {
        id: 'oi-1',
        productId: 'prod-1',
        productName: 'Shake',
        quantity: 3,
        total: new Decimal(10),
      },
    ])

    await expect(
      issueRefund({
        venueId: 'venue-1',
        paymentId: 'payment-original',
        items: [{ orderItemId: 'oi-1', quantity: 2 }],
        reason: 'RETURNED_GOODS',
      }),
    ).rejects.toThrow(/exceeds remaining refundable quantity/i)

    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('uses deterministic cents allocation for remaining partial item refund and updates cumulative refunded cents', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'payment-original',
          venueId: 'venue-1',
          status: TransactionStatus.COMPLETED,
          type: PaymentType.REGULAR,
          method: 'CASH',
          source: 'APP',
          amount: 10,
          tipAmount: 0,
          orderId: 'order-1',
          shiftId: null,
          merchantAccountId: null,
          processorData: {
            refunds: [
              {
                refundPaymentId: 'refund-1',
                amount: 3.34,
                amountCents: 334,
                reason: 'RETURNED_GOODS',
              },
            ],
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'refund-1',
          amount: -3.34,
          createdAt: new Date('2026-04-17T10:00:00.000Z'),
          status: TransactionStatus.COMPLETED,
          processorData: {
            refundedItems: [
              {
                orderItemId: 'oi-1',
                quantity: 1,
                amountCents: 334,
                amount: 3.34,
              },
            ],
          },
        },
      ])

    prismaMock.orderItem.findMany.mockResolvedValue([
      {
        id: 'oi-1',
        productId: 'prod-1',
        productName: 'Shake',
        quantity: 3,
        total: new Decimal(10),
      },
    ])
    prismaMock.payment.create.mockResolvedValue({ id: 'refund-2' })

    const result = await issueRefund({
      venueId: 'venue-1',
      paymentId: 'payment-original',
      items: [{ orderItemId: 'oi-1', quantity: 2 }],
      reason: 'RETURNED_GOODS',
    })

    expect(result.amount).toBe(6.66)
    expect(result.remainingRefundable).toBe(0)
    expect(prismaMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amount: new Decimal(-6.66),
          processorData: expect.objectContaining({
            amountCents: 666,
            refundedItems: [
              expect.objectContaining({
                orderItemId: 'oi-1',
                quantity: 2,
                amountCents: 666,
                amount: 6.66,
              }),
            ],
          }),
        }),
      }),
    )
    expect(prismaMock.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processorData: expect.objectContaining({
            refundedAmount: 10,
            refundedAmountCents: 1000,
          }),
        }),
      }),
    )
  })
})
