/**
 * B4Bit confirmation-time shift attribution.
 *
 * A shift selected while the payment is only PENDING is provisional. The money
 * belongs to the business shift that is still OPEN when B4Bit confirms it, and
 * only the database winner of PENDING -> COMPLETED may increment that shift.
 */

jest.mock('@/utils/prismaClient', () => {
  const client: any = {
    payment: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    order: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    orderItem: { findMany: jest.fn().mockResolvedValue([]) },
    venue: { findUnique: jest.fn() },
    venueCryptoConfig: { findUnique: jest.fn() },
    shift: { findFirst: jest.fn(), updateMany: jest.fn() },
    terminal: { findFirst: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  }
  client.$transaction.mockImplementation((cb: any) => cb(client))
  return { __esModule: true, default: client }
})

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToVenue: jest.fn() },
}))

jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: jest.fn().mockResolvedValue({ accessKey: 'receipt-test' }),
  generateReceiptUrl: jest.fn().mockReturnValue('https://receipt.test/abc'),
}))

jest.mock('@/services/venueSalesGuard', () => ({
  assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))

jest.mock('@/services/referrals/referralQualification.service', () => ({
  onOrderPaid: jest.fn().mockResolvedValue(undefined),
}))

import { Prisma } from '@prisma/client'
import { processWebhook } from '@/services/b4bit/b4bit.service'
import type { B4BitWebhookPayload } from '@/services/b4bit/types'
import prisma from '@/utils/prismaClient'

const mockPrisma = prisma as unknown as {
  payment: { findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock }
  order: { findUnique: jest.Mock; updateMany: jest.Mock }
  orderItem: { findMany: jest.Mock }
  shift: { findFirst: jest.Mock; updateMany: jest.Mock }
  $queryRaw: jest.Mock
  $transaction: jest.Mock
}

const d = (value: string | number) => new Prisma.Decimal(value)

const VENUE_ID = 'cvenue0000000000000000001'
const ORDER_ID = 'corder0000000000000000001'
const PAYMENT_ID = 'cpay000000000000000000001'
const PROVISIONAL_SHIFT_A = 'cshifta000000000000000001'
const CONFIRMATION_SHIFT_B = 'cshiftb000000000000000001'

const payment = (over: Record<string, any> = {}) => ({
  id: PAYMENT_ID,
  venueId: VENUE_ID,
  orderId: ORDER_ID,
  shiftId: PROVISIONAL_SHIFT_A,
  amount: d('125.50'),
  tipAmount: d('7.25'),
  status: 'PENDING',
  processedById: 'cstaff000000000000000001',
  externalId: 'b4bit-request-1',
  processorData: {},
  order: { id: ORDER_ID, orderNumber: 'ORD-1', tableId: null },
  venue: { id: VENUE_ID, name: 'Venue test', organizationId: 'corg00000000000000000001' },
  ...over,
})

const order = (over: Record<string, any> = {}) => ({
  id: ORDER_ID,
  venueId: VENUE_ID,
  status: 'PENDING',
  paymentStatus: 'PENDING',
  subtotal: d('125.50'),
  discountAmount: d('0.00'),
  serviceChargeAmount: d('0.00'),
  paidAmount: d('0.00'),
  remainingBalance: d('125.50'),
  completedAt: null,
  version: 1,
  ...over,
})

const webhook = (over: Partial<B4BitWebhookPayload> = {}): B4BitWebhookPayload => ({
  identifier: 'b4bit-uuid-1',
  reference: PAYMENT_ID,
  fiat_amount: 9_999_999,
  fiat_currency: 'MXN',
  crypto_amount: '0.001',
  currency: 'BTC',
  status: 'CO',
  tx_hash: '0xdead',
  confirmations: 3,
  ...over,
})

const paymentWrites = () => [
  ...mockPrisma.payment.updateMany.mock.calls.map(call => call[0]),
  ...mockPrisma.payment.update.mock.calls.map(call => call[0]),
]
const finalAttributionWrite = () =>
  paymentWrites()
    .filter(write => Object.prototype.hasOwnProperty.call(write.data, 'shiftId'))
    .at(-1)

beforeEach(() => {
  jest.clearAllMocks()
  mockPrisma.payment.update.mockReset()
  mockPrisma.payment.updateMany.mockReset()
  mockPrisma.order.updateMany.mockReset()
  mockPrisma.order.findUnique.mockReset()
  mockPrisma.payment.findMany.mockReset()
  mockPrisma.shift.findFirst.mockReset()
  mockPrisma.shift.updateMany.mockReset()
  mockPrisma.$queryRaw.mockReset()

  mockPrisma.$transaction.mockImplementation((cb: any) => cb(prisma))
  mockPrisma.payment.update.mockResolvedValue({ id: PAYMENT_ID })
  mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.order.findUnique.mockResolvedValue(order())
  mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('125.50'), tipAmount: d('7.25'), type: 'REGULAR' }])
  mockPrisma.order.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.orderItem.findMany.mockResolvedValue([])
  mockPrisma.shift.findFirst.mockResolvedValue({ id: CONFIRMATION_SHIFT_B })
  mockPrisma.shift.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.$queryRaw.mockResolvedValue([{ id: PAYMENT_ID }])
})

describe('B4Bit — final shift attribution at confirmation', () => {
  it('moves provisional A to confirmation-time B and claims B with Payment pesos', async () => {
    const pendingPayment = payment()
    mockPrisma.payment.findUnique.mockResolvedValue(pendingPayment)

    await processWebhook(webhook())

    expect(mockPrisma.shift.findFirst).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, status: 'OPEN', endTime: null },
      orderBy: { startTime: 'desc' },
      select: { id: true },
    })
    expect(mockPrisma.shift.updateMany).toHaveBeenCalledWith({
      where: { id: CONFIRMATION_SHIFT_B, venueId: VENUE_ID, status: 'OPEN', endTime: null },
      data: {
        totalSales: { increment: pendingPayment.amount },
        totalTips: { increment: pendingPayment.tipAmount },
      },
    })
    expect(mockPrisma.shift.updateMany).toHaveBeenCalledTimes(1)
    expect(finalAttributionWrite()).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({ id: PAYMENT_ID, venueId: VENUE_ID }),
        data: expect.objectContaining({ shiftId: CONFIRMATION_SHIFT_B }),
      }),
    )
    expect(mockPrisma.order.updateMany.mock.calls[0][0].data).not.toHaveProperty('shiftId')
  })

  it('completes with no shift when none is open, never retaining provisional A', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(payment())
    mockPrisma.shift.findFirst.mockResolvedValue(null)

    await processWebhook(webhook())

    expect(mockPrisma.shift.updateMany).not.toHaveBeenCalled()
    expect(finalAttributionWrite()?.data.status).toBe('COMPLETED')
    expect(finalAttributionWrite()?.data.shiftId).toBeNull()
  })

  it('completes with no shift when B closes before its conditional claim', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(payment())
    mockPrisma.shift.updateMany.mockResolvedValue({ count: 0 })

    await processWebhook(webhook())

    expect(finalAttributionWrite()?.data.shiftId).toBeNull()
  })

  it('a redelivery preserves final B and never increments a shift again', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(payment({ status: 'COMPLETED', shiftId: CONFIRMATION_SHIFT_B }))
    mockPrisma.order.findUnique.mockResolvedValue(
      order({ status: 'COMPLETED', paymentStatus: 'PAID', paidAmount: d('132.75'), remainingBalance: d('0.00') }),
    )

    await processWebhook(webhook())

    expect(mockPrisma.shift.findFirst).not.toHaveBeenCalled()
    expect(mockPrisma.shift.updateMany).not.toHaveBeenCalled()
    expect(paymentWrites().every(write => !Object.prototype.hasOwnProperty.call(write.data, 'shiftId'))).toBe(true)
  })

  it('a concurrent CAS loser neither moves the final shift nor increments totals', async () => {
    mockPrisma.payment.findUnique
      .mockResolvedValueOnce(payment())
      .mockResolvedValueOnce(payment())
      .mockResolvedValue(payment({ status: 'COMPLETED', shiftId: CONFIRMATION_SHIFT_B }))
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 })

    await processWebhook(webhook())

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PAYMENT_ID, venueId: VENUE_ID, status: { not: 'COMPLETED' } } }),
    )
    expect(mockPrisma.shift.updateMany).not.toHaveBeenCalled()
    expect(mockPrisma.payment.update.mock.calls.at(-1)?.[0].data).not.toHaveProperty('shiftId')
  })

  it.each(['EX', 'OC'] as const)(
    'serializes a stale concurrent %s after CO, preserves COMPLETED, and a CO redelivery cannot claim twice',
    async lateStatus => {
      let durablePayment = payment()
      const staleOuterReads = [payment(), payment()]
      let durableShiftClaims = 0

      mockPrisma.payment.findUnique.mockImplementation(async (args: any) => {
        if (args.include) return staleOuterReads.shift() ?? { ...durablePayment }
        return { ...durablePayment }
      })
      mockPrisma.payment.updateMany.mockImplementation(async ({ where, data }: any) => {
        if (where.status?.not === 'COMPLETED' && durablePayment.status === 'COMPLETED') return { count: 0 }
        durablePayment = { ...durablePayment, ...data }
        return { count: 1 }
      })
      mockPrisma.payment.update.mockImplementation(async ({ data }: any) => {
        durablePayment = { ...durablePayment, ...data }
        return durablePayment
      })
      mockPrisma.shift.updateMany.mockImplementation(async () => {
        durableShiftClaims += 1
        return { count: 1 }
      })

      await processWebhook(webhook({ status: 'CO', edited_at: '2026-09-03T15:03:00Z' }))
      const lateFailure = await processWebhook(webhook({ status: lateStatus, edited_at: '2026-09-03T15:04:00Z' }))
      await processWebhook(webhook({ status: 'CO', edited_at: '2026-09-03T15:05:00Z' }))

      expect(durablePayment.status).toBe('COMPLETED')
      expect(durableShiftClaims).toBe(1)
      expect(lateFailure.action).toBe('CONFIRMED')
      expect(durablePayment.processorData).toMatchObject({ lateFailureIgnored: true, lastStatus: 'CO' })
      for (const [sql, lockedPaymentId, lockedVenueId] of mockPrisma.$queryRaw.mock.calls) {
        expect((sql as TemplateStringsArray).join('?')).toMatch(/FROM "Payment".*"venueId".*FOR UPDATE/s)
        expect([lockedPaymentId, lockedVenueId]).toEqual([PAYMENT_ID, VENUE_ID])
      }
    },
  )

  it('rechecks the durable watermark after locking so an older concurrent CO cannot overwrite a newer CO', async () => {
    let durablePayment = payment()
    const staleOuterReads = [payment(), payment()]
    let durableShiftClaims = 0

    mockPrisma.payment.findUnique.mockImplementation(async (args: any) => {
      if (args.include) return staleOuterReads.shift() ?? { ...durablePayment }
      return { ...durablePayment }
    })
    mockPrisma.payment.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.status?.not === 'COMPLETED' && durablePayment.status === 'COMPLETED') return { count: 0 }
      durablePayment = { ...durablePayment, ...data }
      return { count: 1 }
    })
    mockPrisma.payment.update.mockImplementation(async ({ data }: any) => {
      durablePayment = { ...durablePayment, ...data }
      return durablePayment
    })
    mockPrisma.shift.updateMany.mockImplementation(async () => {
      durableShiftClaims += 1
      return { count: 1 }
    })

    await processWebhook(webhook({ edited_at: '2026-09-03T15:05:00Z', tx_hash: '0xnewer' }))
    const older = await processWebhook(webhook({ edited_at: '2026-09-03T15:04:00Z', tx_hash: '0xolder' }))

    expect(older.action).toBe('IGNORED')
    expect(durablePayment.processorData).toMatchObject({ lastEditedAt: '2026-09-03T15:05:00Z', txHash: '0xnewer' })
    expect(durableShiftClaims).toBe(1)
    expect(mockPrisma.order.updateMany).toHaveBeenCalledTimes(1)
  })

  it('retry exhaustion uses the same final-attribution path instead of keeping A', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(payment())
    mockPrisma.order.updateMany.mockResolvedValue({ count: 0 })
    let durableShiftClaims = 0
    mockPrisma.$transaction.mockImplementation(async (callback: any) => {
      let transactionShiftClaims = 0
      const tx = {
        ...prisma,
        shift: {
          findFirst: (...args: any[]) => mockPrisma.shift.findFirst(...args),
          updateMany: async (...args: any[]) => {
            const result = await mockPrisma.shift.updateMany(...args)
            if (result.count === 1) transactionShiftClaims += 1
            return result
          },
        },
      }

      // Only resolved callbacks commit. Claims made by failed settlement attempts
      // remain observable mock calls, but never enter this durable counter.
      const result = await callback(tx)
      durableShiftClaims += transactionShiftClaims
      return result
    })

    await expect(processWebhook(webhook())).rejects.toThrow('No se pudo actualizar el saldo de la cuenta tras confirmar el pago cripto')

    expect(mockPrisma.order.updateMany).toHaveBeenCalledTimes(3)
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(4)
    expect(durableShiftClaims).toBe(1)
    expect(finalAttributionWrite()?.data.shiftId).toBe(CONFIRMATION_SHIFT_B)
    expect(mockPrisma.shift.updateMany.mock.calls.at(-1)?.[0]).toEqual({
      where: { id: CONFIRMATION_SHIFT_B, venueId: VENUE_ID, status: 'OPEN', endTime: null },
      data: {
        totalSales: { increment: expect.any(Prisma.Decimal) },
        totalTips: { increment: expect.any(Prisma.Decimal) },
      },
    })
  })
})
