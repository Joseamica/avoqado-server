/**
 * shiftCapture.test.ts
 *
 * Verifies that the two logAction calls added to shift.tpv.service.ts fire
 * with the correct action / entity / venueId arguments.
 *
 * Coverage:
 *   - openShiftForVenue  → SHIFT_OPENED  (driven through success path)
 *   - closeShiftForVenue → SHIFT_CLOSED  (driven through success path)
 *
 * Strategy: mock prisma locally so we control exactly what DB calls return,
 * then assert logAction was called with the right shape. logAction itself is
 * already mocked by the global setup.ts:
 *   jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
 */

import { logAction } from '@/services/dashboard/activity-log.service'
import { Decimal } from '@prisma/client/runtime/library'

// ── Local prisma mock (overrides the global one for this test file) ───────────
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    shift: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    staffVenue: { findFirst: jest.fn() },
    payment: { findMany: jest.fn() },
    orderItem: { findMany: jest.fn() },
    rawMaterialMovement: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))

// Other deps the service imports at module level
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/communication/rabbitmq/publisher', () => ({
  publishCommand: jest.fn(),
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: {
    getBroadcastingService: jest.fn().mockReturnValue(null),
  },
}))

// ── Helpers ───────────────────────────────────────────────────────────────────
import prisma from '@/utils/prismaClient'

const mockPrisma = prisma as any
const mockLogAction = logAction as jest.MockedFunction<typeof logAction>

const VENUE_ID = 'venue-1'
const SHIFT_ID = 'shift-1'
const STAFF_ID = 'staff-1'

/** Minimal Shift row returned by prisma.shift.create */
function makeCreatedShift(overrides: Record<string, unknown> = {}) {
  return {
    id: SHIFT_ID,
    venueId: VENUE_ID,
    staffId: STAFF_ID,
    startTime: new Date('2026-06-15T10:00:00Z'),
    endTime: null,
    status: 'OPEN',
    startingCash: new Decimal(500),
    endingCash: null,
    totalSales: new Decimal(0),
    totalTips: new Decimal(0),
    totalOrders: 0,
    totalCashPayments: new Decimal(0),
    totalCardPayments: new Decimal(0),
    totalVoucherPayments: new Decimal(0),
    totalOtherPayments: new Decimal(0),
    totalProductsSold: 0,
    cashDeclared: null,
    cardDeclared: null,
    vouchersDeclared: null,
    otherDeclared: null,
    notes: null,
    externalId: null,
    posRawData: null,
    ...overrides,
  }
}

/** Minimal open Shift row returned by prisma.shift.findFirst (for closeShiftForVenue) */
function makeOpenShift(overrides: Record<string, unknown> = {}) {
  return {
    id: SHIFT_ID,
    venueId: VENUE_ID,
    staffId: STAFF_ID,
    startTime: new Date('2026-06-15T10:00:00Z'),
    endTime: null,
    status: 'OPEN',
    startingCash: new Decimal(500),
    externalId: null,
    venue: { posType: 'NONE', posStatus: 'DISCONNECTED', name: 'Test Venue' },
    ...overrides,
  }
}

/** Minimal updated Shift returned by prisma.shift.update (for closeShiftForVenue) */
function makeUpdatedShift(overrides: Record<string, unknown> = {}) {
  return {
    id: SHIFT_ID,
    venueId: VENUE_ID,
    staffId: STAFF_ID,
    startTime: new Date('2026-06-15T10:00:00Z'),
    endTime: new Date('2026-06-15T18:00:00Z'),
    status: 'CLOSED',
    startingCash: new Decimal(500),
    endingCash: new Decimal(1200),
    totalSales: new Decimal(700),
    totalTips: new Decimal(50),
    totalOrders: 5,
    totalCashPayments: new Decimal(700),
    totalCardPayments: new Decimal(0),
    totalVoucherPayments: new Decimal(0),
    totalOtherPayments: new Decimal(0),
    totalProductsSold: 12,
    cashDeclared: new Decimal(700),
    cardDeclared: null,
    vouchersDeclared: null,
    otherDeclared: null,
    notes: null,
    externalId: null,
    inventoryConsumed: [],
    reportData: null,
    ...overrides,
  }
}

// ── Import service (after all mocks are in place) ─────────────────────────────
import { openShiftForVenue, closeShiftForVenue } from '@/services/tpv/shift.tpv.service'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ActivityLog dual-write in shift.tpv.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Silence fire-and-forget — logAction always resolves
    mockLogAction.mockResolvedValue(undefined)
  })

  // ── openShiftForVenue → SHIFT_OPENED ─────────────────────────────────────

  describe('openShiftForVenue → SHIFT_OPENED', () => {
    it('fires logAction with action SHIFT_OPENED, entity Shift, and venueId', async () => {
      // venue exists and is a standalone POS (no integration)
      mockPrisma.venue.findUnique.mockResolvedValue({
        id: VENUE_ID,
        name: 'Test Venue',
        posType: 'NONE',
        posStatus: 'DISCONNECTED',
      })
      // no existing open shift
      mockPrisma.shift.findFirst.mockResolvedValue(null)
      // staff belongs to venue
      mockPrisma.staffVenue.findFirst.mockResolvedValue({
        staffId: STAFF_ID,
        venueId: VENUE_ID,
        posStaffId: null,
        staff: { id: STAFF_ID, firstName: 'Ana', lastName: 'García' },
      })
      const createdShift = makeCreatedShift()
      mockPrisma.shift.create.mockResolvedValue(createdShift)

      await openShiftForVenue(VENUE_ID, STAFF_ID, 500, 'station-1')

      expect(mockLogAction).toHaveBeenCalledTimes(1)
      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SHIFT_OPENED',
          entity: 'Shift',
          entityId: SHIFT_ID,
          venueId: VENUE_ID,
          staffId: STAFF_ID,
        }),
      )
    })

    it('includes startingCash and stationId in data', async () => {
      mockPrisma.venue.findUnique.mockResolvedValue({
        id: VENUE_ID,
        name: 'Test Venue',
        posType: 'NONE',
        posStatus: 'DISCONNECTED',
      })
      mockPrisma.shift.findFirst.mockResolvedValue(null)
      mockPrisma.staffVenue.findFirst.mockResolvedValue({
        staffId: STAFF_ID,
        venueId: VENUE_ID,
        posStaffId: null,
        staff: { id: STAFF_ID, firstName: 'Ana', lastName: 'García' },
      })
      mockPrisma.shift.create.mockResolvedValue(makeCreatedShift())

      await openShiftForVenue(VENUE_ID, STAFF_ID, 250, 'kiosk-2')

      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ startingCash: 250, stationId: 'kiosk-2' }),
        }),
      )
    })

    // ── Regression: return value unchanged ──────────────────────────────────
    it('still returns the created shift object', async () => {
      mockPrisma.venue.findUnique.mockResolvedValue({
        id: VENUE_ID,
        name: 'Test Venue',
        posType: 'NONE',
        posStatus: 'DISCONNECTED',
      })
      mockPrisma.shift.findFirst.mockResolvedValue(null)
      mockPrisma.staffVenue.findFirst.mockResolvedValue({
        staffId: STAFF_ID,
        venueId: VENUE_ID,
        posStaffId: null,
        staff: { id: STAFF_ID, firstName: 'Ana', lastName: 'García' },
      })
      const created = makeCreatedShift()
      mockPrisma.shift.create.mockResolvedValue(created)

      const result = await openShiftForVenue(VENUE_ID, STAFF_ID, 500)

      expect(result).toBe(created)
    })
  })

  // ── closeShiftForVenue → SHIFT_CLOSED ────────────────────────────────────

  describe('closeShiftForVenue → SHIFT_CLOSED', () => {
    beforeEach(() => {
      // Shared setup: open shift in DB
      mockPrisma.shift.findFirst.mockResolvedValue(makeOpenShift())
      // No payments or order items for this base case
      mockPrisma.payment.findMany.mockResolvedValue([])
      mockPrisma.orderItem.findMany.mockResolvedValue([])
      mockPrisma.rawMaterialMovement.findMany.mockResolvedValue([])
    })

    it('fires logAction with action SHIFT_CLOSED, entity Shift, and venueId', async () => {
      const updated = makeUpdatedShift()
      mockPrisma.shift.update.mockResolvedValue(updated)

      await closeShiftForVenue(VENUE_ID, SHIFT_ID)

      expect(mockLogAction).toHaveBeenCalledTimes(1)
      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SHIFT_CLOSED',
          entity: 'Shift',
          entityId: SHIFT_ID,
          venueId: VENUE_ID,
          staffId: STAFF_ID,
        }),
      )
    })

    it('includes totalSales, totalTips, and endingCash in data', async () => {
      const updated = makeUpdatedShift()
      mockPrisma.shift.update.mockResolvedValue(updated)

      await closeShiftForVenue(VENUE_ID, SHIFT_ID)

      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            totalSales: 0, // no payments in mock → computed Decimal(0)
            totalTips: 0,
            endingCash: 1200, // from makeUpdatedShift
          }),
        }),
      )
    })

    it('includes cashDiscrepancy when cashDeclared is provided', async () => {
      const updated = makeUpdatedShift()
      mockPrisma.shift.update.mockResolvedValue(updated)
      // One cash payment of 600; declared 700 → discrepancy = 700 - 600 = 100
      mockPrisma.payment.findMany.mockResolvedValue([
        { id: 'p1', amount: new Decimal(600), tipAmount: new Decimal(0), method: 'CASH' },
      ])

      await closeShiftForVenue(VENUE_ID, SHIFT_ID, { cashDeclared: 700 })

      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cashDiscrepancy: 100 }),
        }),
      )
    })

    it('leaves cashDiscrepancy undefined when no cashDeclared is provided', async () => {
      mockPrisma.shift.update.mockResolvedValue(makeUpdatedShift())

      await closeShiftForVenue(VENUE_ID, SHIFT_ID) // no closeData

      const callArg = mockLogAction.mock.calls[0][0]
      // cashDiscrepancy key is present but explicitly undefined (no cashDeclared supplied)
      expect(callArg.data?.cashDiscrepancy).toBeUndefined()
    })

    // ── Regression: return value unchanged ──────────────────────────────────
    it('still returns the updated shift object', async () => {
      const updated = makeUpdatedShift()
      mockPrisma.shift.update.mockResolvedValue(updated)

      const result = await closeShiftForVenue(VENUE_ID, SHIFT_ID)

      expect(result).toBe(updated)
    })
  })
})
