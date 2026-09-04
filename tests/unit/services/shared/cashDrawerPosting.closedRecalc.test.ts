/**
 * Task 5o: a late movement changes the signed result of an already counted drawer. When that
 * drawer is explicitly linked to the same counted, closed Shift, both records must keep the same
 * signed difference. Invalid or stale links keep the valid drawer repair and surface a pending
 * reconciliation instead of guessing a Shift value.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { postCashSaleToDrawer } from '@/services/shared/cashDrawerPosting'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const SESSION = 'drawer-closed-1'
const SHIFT = 'shift-closed-1'

const sale = (over: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  paymentId: 'payment-late-1',
  method: 'CASH',
  status: 'COMPLETED',
  type: 'REGULAR',
  amount: '100.00',
  tipAmount: '0.00',
  staffId: 'staff-1',
  staffName: 'Cajero',
  orderId: 'order-1',
  targetSessionId: SESSION,
  ...over,
})

const closedDrawer = (over: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  status: 'CLOSED',
  shiftId: SHIFT,
  actualAmount: new Prisma.Decimal('1100.00'),
  overShort: new Prisma.Decimal('100.00'),
  startingAmount: new Prisma.Decimal('1000.00'),
  events: [{ type: 'CASH_SALE', amount: new Prisma.Decimal('100.00') }],
  ...over,
})

const closedShift = (over: Record<string, unknown> = {}) => ({
  id: SHIFT,
  venueId: VENUE,
  status: 'CLOSED',
  cashDeclared: new Prisma.Decimal('1100.00'),
  cashDifference: new Prisma.Decimal('100.00'),
  ...over,
})

function world(
  options: {
    drawer?: ReturnType<typeof closedDrawer>
    shift?: ReturnType<typeof closedShift> | null
    inserted?: number
    shiftUpdated?: number
  } = {},
) {
  const drawer = options.drawer ?? closedDrawer()
  const shift = options.shift === undefined ? closedShift() : options.shift
  const drawerUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
  const eventCreateMany = jest.fn().mockResolvedValue({ count: options.inserted ?? 1 })
  const drawerFindFirst = jest.fn().mockResolvedValue(drawer)
  const shiftFindFirst = jest.fn().mockResolvedValue(shift)
  const shiftUpdateMany = jest.fn().mockResolvedValue({ count: options.shiftUpdated ?? 1 })
  const tx = {
    cashDrawerSession: { updateMany: drawerUpdateMany, findFirst: drawerFindFirst },
    cashDrawerEvent: { createMany: eventCreateMany },
    shift: { findFirst: shiftFindFirst, updateMany: shiftUpdateMany },
  }

  ;(prismaMock as any).cashDrawerSession = {
    findFirst: jest.fn().mockResolvedValue({ id: SESSION }),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  }
  ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn() }
  ;(prismaMock as any).shift = { findFirst: jest.fn(), updateMany: jest.fn() }
  ;(prismaMock as any).$transaction = jest.fn((callback: any) => callback(tx))

  return { tx, drawerUpdateMany, eventCreateMany, drawerFindFirst, shiftFindFirst, shiftUpdateMany }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('late posting keeps an explicitly linked closed drawer and Shift aligned', () => {
  it('atomically inserts the event and writes the same exact Decimal difference to the counted drawer and Shift', async () => {
    const w = world()

    expect(await postCashSaleToDrawer(sale() as any)).toBe('POSTED')

    expect((prismaMock as any).$transaction).toHaveBeenCalledTimes(1)
    expect(w.eventCreateMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }))
    expect(w.drawerFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: SESSION, venueId: VENUE } }))
    expect(w.drawerUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: SESSION, venueId: VENUE },
      data: { overShort: expect.any(Prisma.Decimal) },
    })
    expect(w.drawerUpdateMany.mock.calls[1][0].data.overShort.toFixed(2)).toBe('0.00')
    expect(w.shiftUpdateMany).toHaveBeenCalledWith({
      where: {
        id: SHIFT,
        venueId: VENUE,
        status: 'CLOSED',
        cashDeclared: new Prisma.Decimal('1100.00'),
        cashDifference: new Prisma.Decimal('100.00'),
      },
      data: { cashDifference: expect.any(Prisma.Decimal) },
    })
    expect(w.shiftUpdateMany.mock.calls[0][0].data.cashDifference.toFixed(2)).toBe('0.00')
    expect(w.eventCreateMany.mock.invocationCallOrder[0]).toBeLessThan(w.drawerUpdateMany.mock.invocationCallOrder[1])
    expect(w.drawerUpdateMany.mock.invocationCallOrder[1]).toBeLessThan(w.shiftUpdateMany.mock.invocationCallOrder[0])
    expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
    expect((prismaMock as any).cashDrawerSession.update).not.toHaveBeenCalled()
    expect((prismaMock as any).shift.updateMany).not.toHaveBeenCalled()
  })

  it('writes drawer and Shift ActivityLog rows with provenance and their own before/after peso values', async () => {
    world()

    await postCashSaleToDrawer(sale() as any)

    expect(logAction).toHaveBeenCalledTimes(2)
    expect(logAction).toHaveBeenCalledWith({
      staffId: 'staff-1',
      venueId: VENUE,
      action: 'CASH_DRAWER_ADJUSTED_AFTER_CLOSE',
      entity: 'CashDrawerSession',
      entityId: SESSION,
      data: expect.objectContaining({
        cause: 'CASH_SALE',
        localId: 'srv-cash-sale:payment-late-1',
        source: 'RECONCILER',
        amountPesos: '100.00',
        overShortBeforePesos: '100.00',
        overShortAfterPesos: '0.00',
        linkedShiftId: SHIFT,
        shiftReconciliationStatus: 'APPLIED',
      }),
    })
    expect(logAction).toHaveBeenCalledWith({
      staffId: 'staff-1',
      venueId: VENUE,
      action: 'SHIFT_UPDATED',
      entity: 'Shift',
      entityId: SHIFT,
      data: {
        cause: 'CASH_SALE',
        localId: 'srv-cash-sale:payment-late-1',
        source: 'RECONCILER',
        amountPesos: '100.00',
        cashDifferenceBeforePesos: '100.00',
        cashDifferenceAfterPesos: '0.00',
        cashDrawerSessionId: SESSION,
      },
    })
  })

  it('keeps the drawer repair when the explicit Shift relation is missing and marks its audit pending', async () => {
    const w = world({ drawer: closedDrawer({ shiftId: null }) })

    expect(await postCashSaleToDrawer(sale() as any)).toBe('POSTED')

    expect(w.drawerUpdateMany.mock.calls[1][0].data.overShort.toFixed(2)).toBe('0.00')
    expect(w.shiftFindFirst).not.toHaveBeenCalled()
    expect(w.shiftUpdateMany).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalledTimes(1)
    expect((logAction as jest.Mock).mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        linkedShiftId: null,
        shiftReconciliationStatus: 'PENDING',
        shiftReconciliationPendingReason: 'MISSING_SHIFT_RELATION',
      }),
    )
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('LATE_SHIFT_RECONCILIATION_PENDING'),
      expect.objectContaining({ venueId: VENUE, sessionId: SESSION, reason: 'MISSING_SHIFT_RELATION' }),
    )
  })

  it.each([
    ['SHIFT_NOT_FOUND_OR_CROSS_VENUE', null, closedDrawer()],
    ['SHIFT_NOT_CLOSED', closedShift({ status: 'OPEN' }), closedDrawer()],
    ['SHIFT_MISSING_CASH_DECLARED', closedShift({ cashDeclared: null }), closedDrawer()],
  ])('does not invent a Shift value for %s and leaves a visible pending reason', async (reason, shift, drawer) => {
    const w = world({ shift: shift as any, drawer })

    expect(await postCashSaleToDrawer(sale() as any)).toBe('POSTED')

    expect(w.drawerUpdateMany).toHaveBeenCalledTimes(2)
    expect(w.shiftFindFirst).toHaveBeenCalledWith({
      where: { id: SHIFT, venueId: VENUE },
      select: { id: true, venueId: true, status: true, cashDeclared: true, cashDifference: true },
    })
    expect(w.shiftUpdateMany).not.toHaveBeenCalled()
    expect((logAction as jest.Mock).mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        linkedShiftId: SHIFT,
        shiftReconciliationStatus: 'PENDING',
        shiftReconciliationPendingReason: reason,
      }),
    )
  })

  it('does not overwrite a closed Shift whose declared count differs from the drawer count', async () => {
    const w = world({ shift: closedShift({ cashDeclared: new Prisma.Decimal('1099.99') }) })

    expect(await postCashSaleToDrawer(sale() as any)).toBe('POSTED')

    expect(w.drawerUpdateMany.mock.calls[1][0].data.overShort.toFixed(2)).toBe('0.00')
    expect(w.shiftUpdateMany).not.toHaveBeenCalled()
    expect((logAction as jest.Mock).mock.calls[0][0].data).toEqual(
      expect.objectContaining({ shiftReconciliationPendingReason: 'SHIFT_COUNT_MISMATCH' }),
    )
  })

  it('does not overwrite a concurrent owner edit when the tenant/state/count/current-difference CAS loses', async () => {
    const w = world({ shiftUpdated: 0 })

    expect(await postCashSaleToDrawer(sale() as any)).toBe('POSTED')

    expect(w.drawerUpdateMany.mock.calls[1][0].data.overShort.toFixed(2)).toBe('0.00')
    expect(w.shiftUpdateMany).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledTimes(1)
    expect((logAction as jest.Mock).mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        linkedShiftId: SHIFT,
        shiftReconciliationStatus: 'PENDING',
        shiftReconciliationPendingReason: 'SHIFT_CONCURRENT_WRITE_LOST',
      }),
    )
  })

  it('keeps the valid Decimal(12,2) drawer repair pending when the difference exceeds Shift Decimal(10,2)', async () => {
    const w = world({
      drawer: closedDrawer({
        actualAmount: new Prisma.Decimal('99999999.99'),
        overShort: new Prisma.Decimal('99999999.99'),
        startingAmount: new Prisma.Decimal('0.00'),
        events: [{ type: 'PAY_OUT', amount: new Prisma.Decimal('1.00') }],
      }),
      shift: closedShift({ cashDeclared: new Prisma.Decimal('99999999.99') }),
    })

    expect(await postCashSaleToDrawer(sale() as any)).toBe('POSTED')

    expect(w.drawerUpdateMany.mock.calls[1][0].data.overShort.toFixed(2)).toBe('100000000.99')
    expect(w.shiftUpdateMany).not.toHaveBeenCalled()
    expect((logAction as jest.Mock).mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        overShortAfterPesos: '100000000.99',
        shiftReconciliationPendingReason: 'SHIFT_DIFFERENCE_OVERFLOW',
      }),
    )
  })
})

describe('late-posting regressions', () => {
  it('a duplicate event is a no-op for both signed differences and both audit rows', async () => {
    const w = world({ inserted: 0 })

    expect(await postCashSaleToDrawer(sale() as any)).toBe('ALREADY_POSTED')

    expect(w.drawerFindFirst).not.toHaveBeenCalled()
    expect(w.drawerUpdateMany).toHaveBeenCalledTimes(1)
    expect(w.shiftFindFirst).not.toHaveBeenCalled()
    expect(w.shiftUpdateMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('an open session still only inserts the event and does not touch either signed difference', async () => {
    const w = world()

    expect(await postCashSaleToDrawer(sale({ targetSessionId: undefined }) as any)).toBe('POSTED')

    expect(w.drawerUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: SESSION, venueId: VENUE, status: 'OPEN' } }))
    expect(w.drawerFindFirst).not.toHaveBeenCalled()
    expect(w.drawerUpdateMany).toHaveBeenCalledTimes(1)
    expect(w.shiftFindFirst).not.toHaveBeenCalled()
    expect(w.shiftUpdateMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
})
