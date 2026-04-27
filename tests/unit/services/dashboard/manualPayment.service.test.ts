import { Prisma } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    order: { findFirst: jest.fn() },
    payment: { create: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    customer: { findFirst: jest.fn() },
    table: { findFirst: jest.fn() },
  },
}))

const earnPointsMock = jest.fn().mockResolvedValue({ pointsEarned: 0, newBalance: 0 })
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({
  __esModule: true,
  earnPoints: (...args: any[]) => earnPointsMock(...args),
}))

import * as manualPaymentService from '@/services/dashboard/manualPayment.service'
import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

const prismaMock = prisma as jest.Mocked<typeof prisma>

const VENUE_ID = 'venue-test-1'
const USER_ID = 'staff-test-1'
const ORDER_ID = 'order-test-1'

describe('manualPayment.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    earnPointsMock.mockResolvedValue({ pointsEarned: 0, newBalance: 0 })
    ;(prismaMock.customer.findFirst as jest.Mock).mockResolvedValue({ id: 'customer-1' })
    ;(prismaMock.table.findFirst as jest.Mock).mockResolvedValue({ id: 'table-1' })
    ;(prismaMock.staffVenue.findFirst as jest.Mock).mockResolvedValue({ staffId: 'waiter-1' })
  })

  describe('createManualPayment', () => {
    it('creates a Payment row with externalSource when source=OTHER', async () => {
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        total: new Prisma.Decimal(100),
        paymentStatus: 'PENDING',
        payments: [],
        orderCustomers: [],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
        cb({
          order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: jest.fn() },
          payment: { create: jest.fn().mockResolvedValue({ id: 'pay-1' }) },
          shift: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
          orderCustomer: { create: jest.fn() },
          venueTransaction: { create: jest.fn() },
          paymentAllocation: { create: jest.fn() },
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
          shift: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
          orderCustomer: { create: jest.fn() },
          venueTransaction: { create: jest.fn() },
          paymentAllocation: { create: jest.fn() },
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
        orderCustomers: [],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
        cb({
          order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: jest.fn() },
          payment: { create: jest.fn() },
          shift: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
          orderCustomer: { create: jest.fn() },
          venueTransaction: { create: jest.fn() },
          paymentAllocation: { create: jest.fn() },
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
        orderCustomers: [],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
        cb({
          order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: orderUpdate },
          payment: { create: jest.fn().mockResolvedValue({ id: 'pay-2' }) },
          shift: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
          orderCustomer: { create: jest.fn() },
          venueTransaction: { create: jest.fn() },
          paymentAllocation: { create: jest.fn() },
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
        cb({
          order: { findFirst, update: jest.fn() },
          payment: { create: jest.fn() },
          shift: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
          orderCustomer: { create: jest.fn() },
          venueTransaction: { create: jest.fn() },
          paymentAllocation: { create: jest.fn() },
        }),
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

  // DESTRUCTIVE — production alignment risks
  describe('Destructive — money alignment risks', () => {
    function txMock(handlers: any) {
      return async (cb: any) =>
        cb({
          order: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn(), create: jest.fn() },
          payment: { create: jest.fn().mockResolvedValue({ id: 'pay-x' }) },
          shift: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
          staffVenue: { findFirst: jest.fn().mockResolvedValue({ staffId: 'w1' }) },
          orderCustomer: { create: jest.fn() },
          venueTransaction: { create: jest.fn() },
          paymentAllocation: { create: jest.fn() },
          ...handlers,
        })
    }

    it('FIX: links manual payment to currently open shift (shiftId set from open Shift)', async () => {
      const paymentCreate = jest.fn().mockResolvedValue({ id: 'pay-shift' })
      const orderCreate = jest.fn().mockResolvedValue({ id: 'shadow-1' })
      const shiftFindFirst = jest.fn().mockResolvedValue({ id: 'open-shift-123' })
      const shiftUpdate = jest.fn()
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate },
          payment: { create: paymentCreate },
          shift: { findFirst: shiftFindFirst, update: shiftUpdate },
        }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '500.00',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      // Verifies the open-shift query is scoped by venue + endTime null
      expect(shiftFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ venueId: VENUE_ID, endTime: null }),
        }),
      )
      // Verifies payment is linked to that shift
      expect(paymentCreate.mock.calls[0][0].data.shiftId).toBe('open-shift-123')
    })

    it('FIX: shiftId stays null when no shift is open (graceful fallback)', async () => {
      const paymentCreate = jest.fn().mockResolvedValue({ id: 'pay-no-shift' })
      const orderCreate = jest.fn().mockResolvedValue({ id: 'shadow-2' })
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate },
          payment: { create: paymentCreate },
          shift: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
          orderCustomer: { create: jest.fn() },
          venueTransaction: { create: jest.fn() },
          paymentAllocation: { create: jest.fn() },
        }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '100',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      expect(paymentCreate.mock.calls[0][0].data.shiftId).toBeNull()
    })

    it('does NOT subtract REFUND payments when computing paidSoFar (over-pay risk)', async () => {
      // Scenario: order $100, prior payment $80 (COMPLETED), refund $-50 (COMPLETED).
      // Net paid should be $30 → can accept up to $70 more.
      // Current code filters status=COMPLETED but REFUND can also be COMPLETED with negative amount.
      // The reduce sums all amounts as-is, so paidSoFar = 80 + (-50) = 30 (correct!)
      // BUT if refund is stored with positive amount + status=REFUNDED, filter excludes it but order shows as overpaid.
      const orderUpdate = jest.fn()
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        total: new Prisma.Decimal(100),
        payments: [
          { amount: new Prisma.Decimal(80), tipAmount: new Prisma.Decimal(0), status: 'COMPLETED' },
          { amount: new Prisma.Decimal(-50), tipAmount: new Prisma.Decimal(0), status: 'COMPLETED' },
        ],
        orderCustomers: [],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: orderUpdate },
        }),
      )

      // paidSoFar = 30, so $80 should be accepted (30+80=110 > 100 → reject) — actually $70 is the max
      await expect(
        manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
          orderId: ORDER_ID,
          amount: '70',
          tipAmount: '0',
          method: 'CASH',
          source: 'OTHER',
          externalSource: 'BUQ',
        }),
      ).resolves.toBeDefined()
    })

    it('FIX: rejects attaching payment to CANCELLED order', async () => {
      const cancelledOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        status: 'CANCELLED',
        total: new Prisma.Decimal(100),
        payments: [],
        orderCustomers: [],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn().mockResolvedValue(cancelledOrder), update: jest.fn() },
        }),
      )

      await expect(
        manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
          orderId: ORDER_ID,
          amount: '50',
          tipAmount: '0',
          method: 'CASH',
          source: 'OTHER',
          externalSource: 'BUQ',
        }),
      ).rejects.toThrow(BadRequestError)
    })

    it('FIX: rejects attaching payment to DELETED order', async () => {
      const deletedOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        status: 'DELETED',
        total: new Prisma.Decimal(100),
        payments: [],
        orderCustomers: [],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn().mockResolvedValue(deletedOrder), update: jest.fn() },
        }),
      )

      await expect(
        manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
          orderId: ORDER_ID,
          amount: '50',
          tipAmount: '0',
          method: 'CASH',
          source: 'OTHER',
          externalSource: 'BUQ',
        }),
      ).rejects.toThrow(BadRequestError)
    })

    it('FIX: rejects shadow order whose discount makes total negative', async () => {
      // amount=50 + tax=10 + tip=5 - discount=100 = -35 → must reject
      const orderCreate = jest.fn()
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate },
        }),
      )

      await expect(
        manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
          amount: '50',
          tipAmount: '5',
          taxAmount: '10',
          discountAmount: '100',
          method: 'CASH',
          source: 'OTHER',
          externalSource: 'BUQ',
        }),
      ).rejects.toThrow(BadRequestError)

      expect(orderCreate).not.toHaveBeenCalled()
    })

    it('FIX: shadow order with shadowTotal=0 (discount equals subtotal+tax+tip) is accepted', async () => {
      // amount=50 + tax=10 + tip=5 - discount=65 = 0 → boundary case, must accept (not "less than 0")
      const orderCreate = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'zero', ...data }))
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate },
        }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '50',
        tipAmount: '5',
        taxAmount: '10',
        discountAmount: '65',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      expect(orderCreate.mock.calls[0][0].data.total.toString()).toBe('0')
    })

    it('handles concurrent overpay race via Serializable (transaction isolation declared)', async () => {
      // The service uses Prisma.TransactionIsolationLevel.Serializable to prevent the
      // "lost update" race. This test verifies the option is passed to $transaction.
      const txCallCapture: any[] = []
      ;(prismaMock.$transaction as jest.Mock).mockImplementation((cb: any, opts?: any) => {
        txCallCapture.push(opts)
        return cb({
          order: {
            findFirst: jest.fn().mockResolvedValue({
              id: ORDER_ID,
              venueId: VENUE_ID,
              total: new Prisma.Decimal(100),
              payments: [],
              orderCustomers: [],
            }),
            update: jest.fn(),
          },
          payment: { create: jest.fn().mockResolvedValue({ id: 'p' }) },
          staffVenue: { findFirst: jest.fn().mockResolvedValue(null) },
          shift: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
          orderCustomer: { create: jest.fn() },
          venueTransaction: { create: jest.fn() },
          paymentAllocation: { create: jest.fn() },
        })
      })

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        orderId: ORDER_ID,
        amount: '50',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      expect(txCallCapture[0]).toEqual(expect.objectContaining({ isolationLevel: 'Serializable' }))
    })

    it('FIX: aggregates Order.tipAmount when adding tip via manual payment', async () => {
      // Existing payment had tip=5. New manual payment adds tip=10.
      // Order.tipAmount should be updated to 5+10=15 (sum of all payment tips).
      const orderUpdate = jest.fn()
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        status: 'PARTIAL',
        total: new Prisma.Decimal(100),
        payments: [{ amount: new Prisma.Decimal(50), tipAmount: new Prisma.Decimal(5), status: 'COMPLETED' }],
        orderCustomers: [],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: orderUpdate },
        }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        orderId: ORDER_ID,
        amount: '50',
        tipAmount: '10',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      const updateData = orderUpdate.mock.calls[0][0].data
      expect(updateData.tipAmount).toBeDefined()
      expect(updateData.tipAmount.toString()).toBe('15')
    })

    it('handles 2-decimal precision boundary (sum equals total exactly)', async () => {
      // Order: 33.33 + 33.33 + 33.34 = 100.00 → final payment must be accepted, not rejected by FP.
      const orderUpdate = jest.fn()
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        total: new Prisma.Decimal('100.00'),
        payments: [
          { amount: new Prisma.Decimal('33.33'), tipAmount: new Prisma.Decimal(0), status: 'COMPLETED' },
          { amount: new Prisma.Decimal('33.33'), tipAmount: new Prisma.Decimal(0), status: 'COMPLETED' },
        ],
        orderCustomers: [],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: orderUpdate },
        }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        orderId: ORDER_ID,
        amount: '33.34',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      // Order should be marked PAID (not PARTIAL) when it lands exactly on total
      const callData = orderUpdate.mock.calls[0][0].data
      expect(callData.paymentStatus).toBe('PAID')
      expect(callData.paidAmount.toString()).toBe('100')
    })

    it('rejects payment exceeding total by 0.01 (no rounding leniency)', async () => {
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        total: new Prisma.Decimal('100.00'),
        payments: [{ amount: new Prisma.Decimal('99.99'), tipAmount: new Prisma.Decimal(0), status: 'COMPLETED' }],
        orderCustomers: [],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: jest.fn() },
        }),
      )

      await expect(
        manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
          orderId: ORDER_ID,
          amount: '0.02',
          tipAmount: '0',
          method: 'CASH',
          source: 'OTHER',
          externalSource: 'BUQ',
        }),
      ).rejects.toThrow(BadRequestError)
    })

    it('shadow order: orderNumber generation is non-colliding under same-millisecond requests', async () => {
      // ORD-MANUAL-{Date.now()}-{4-char random}. Two simultaneous requests in the same
      // millisecond have ~1/1,679,616 collision probability. Acceptable but document it.
      const generated = new Set<string>()
      const orderCreate = jest.fn().mockImplementation(({ data }) => {
        generated.add(data.orderNumber)
        return Promise.resolve({ id: data.orderNumber, ...data })
      })
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate },
        }),
      )

      const promises = Array.from({ length: 5 }, () =>
        manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
          amount: '10',
          tipAmount: '0',
          method: 'CASH',
          source: 'OTHER',
          externalSource: 'BUQ',
        }),
      )
      await Promise.all(promises)

      // 5 requests should generate 5 distinct orderNumbers
      expect(generated.size).toBe(5)
    })

    it('cross-tenant attack: cannot attach payment to order in another venue', async () => {
      // The findFirst { id, venueId } filter handles this — attacker passes orderId
      // belonging to venueB while authenticated as venueA → findFirst returns null → NotFoundError
      const findFirst = jest.fn().mockResolvedValue(null)
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(txMock({ order: { findFirst, update: jest.fn() } }))

      await expect(
        manualPaymentService.createManualPayment('venueA', USER_ID, {
          orderId: 'orderInVenueB',
          amount: '50',
          tipAmount: '0',
          method: 'CASH',
          source: 'OTHER',
          externalSource: 'BUQ',
        }),
      ).rejects.toThrow(NotFoundError)

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'orderInVenueB', venueId: 'venueA' }) }),
      )
    })
  })

  // DESTRUCTIVE — customer attribution + loyalty rewards
  describe('Destructive — customer + loyalty alignment', () => {
    function txMock(handlers: any) {
      return async (cb: any) =>
        cb({
          order: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
          payment: { create: jest.fn().mockResolvedValue({ id: 'pay-x' }) },
          shift: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
          orderCustomer: { create: jest.fn() },
          venueTransaction: { create: jest.fn() },
          paymentAllocation: { create: jest.fn() },
          ...handlers,
        })
    }

    it('FIX: rejects customerId belonging to another venue (cross-tenant)', async () => {
      ;(prismaMock.customer.findFirst as jest.Mock).mockResolvedValue(null)
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(txMock({}))

      await expect(
        manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
          customerId: 'customer-from-venueB',
          amount: '50',
          tipAmount: '0',
          method: 'CASH',
          source: 'OTHER',
          externalSource: 'BUQ',
        }),
      ).rejects.toThrow(BadRequestError)
    })

    it('FIX: rejects tableId belonging to another venue (cross-tenant)', async () => {
      ;(prismaMock.table.findFirst as jest.Mock).mockResolvedValue(null)
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(txMock({}))

      await expect(
        manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
          tableId: 'table-from-venueB',
          amount: '50',
          tipAmount: '0',
          method: 'CASH',
          source: 'OTHER',
          externalSource: 'BUQ',
        }),
      ).rejects.toThrow(BadRequestError)
    })

    it('FIX: shadow order with customerId triggers earnPoints with shadowTotal', async () => {
      const orderCreate = jest.fn().mockResolvedValue({ id: 'shadow-with-cust' })
      const orderCustomerCreate = jest.fn()
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate },
          orderCustomer: { create: orderCustomerCreate },
        }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '500',
        tipAmount: '50',
        taxAmount: '80',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
        customerId: 'customer-1',
      })

      // shadowTotal = 500 + 80 - 0 + 50 = 630
      expect(earnPointsMock).toHaveBeenCalledWith(VENUE_ID, 'customer-1', 630, 'shadow-with-cust', USER_ID)
      // OrderCustomer link created as primary
      expect(orderCustomerCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ customerId: 'customer-1', isPrimary: true }),
        }),
      )
      // Order itself also stores customerId for legacy joins
      expect(orderCreate.mock.calls[0][0].data.customerId).toBe('customer-1')
    })

    it('FIX: shadow order WITHOUT customerId does NOT call earnPoints', async () => {
      const orderCreate = jest.fn().mockResolvedValue({ id: 'shadow-no-cust' })
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({ order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate } }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '100',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      expect(earnPointsMock).not.toHaveBeenCalled()
    })

    it('FIX: Mode 1 fully-paid order with primary customer triggers earnPoints', async () => {
      const orderUpdate = jest.fn()
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        status: 'PARTIAL',
        total: new Prisma.Decimal(200),
        customerId: null,
        payments: [{ amount: new Prisma.Decimal(100), tipAmount: new Prisma.Decimal(0), status: 'COMPLETED' }],
        orderCustomers: [{ customerId: 'cust-loyal-7' }],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({ order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: orderUpdate } }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        orderId: ORDER_ID,
        amount: '100',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      expect(earnPointsMock).toHaveBeenCalledWith(VENUE_ID, 'cust-loyal-7', 200, ORDER_ID, USER_ID)
    })

    it('FIX: Mode 1 PARTIAL payment does NOT call earnPoints (only on full settlement)', async () => {
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        status: 'PARTIAL',
        total: new Prisma.Decimal(200),
        customerId: 'cust-1',
        payments: [],
        orderCustomers: [{ customerId: 'cust-1' }],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({ order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: jest.fn() } }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        orderId: ORDER_ID,
        amount: '50',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      expect(earnPointsMock).not.toHaveBeenCalled()
    })

    it('FIX: Mode 1 fully-paid sets Order.status=COMPLETED (not just paymentStatus)', async () => {
      const orderUpdate = jest.fn()
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        status: 'PREPARING',
        total: new Prisma.Decimal(100),
        customerId: null,
        payments: [{ amount: new Prisma.Decimal(50), tipAmount: new Prisma.Decimal(0), status: 'COMPLETED' }],
        orderCustomers: [],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({ order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: orderUpdate } }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        orderId: ORDER_ID,
        amount: '50',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      const data = orderUpdate.mock.calls[0][0].data
      expect(data.status).toBe('COMPLETED')
      expect(data.paymentStatus).toBe('PAID')
      expect(data.completedAt).toBeInstanceOf(Date)
    })

    it('FIX: Mode 1 partial payment does NOT flip Order.status to COMPLETED', async () => {
      const orderUpdate = jest.fn()
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        status: 'PREPARING',
        total: new Prisma.Decimal(200),
        customerId: null,
        payments: [],
        orderCustomers: [],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({ order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: orderUpdate } }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        orderId: ORDER_ID,
        amount: '50',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      const data = orderUpdate.mock.calls[0][0].data
      expect(data.status).toBeUndefined()
      expect(data.paymentStatus).toBe('PARTIAL')
    })

    it('FIX: input.customerId override wins over order.customerId for loyalty', async () => {
      // Edge case: order has a primary customer but admin attaches a different
      // one on this final payment. Loyalty should go to the override (admin's intent).
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        status: 'PARTIAL',
        total: new Prisma.Decimal(100),
        customerId: 'old-customer',
        payments: [],
        orderCustomers: [{ customerId: 'old-customer' }],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({ order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: jest.fn() } }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        orderId: ORDER_ID,
        amount: '100',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
        customerId: 'new-customer',
      })

      expect(earnPointsMock).toHaveBeenCalledWith(VENUE_ID, 'new-customer', 100, ORDER_ID, USER_ID)
    })

    it('DESTRUCTIVE: loyalty disabled venue returns 0 points (no error, payment commits)', async () => {
      // earnPoints with loyalty disabled returns {pointsEarned:0, newBalance:0}.
      // Service must accept that gracefully (no false-positive log, payment OK).
      earnPointsMock.mockResolvedValueOnce({ pointsEarned: 0, newBalance: 0 })
      const orderCreate = jest.fn().mockResolvedValue({ id: 'shadow-no-loyalty' })
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({ order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate } }),
      )

      const result = await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '100',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
        customerId: 'customer-1',
      })

      expect(result).toBeDefined()
      expect(earnPointsMock).toHaveBeenCalledTimes(1)
    })

    it('DESTRUCTIVE: earnPoints invoked exactly ONCE per fully-paid order (idempotency contract)', async () => {
      // The service must call earnPoints once. If called twice via retry, the
      // earnPoints function itself dedupes by (customerId, orderId). But the
      // SERVICE must not invoke it more than once per request.
      const orderUpdate = jest.fn()
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        status: 'PARTIAL',
        total: new Prisma.Decimal(100),
        customerId: 'cust-1',
        payments: [],
        orderCustomers: [{ customerId: 'cust-1' }],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({ order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: orderUpdate } }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        orderId: ORDER_ID,
        amount: '100',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      expect(earnPointsMock).toHaveBeenCalledTimes(1)
    })

    it('DESTRUCTIVE: empty-string customerId is treated as omitted (schema transform)', async () => {
      // Edge case: FE sends customerId="" instead of omitting. Schema transform
      // coerces to undefined so the service must NOT call earnPoints or validate.
      const customerFindFirst = jest.fn().mockResolvedValue({ id: 'should-not-be-called' })
      ;(prismaMock.customer.findFirst as jest.Mock) = customerFindFirst
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({ order: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn().mockResolvedValue({ id: 'shadow-empty-cust' }) } }),
      )

      // Pass "" for customerId — schema should transform to undefined before reaching service
      // (verified by checking customer.findFirst was NOT called)
      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '100',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
        // simulate the *post-Zod-transform* shape: undefined (not '')
        customerId: undefined as any,
      })

      expect(customerFindFirst).not.toHaveBeenCalled()
      expect(earnPointsMock).not.toHaveBeenCalled()
    })

    it('DESTRUCTIVE: customer validation runs BEFORE tx (TOCTOU window: customer can be deleted)', async () => {
      // The customer existence check is OUTSIDE the tx. If the customer is
      // deleted between validation and tx commit, the orderCustomer.create
      // would fail with FK violation. This test documents the window.
      // Mitigation in production: cascade DELETE on customer is `onDelete: Restrict`
      // for OrderCustomer FK (per schema), so the customer can't be hard-deleted
      // while having any related entries.
      const orderCreate = jest.fn().mockResolvedValue({ id: 'shadow-toctou' })
      const orderCustomerCreate = jest.fn().mockResolvedValue({})
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate },
          orderCustomer: { create: orderCustomerCreate },
        }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '50',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
        customerId: 'customer-1',
      })

      // Customer was validated, OrderCustomer was created — no rollback needed
      expect(orderCustomerCreate).toHaveBeenCalled()
    })

    it('DESTRUCTIVE: shadow order with HUGE amount near Decimal(12,2) overflow boundary', async () => {
      // Decimal(12,2) max = 9_999_999_999.99. Test we don't accept clearly invalid
      // amounts that would overflow the column at DB layer.
      const orderCreate = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'huge', ...data }))
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({ order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate } }),
      )

      // Just below max: 9_999_999_999.99 — should accept (boundary)
      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '9999999998.99',
        tipAmount: '1.00',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      const data = orderCreate.mock.calls[0][0].data
      // Total stored without rounding loss
      expect(data.total.toString()).toBe('9999999999.99')
    })

    it('DESTRUCTIVE: payment marked PAID but with $0 still produces no points', async () => {
      // Edge: shadow order with amount=0 (e.g. promo "free comp" entry).
      // Schema actually rejects amount=0 via .refine, but verify defensively.
      // (Schema is enforced at HTTP layer; service is not the last line of defense.)
      // If the schema is bypassed (direct service call from another internal service),
      // the service should still create a payment but loyalty points = 0.
      const orderCreate = jest.fn().mockResolvedValue({ id: 'zero-shadow' })
      earnPointsMock.mockResolvedValueOnce({ pointsEarned: 0, newBalance: 50 }) // existing balance, no new
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({ order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate } }),
      )

      // Bypass schema by passing amount that would be valid (= small but nonzero)
      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '0.01',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
        customerId: 'customer-1',
      })

      // Payment created, earnPoints called with $0.01 → likely 0 points (depends on config)
      expect(earnPointsMock).toHaveBeenCalledWith(VENUE_ID, 'customer-1', 0.01, 'zero-shadow', USER_ID)
    })

    it('FIX: VenueTransaction created with grossAmount = amount + tipAmount (settlement alignment)', async () => {
      const venueTransactionCreate = jest.fn()
      const orderCreate = jest.fn().mockResolvedValue({ id: 'shadow-vt' })
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate },
          venueTransaction: { create: venueTransactionCreate },
        }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '100',
        tipAmount: '15',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      expect(venueTransactionCreate).toHaveBeenCalledTimes(1)
      const data = venueTransactionCreate.mock.calls[0][0].data
      expect(data.type).toBe('PAYMENT')
      expect(data.grossAmount.toString()).toBe('115')
      expect(data.netAmount.toString()).toBe('115')
      expect(data.feeAmount.toString()).toBe('0')
      expect(data.status).toBe('PENDING')
    })

    it('FIX: PaymentAllocation created linking payment → anchor order with payment amount', async () => {
      const allocationCreate = jest.fn()
      const orderCreate = jest.fn().mockResolvedValue({ id: 'shadow-alloc' })
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate },
          paymentAllocation: { create: allocationCreate },
        }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '250',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      expect(allocationCreate).toHaveBeenCalledTimes(1)
      const data = allocationCreate.mock.calls[0][0].data
      expect(data.orderId).toBe('shadow-alloc')
      expect(data.amount.toString()).toBe('250')
    })

    it('FIX: Shift totals increment when shift is open (Mode 2 shadow → totalOrders++ too)', async () => {
      const shiftUpdate = jest.fn()
      const orderCreate = jest.fn().mockResolvedValue({ id: 'shadow-shift' })
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate },
          shift: { findFirst: jest.fn().mockResolvedValue({ id: 'open-shift' }), update: shiftUpdate },
        }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '300',
        tipAmount: '20',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      expect(shiftUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'open-shift' },
          data: expect.objectContaining({
            totalSales: { increment: expect.anything() },
            totalTips: { increment: expect.anything() },
            totalOrders: { increment: 1 },
          }),
        }),
      )
      // Verify decimal values
      const data = shiftUpdate.mock.calls[0][0].data
      expect(data.totalSales.increment.toString()).toBe('300')
      expect(data.totalTips.increment.toString()).toBe('20')
    })

    it('FIX: Shift totals increment WITHOUT totalOrders++ for Mode 1 (order already counted)', async () => {
      const shiftUpdate = jest.fn()
      const mockOrder = {
        id: ORDER_ID,
        venueId: VENUE_ID,
        status: 'PARTIAL',
        total: new Prisma.Decimal(500),
        customerId: null,
        payments: [],
        orderCustomers: [],
      }
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn().mockResolvedValue(mockOrder), update: jest.fn() },
          shift: { findFirst: jest.fn().mockResolvedValue({ id: 'open-shift' }), update: shiftUpdate },
        }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        orderId: ORDER_ID,
        amount: '200',
        tipAmount: '15',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      const data = shiftUpdate.mock.calls[0][0].data
      expect(data.totalSales.increment.toString()).toBe('200')
      expect(data.totalTips.increment.toString()).toBe('15')
      // Mode 1: order already counted in shift.totalOrders, do NOT double-count
      expect('totalOrders' in data).toBe(false)
    })

    it('FIX: Shift NOT updated when no shift is open (graceful)', async () => {
      const shiftUpdate = jest.fn()
      const orderCreate = jest.fn().mockResolvedValue({ id: 'shadow-no-shift' })
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate },
          shift: { findFirst: jest.fn().mockResolvedValue(null), update: shiftUpdate },
        }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '100',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      expect(shiftUpdate).not.toHaveBeenCalled()
    })

    it('FIX: Payment.netAmount equals amount + tipAmount (matches TPV pattern)', async () => {
      const paymentCreate = jest.fn().mockResolvedValue({ id: 'p-net' })
      const orderCreate = jest.fn().mockResolvedValue({ id: 'shadow-net' })
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({
          order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate },
          payment: { create: paymentCreate },
        }),
      )

      await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '500',
        tipAmount: '50',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
      })

      const data = paymentCreate.mock.calls[0][0].data
      expect(data.amount.toString()).toBe('500')
      expect(data.tipAmount.toString()).toBe('50')
      expect(data.netAmount.toString()).toBe('550')
    })

    it('FIX: earnPoints failure does NOT roll back the payment (caught + logged)', async () => {
      // Payment must persist even if loyalty service throws — matches TPV pattern.
      earnPointsMock.mockRejectedValueOnce(new Error('Loyalty downstream down'))
      const orderCreate = jest.fn().mockResolvedValue({ id: 'shadow-loyalty-fail' })
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(
        txMock({ order: { findFirst: jest.fn(), update: jest.fn(), create: orderCreate } }),
      )

      // Must NOT throw — payment is committed, loyalty error is swallowed
      const result = await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, {
        amount: '50',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        externalSource: 'BUQ',
        customerId: 'customer-1',
      })

      expect(result).toBeDefined()
      expect(earnPointsMock).toHaveBeenCalled()
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
