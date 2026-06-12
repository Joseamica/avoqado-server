/**
 * Live Demo — simulateFastPayment service (Avoqado Tour F2)
 *
 * Runs the REAL simulateFastPayment AND the REAL recordFastPayment (the TPV
 * fast-payment path) against the global prisma mock, with the Socket.IO
 * manager mocked — so we assert the realtime PAYMENT_COMPLETED emission that
 * makes the payment appear live in Ventas.
 *
 * Mocked away (fire-and-forget side paths inside recordFastPayment):
 * - socketManager (assertion target)
 * - referral qualification hook
 * - Blumon / AngelPay webhook backfill (dynamic imports)
 */

import prisma from '@/utils/prismaClient'
import { socketManager } from '@/communication/sockets/managers/socketManager'
import { SocketEventType } from '@/communication/sockets/types'
import { simulateFastPayment, SIM_PAYMENT_REFERENCE_PREFIX, MAX_SIM_PAYMENTS_PER_SESSION } from '@/services/liveDemo.service'
import { ForbiddenError, TooManyRequestsError, UnauthorizedError } from '@/errors/AppError'

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  socketManager: {
    broadcastToVenue: jest.fn(),
    broadcastToTable: jest.fn(),
    broadcastToStaff: jest.fn(),
  },
}))

jest.mock('@/services/referrals/referralQualification.service', () => ({
  onOrderPaid: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/tpv/blumon-webhook.service', () => ({
  reconcileWebhooksForPayment: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/tpv/angelpay-webhook.service', () => ({
  reconcileAngelPayWebhookForPayment: jest.fn().mockResolvedValue(undefined),
}))

const prismaMock = prisma as any
const mockedBroadcast = socketManager.broadcastToVenue as jest.Mock

const SESSION_ID = 'cookie-session-1'
const VENUE_ID = 'venue-live-demo-1'
const STAFF_ID = 'staff-demo-1'

function futureDate(hours = 2): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000)
}

function pastDate(hours = 2): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000)
}

function mockValidSession(expiresAt: Date = futureDate()) {
  prismaMock.liveDemoSession.findUnique.mockResolvedValue({
    id: 'lds-1',
    sessionId: SESSION_ID,
    venueId: VENUE_ID,
    staffId: STAFF_ID,
    expiresAt,
  })
}

function mockHappyPathPrisma() {
  mockValidSession()

  // isLiveDemoVenue hard check
  prismaMock.venue.findUnique.mockResolvedValue({ status: 'LIVE_DEMO' })

  // Sim cap counter — below the cap
  prismaMock.payment.count.mockResolvedValue(0)

  // recordFastPayment idempotency fast-paths → no existing payment
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.payment.findFirst.mockResolvedValue(null)

  // validateStaffVenue — the demo venue's seeded OWNER staff
  prismaMock.staffVenue.findFirst.mockResolvedValue({
    staffId: STAFF_ID,
    venueId: VENUE_ID,
    active: true,
    staff: { firstName: 'Demo', lastName: 'User' },
  })

  // No open shift for the demo staff
  prismaMock.shift.findFirst.mockResolvedValue(null)

  // Inside the $transaction (cb receives prismaMock itself)
  prismaMock.order.create.mockResolvedValue({
    id: 'order-sim-1',
    orderNumber: 'FAST-1718000000000',
    venueId: VENUE_ID,
    status: 'COMPLETED',
    paymentStatus: 'PAID',
  })
  prismaMock.payment.create.mockImplementation(({ data }: any) =>
    Promise.resolve({
      id: 'pay-sim-1',
      venueId: VENUE_ID,
      amount: data.amount,
      tipAmount: data.tipAmount,
      method: data.method,
      status: data.status,
      type: data.type,
      feeAmount: 0,
      netAmount: data.netAmount,
      processorId: data.processorId,
      referenceNumber: data.referenceNumber,
      idempotencyKey: data.idempotencyKey,
      processedBy: { id: STAFF_ID, firstName: 'Demo', lastName: 'User' },
    }),
  )
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vt-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })

  // Session keep-alive
  prismaMock.liveDemoSession.update.mockResolvedValue({})
}

describe('simulateFastPayment — live demo sim payment service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('throws UnauthorizedError (401) when the session does not exist', async () => {
    prismaMock.liveDemoSession.findUnique.mockResolvedValue(null)

    await expect(simulateFastPayment('ghost-session', 15000, 0)).rejects.toThrow(UnauthorizedError)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(mockedBroadcast).not.toHaveBeenCalled()
  })

  it('throws UnauthorizedError (401) when the session is expired', async () => {
    mockValidSession(pastDate())

    await expect(simulateFastPayment(SESSION_ID, 15000, 0)).rejects.toThrow(UnauthorizedError)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(mockedBroadcast).not.toHaveBeenCalled()
  })

  it('throws ForbiddenError (403) when the session venue is NOT a LIVE_DEMO venue — never writes', async () => {
    mockValidSession()
    // Tampered/stale session pointing at a REAL venue
    prismaMock.venue.findUnique.mockResolvedValue({ status: 'ACTIVE' })

    await expect(simulateFastPayment(SESSION_ID, 15000, 0)).rejects.toThrow(ForbiddenError)

    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(mockedBroadcast).not.toHaveBeenCalled()
  })

  it('throws TooManyRequestsError (429) when the per-session sim cap is reached — never writes', async () => {
    mockValidSession()
    prismaMock.venue.findUnique.mockResolvedValue({ status: 'LIVE_DEMO' })
    prismaMock.payment.count.mockResolvedValue(MAX_SIM_PAYMENTS_PER_SESSION)

    await expect(simulateFastPayment(SESSION_ID, 15000, 0)).rejects.toThrow(TooManyRequestsError)

    // Cap counter only counts sim-marked payments (seeded demo payments are excluded)
    expect(prismaMock.payment.count).toHaveBeenCalledWith({
      where: {
        venueId: VENUE_ID,
        referenceNumber: { startsWith: SIM_PAYMENT_REFERENCE_PREFIX },
      },
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(mockedBroadcast).not.toHaveBeenCalled()
  })

  it('happy path: creates a CARD/COMPLETED fast payment with amount + tip via the TPV path', async () => {
    mockHappyPathPrisma()

    const result = await simulateFastPayment(SESSION_ID, 15000, 2000)

    // Contract response shape (cents in, cents out)
    expect(result).toEqual({ paymentId: 'pay-sim-1', amountCents: 15000, tipCents: 2000 })

    // Payment written exactly like the TPV fast path: CARD, COMPLETED, FAST,
    // amounts converted cents → decimal, sim marker on referenceNumber
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    const paymentData = prismaMock.payment.create.mock.calls[0][0].data
    expect(paymentData).toEqual(
      expect.objectContaining({
        venueId: VENUE_ID,
        amount: 150, // 15000 cents → 150.00
        tipAmount: 20, // 2000 cents → 20.00
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        type: 'FAST',
        processedById: STAFF_ID,
      }),
    )
    expect(paymentData.referenceNumber).toMatch(new RegExp(`^${SIM_PAYMENT_REFERENCE_PREFIX}-`))

    // Fast order created and fully paid
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.order.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        venueId: VENUE_ID,
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        total: 170,
      }),
    )

    // Financial side-effects preserved
    expect(prismaMock.venueTransaction.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.paymentAllocation.create).toHaveBeenCalledTimes(1)

    // Session keep-alive touched
    expect(prismaMock.liveDemoSession.update).toHaveBeenCalledWith({
      where: { sessionId: SESSION_ID },
      data: { lastActivityAt: expect.any(Date) },
    })
  })

  it('happy path: emits PAYMENT_COMPLETED + ORDER_UPDATED to the venue room (realtime Ventas refresh)', async () => {
    mockHappyPathPrisma()

    await simulateFastPayment(SESSION_ID, 15000, 2000)

    expect(mockedBroadcast).toHaveBeenCalledWith(
      VENUE_ID,
      SocketEventType.PAYMENT_COMPLETED,
      expect.objectContaining({
        paymentId: 'pay-sim-1',
        orderId: 'order-sim-1',
        venueId: VENUE_ID,
        amount: 150,
        tipAmount: 20,
        method: 'CREDIT_CARD',
        status: 'completed',
        type: 'FAST',
      }),
    )

    expect(mockedBroadcast).toHaveBeenCalledWith(
      VENUE_ID,
      SocketEventType.ORDER_UPDATED,
      expect.objectContaining({
        orderId: 'order-sim-1',
        venueId: VENUE_ID,
        type: 'FAST',
      }),
    )
  })
})
