import { Prisma } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    order: { findFirst: jest.fn() },
    payment: { create: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  },
}))

import * as manualPaymentService from '@/services/dashboard/manualPayment.service'
import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

const prismaMock = prisma as jest.Mocked<typeof prisma>

const VENUE_ID = 'venue-test-1'
const USER_ID = 'staff-test-1'
const ORDER_ID = 'order-test-1'

describe('manualPayment.service', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('createManualPayment', () => {
    it('creates a Payment row with externalSource when source=OTHER', async () => {
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        total: new Prisma.Decimal(100),
        paymentStatus: 'PENDING',
        payments: [],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
        cb({
          order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: jest.fn() },
          payment: { create: jest.fn().mockResolvedValue({ id: 'pay-1' }) },
        }),
      )

      const result = await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        orderId: ORDER_ID,
        amount: '100.00',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      expect(result.id).toBe('pay-1')
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('throws NotFoundError when order does not belong to venue', async () => {
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
        cb({
          order: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
          payment: { create: jest.fn() },
        }),
      )

      await expect(
        manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
          orderId: 'wrong-order',
          amount: '50',
          tipAmount: '0',
          method: 'CASH',
          source: 'OTHER',
          externalSource: 'BUQ',
        }),
      ).rejects.toThrow(NotFoundError)
    })

    it('throws BadRequestError when payment would exceed order total', async () => {
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        total: new Prisma.Decimal(100),
        paymentStatus: 'PARTIAL',
        payments: [{ amount: new Prisma.Decimal(80), tipAmount: new Prisma.Decimal(0), status: 'COMPLETED' }],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
        cb({
          order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: jest.fn() },
          payment: { create: jest.fn() },
        }),
      )

      await expect(
        manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
          orderId: ORDER_ID,
          amount: '30', // 80 already paid + 30 > 100
          tipAmount: '0',
          method: 'CASH',
          source: 'OTHER',
          externalSource: 'BUQ',
        }),
      ).rejects.toThrow(BadRequestError)
    })

    it('marks order COMPLETED when payment fulfills remaining balance', async () => {
      const orderUpdate = jest.fn()
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        total: new Prisma.Decimal(100),
        paymentStatus: 'PARTIAL',
        payments: [{ amount: new Prisma.Decimal(70), tipAmount: new Prisma.Decimal(0), status: 'COMPLETED' }],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
        cb({
          order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: orderUpdate },
          payment: { create: jest.fn().mockResolvedValue({ id: 'pay-2' }) },
        }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        orderId: ORDER_ID,
        amount: '30',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      expect(orderUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ORDER_ID },
          data: expect.objectContaining({ paymentStatus: 'PAID' }),
        }),
      )
    })
  })

  // REGRESSION
  describe('Regression — multi-tenant isolation', () => {
    it('findFirst query always includes venueId filter', async () => {
      const findFirst = jest.fn().mockResolvedValue(null)
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
        cb({ order: { findFirst, update: jest.fn() }, payment: { create: jest.fn() } }),
      )

      await expect(
        manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
          orderId: ORDER_ID,
          amount: '10',
          tipAmount: '0',
          method: 'CASH',
          source: 'OTHER',
          externalSource: 'BUQ',
        }),
      ).rejects.toThrow()

      expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE_ID }) }))
    })
  })

  describe('getExternalSources', () => {
    it('returns distinct externalSource values ordered by frequency', async () => {
      ;(prismaMock.payment.groupBy as jest.Mock).mockResolvedValue([
        { externalSource: 'BUQ', _count: { _all: 20 } },
        { externalSource: 'Clip', _count: { _all: 5 } },
      ])

      const result = await manualPaymentService.getExternalSources(VENUE_ID, 10)

      expect(result).toEqual(['BUQ', 'Clip'])
      expect(prismaMock.payment.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['externalSource'],
          where: expect.objectContaining({ venueId: VENUE_ID, externalSource: { not: null } }),
        }),
      )
    })
  })
})
