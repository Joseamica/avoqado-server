import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    shift: { findFirst: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    payment: { findMany: jest.fn() },
    orderItem: { findMany: jest.fn() },
    rawMaterialMovement: { findMany: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))
jest.mock('@/services/access/cashReconciliationAccess.service', () => ({
  isCashReconciliationEnabled: jest.fn().mockResolvedValue(false),
}))

import prisma from '@/utils/prismaClient'
import { publishCommand } from '@/communication/rabbitmq/publisher'
import { closeShiftForVenueWithResult } from '@/services/tpv/shift.tpv.service'

const mockPrisma = prisma as any
const VENUE_ID = 'venue-concurrent-close'
const SHIFT_ID = 'shift-concurrent-close'
const NOW = new Date('2026-08-08T20:00:00.000Z')

function shift(status: 'OPEN' | 'CLOSING' | 'CLOSED' = 'OPEN', updatedAt = new Date('2026-08-08T19:59:00.000Z')) {
  return {
    id: SHIFT_ID,
    venueId: VENUE_ID,
    staffId: 'staff-owner',
    startTime: new Date('2026-08-08T12:00:00.000Z'),
    endTime: status === 'CLOSED' ? new Date('2026-08-08T19:00:00.000Z') : null,
    status,
    updatedAt,
    startingCash: new Decimal('500.00'),
    externalId: 'external-shift',
    venue: { posType: 'SOFTRESTAURANT', posStatus: 'CONNECTED', name: 'Concurrent venue' },
  }
}

function makeTx(open: ReturnType<typeof shift>) {
  let finalData: any
  return {
    shift: {
      updateMany: jest.fn(async (args: any) => {
        finalData = args.data
        return { count: 1 }
      }),
      findUnique: jest.fn(async () => ({ ...open, ...finalData })),
    },
    activityLog: { create: jest.fn().mockResolvedValue({ id: 'audit-close' }) },
  }
}

describe('atomic shift close claim', () => {
  let open: ReturnType<typeof shift>
  let tx: ReturnType<typeof makeTx>

  beforeEach(() => {
    jest.clearAllMocks()
    open = shift()
    tx = makeTx(open)
    mockPrisma.shift.findFirst.mockResolvedValue(open)
    mockPrisma.shift.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.shift.update.mockResolvedValue({ ...open, status: 'CLOSED', endTime: NOW })
    mockPrisma.payment.findMany.mockResolvedValue([])
    mockPrisma.orderItem.findMany.mockResolvedValue([])
    mockPrisma.rawMaterialMovement.findMany.mockResolvedValue([])
    mockPrisma.staffVenue.findFirst.mockResolvedValue(null)
    mockPrisma.$transaction.mockImplementation(async (callback: any) => callback(tx))
  })

  it('allows only one of two concurrent requests to finalize, audit, and publish', async () => {
    const inProgress = shift('CLOSING', NOW)
    mockPrisma.shift.findFirst.mockResolvedValueOnce(open).mockResolvedValueOnce(open).mockResolvedValueOnce(inProgress)
    mockPrisma.shift.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })

    const calls = await Promise.allSettled([
      closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, {}, { now: () => NOW }),
      closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, {}, { now: () => NOW }),
    ])

    expect(calls.filter(call => call.status === 'fulfilled')).toHaveLength(1)
    const rejected = calls.find(call => call.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toEqual(expect.objectContaining({ statusCode: 409, code: 'SHIFT_CLOSE_IN_PROGRESS' }))
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.shift.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
    expect(publishCommand).toHaveBeenCalledTimes(1)
  })

  it('never steals a fresh CLOSING claim', async () => {
    const fresh = shift('CLOSING', new Date('2026-08-08T19:58:00.000Z'))
    mockPrisma.shift.findFirst.mockResolvedValue(fresh)
    mockPrisma.shift.updateMany.mockResolvedValue({ count: 0 })

    await expect(closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, {}, { now: () => NOW })).rejects.toEqual(
      expect.objectContaining({ statusCode: 409, code: 'SHIFT_CLOSE_IN_PROGRESS' }),
    )

    expect(mockPrisma.shift.updateMany).toHaveBeenCalledTimes(1)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(publishCommand).not.toHaveBeenCalled()
  })

  it('CAS-recovers a CLOSING claim older than five minutes and retries once', async () => {
    const staleAt = new Date('2026-08-08T19:54:59.000Z')
    const stale = shift('CLOSING', staleAt)
    mockPrisma.shift.findFirst.mockResolvedValue(stale)
    mockPrisma.shift.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 })

    await closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, {}, { now: () => NOW })

    expect(mockPrisma.shift.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: SHIFT_ID,
          venueId: VENUE_ID,
          status: 'CLOSING',
          endTime: null,
          updatedAt: staleAt,
        }),
        data: { status: 'CLOSING', updatedAt: NOW },
      }),
    )
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
  })

  it('guardedly releases its own claim when calculation fails before commit', async () => {
    mockPrisma.shift.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mockPrisma.payment.findMany.mockRejectedValue(new Error('payment snapshot failed'))

    await expect(closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, {}, { now: () => NOW })).rejects.toThrow('payment snapshot failed')

    expect(mockPrisma.shift.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: SHIFT_ID, venueId: VENUE_ID, status: 'CLOSING', endTime: null, updatedAt: NOW },
      data: { status: 'OPEN' },
    })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(publishCommand).not.toHaveBeenCalled()
  })

  it('releases the claim if the final transaction rolls back', async () => {
    mockPrisma.shift.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mockPrisma.$transaction.mockRejectedValue(new Error('audit insert failed'))

    await expect(closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, {}, { now: () => NOW })).rejects.toThrow('audit insert failed')

    expect(mockPrisma.shift.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: SHIFT_ID, venueId: VENUE_ID, status: 'CLOSING', endTime: null, updatedAt: NOW },
      data: { status: 'OPEN' },
    })
    expect(publishCommand).not.toHaveBeenCalled()
  })
})
