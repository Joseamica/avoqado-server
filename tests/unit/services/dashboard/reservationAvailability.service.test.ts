import { getAvailableSlots, checkConflicts } from '@/services/dashboard/reservationAvailability.service'
import { prismaMock } from '@tests/__helpers__/setup'

// ---- Helpers ----

const VENUE_ID = 'venue-123'

const createMockTable = (overrides: Record<string, any> = {}) => ({
  id: 'table-1',
  number: '1',
  capacity: 4,
  ...overrides,
})

const createMockStaff = (overrides: Record<string, any> = {}) => ({
  id: 'staff-1',
  firstName: 'Ana',
  lastName: 'Garcia',
  ...overrides,
})

const createMockReservation = (overrides: Record<string, any> = {}) => ({
  id: 'res-existing',
  startsAt: new Date('2026-03-03T12:00:00Z'),
  endsAt: new Date('2026-03-03T13:00:00Z'),
  tableId: 'table-1',
  assignedStaffId: null,
  productId: null,
  partySize: 2,
  status: 'CONFIRMED',
  ...overrides,
})

const defaultModuleConfig = {
  scheduling: {
    slotIntervalMin: 60, // 1-hour intervals for simpler test math
    defaultDurationMin: 60,
    onlineCapacityPercent: 100,
    pacingMaxPerSlot: null,
  },
  operatingHours: {
    monday: { enabled: true, ranges: [{ open: '08:00', close: '22:00' }] },
    tuesday: { enabled: true, ranges: [{ open: '08:00', close: '22:00' }] },
    wednesday: { enabled: true, ranges: [{ open: '08:00', close: '22:00' }] },
    thursday: { enabled: true, ranges: [{ open: '08:00', close: '22:00' }] },
    friday: { enabled: true, ranges: [{ open: '08:00', close: '22:00' }] },
    saturday: { enabled: true, ranges: [{ open: '08:00', close: '22:00' }] },
    sunday: { enabled: true, ranges: [{ open: '08:00', close: '22:00' }] },
  },
}

const TEST_DATE = '2026-03-03'

const getSlots = (options: any = {}, config: any = defaultModuleConfig) => getAvailableSlots(VENUE_ID, TEST_DATE, options, config, 'UTC')

describe('Reservation Availability Service', () => {
  beforeEach(() => {
    jest.resetAllMocks()
  })

  // ==========================================
  // getAvailableSlots
  // ==========================================

  describe('getAvailableSlots', () => {
    it('should generate slots within operating hours (8:00-22:00 UTC)', async () => {
      prismaMock.reservation.findMany.mockResolvedValue([])
      prismaMock.table.findMany.mockResolvedValue([createMockTable()])
      prismaMock.staff.findMany.mockResolvedValue([createMockStaff()])

      const result = await getSlots()

      // With 60min interval + 60min duration, slots from 8:00 to 21:00 = 14 slots
      expect(result.length).toBe(14)

      // First slot starts at 8:00
      expect(result[0].startsAt.getUTCHours()).toBe(8)
      expect(result[0].endsAt.getUTCHours()).toBe(9)

      // Last slot starts at 21:00, ends at 22:00
      expect(result[result.length - 1].startsAt.getUTCHours()).toBe(21)
      expect(result[result.length - 1].endsAt.getUTCHours()).toBe(22)
    })

    it('should exclude slots where all tables are booked', async () => {
      const tables = [createMockTable({ id: 'table-1', capacity: 4 })]

      // Reservation occupying 12:00-13:00
      const existingRes = [createMockReservation({ tableId: 'table-1' })]

      prismaMock.reservation.findMany.mockResolvedValue(existingRes)
      prismaMock.table.findMany.mockResolvedValue(tables)
      prismaMock.staff.findMany.mockResolvedValue([createMockStaff()])

      const result = await getSlots({ partySize: 2 })

      // The 12:00 slot should be excluded (only table is booked)
      const noon = result.find(s => s.startsAt.getUTCHours() === 12)
      expect(noon).toBeUndefined()

      // Other slots should still be available
      const elevenAm = result.find(s => s.startsAt.getUTCHours() === 11)
      expect(elevenAm).toBeDefined()
    })

    it('should include slots with available tables even when others are booked', async () => {
      const tables = [createMockTable({ id: 'table-1', capacity: 4 }), createMockTable({ id: 'table-2', number: '2', capacity: 6 })]

      // Only table-1 is booked at 12:00
      const existingRes = [createMockReservation({ tableId: 'table-1' })]

      prismaMock.reservation.findMany.mockResolvedValue(existingRes)
      prismaMock.table.findMany.mockResolvedValue(tables)
      prismaMock.staff.findMany.mockResolvedValue([])

      const result = await getSlots({ partySize: 2 })

      // 12:00 slot should still exist because table-2 is available
      const noon = result.find(s => s.startsAt.getUTCHours() === 12)
      expect(noon).toBeDefined()
      expect(noon!.availableTables).toHaveLength(1)
      expect(noon!.availableTables[0].id).toBe('table-2')
    })

    it('should respect pacing limits (pacingMaxPerSlot)', async () => {
      const config = {
        scheduling: {
          ...defaultModuleConfig.scheduling,
          pacingMaxPerSlot: 2,
        },
      }

      // 2 reservations already at 12:00
      const existingRes = [
        createMockReservation({ id: 'res-1', tableId: 'table-1' }),
        createMockReservation({ id: 'res-2', tableId: 'table-2' }),
      ]

      prismaMock.reservation.findMany.mockResolvedValue(existingRes)
      prismaMock.table.findMany.mockResolvedValue([
        createMockTable({ id: 'table-1' }),
        createMockTable({ id: 'table-2' }),
        createMockTable({ id: 'table-3', number: '3' }),
      ])
      prismaMock.staff.findMany.mockResolvedValue([])

      const result = await getSlots({}, config)

      // 12:00 slot should be excluded due to pacing limit (2 already at slot)
      const noon = result.find(s => s.startsAt.getUTCHours() === 12)
      expect(noon).toBeUndefined()
    })

    it('should check specific table availability when tableId provided', async () => {
      // Table-1 is booked at 12:00
      const existingRes = [createMockReservation({ tableId: 'table-1' })]

      prismaMock.reservation.findMany.mockResolvedValue(existingRes)
      prismaMock.table.findMany.mockResolvedValue([createMockTable({ id: 'table-1' }), createMockTable({ id: 'table-2', number: '2' })])
      prismaMock.staff.findMany.mockResolvedValue([])

      const result = await getSlots({ tableId: 'table-1' })

      // 12:00 slot for table-1 should be excluded
      const noon = result.find(s => s.startsAt.getUTCHours() === 12)
      expect(noon).toBeUndefined()
    })

    it('should check specific staff availability when staffId provided', async () => {
      // Staff-1 has a reservation at 14:00
      const existingRes = [
        createMockReservation({
          startsAt: new Date('2026-03-03T14:00:00Z'),
          endsAt: new Date('2026-03-03T15:00:00Z'),
          assignedStaffId: 'staff-1',
          tableId: null,
        }),
      ]

      prismaMock.reservation.findMany.mockResolvedValue(existingRes)
      prismaMock.table.findMany.mockResolvedValue([createMockTable()])
      prismaMock.staff.findMany.mockResolvedValue([createMockStaff({ id: 'staff-1' })])

      const result = await getSlots({ staffId: 'staff-1' })

      // 14:00 slot for staff-1 should be excluded
      const twoPm = result.find(s => s.startsAt.getUTCHours() === 14)
      expect(twoPm).toBeUndefined()
    })

    it('should respect product capacity and onlineCapacityPercent', async () => {
      // Product with capacity 10, online at 50% = effective 5
      // 5 reservations × partySize 2 = 10 occupied >> 5 effective capacity
      prismaMock.reservation.findMany.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) =>
          createMockReservation({
            id: `res-${i}`,
            productId: 'prod-1',
            tableId: null,
          }),
        ),
      )
      prismaMock.table.findMany.mockResolvedValue([createMockTable()])
      prismaMock.staff.findMany.mockResolvedValue([])
      prismaMock.product.findFirst.mockResolvedValue({ id: 'prod-1', eventCapacity: 10 })

      const config = {
        scheduling: {
          ...defaultModuleConfig.scheduling,
          onlineCapacityPercent: 50,
        },
      }

      const result = await getSlots({ productId: 'prod-1' }, config)

      // 12:00 slot: 10 occupied (5×2), capacity 5 (50% of 10) -> should be excluded
      const noon = result.find(s => s.startsAt.getUTCHours() === 12)
      expect(noon).toBeUndefined()
    })

    it('should sum partySize (not count reservations) for product capacity', async () => {
      // 20 bikes class: 3 reservations with partySize 1 = 3 occupied, 17 remaining
      prismaMock.reservation.findMany.mockResolvedValue(
        Array.from({ length: 3 }, (_, i) =>
          createMockReservation({
            id: `res-${i}`,
            productId: 'prod-bikes',
            tableId: null,
            partySize: 1,
          }),
        ),
      )
      prismaMock.table.findMany.mockResolvedValue([createMockTable()])
      prismaMock.staff.findMany.mockResolvedValue([])
      prismaMock.product.findFirst.mockResolvedValue({ id: 'prod-bikes', eventCapacity: 20 })

      const result = await getSlots({ productId: 'prod-bikes', partySize: 4 })

      // 3 occupied + 4 requested = 7 ≤ 20 → slot should be available
      const noon = result.find(s => s.startsAt.getUTCHours() === 12)
      expect(noon).toBeDefined()
    })

    it('should reject when requested partySize exceeds remaining product capacity', async () => {
      // 20 bikes class: 18 occupied (9 reservations × partySize 2), requesting 4 more
      prismaMock.reservation.findMany.mockResolvedValue(
        Array.from({ length: 9 }, (_, i) =>
          createMockReservation({
            id: `res-${i}`,
            productId: 'prod-bikes',
            tableId: null,
            partySize: 2,
          }),
        ),
      )
      prismaMock.table.findMany.mockResolvedValue([createMockTable()])
      prismaMock.staff.findMany.mockResolvedValue([])
      prismaMock.product.findFirst.mockResolvedValue({ id: 'prod-bikes', eventCapacity: 20 })

      const result = await getSlots({ productId: 'prod-bikes', partySize: 4 })

      // 18 occupied + 4 requested = 22 > 20 → slot excluded
      const noon = result.find(s => s.startsAt.getUTCHours() === 12)
      expect(noon).toBeUndefined()
    })

    it('should allow when requested partySize fits remaining product capacity', async () => {
      // 20 bikes class: 18 occupied, requesting 2 more
      prismaMock.reservation.findMany.mockResolvedValue(
        Array.from({ length: 9 }, (_, i) =>
          createMockReservation({
            id: `res-${i}`,
            productId: 'prod-bikes',
            tableId: null,
            partySize: 2,
          }),
        ),
      )
      prismaMock.table.findMany.mockResolvedValue([createMockTable()])
      prismaMock.staff.findMany.mockResolvedValue([])
      prismaMock.product.findFirst.mockResolvedValue({ id: 'prod-bikes', eventCapacity: 20 })

      const result = await getSlots({ productId: 'prod-bikes', partySize: 2 })

      // 18 occupied + 2 requested = 20 ≤ 20 → slot available
      const noon = result.find(s => s.startsAt.getUTCHours() === 12)
      expect(noon).toBeDefined()
    })

    it('should return empty when no tables match party size', async () => {
      prismaMock.reservation.findMany.mockResolvedValue([])
      prismaMock.table.findMany.mockResolvedValue([createMockTable({ capacity: 2 })]) // Only 2-seat table
      prismaMock.staff.findMany.mockResolvedValue([])

      const result = await getSlots({ partySize: 6 })

      // No tables can seat 6 people
      expect(result).toHaveLength(0)
    })

    it('should filter booked tables even when no partySize or tableId is provided (Bug 4)', async () => {
      const tables = [createMockTable({ id: 'table-1', capacity: 4 }), createMockTable({ id: 'table-2', number: '2', capacity: 4 })]

      // table-1 is booked at 12:00
      const existingRes = [createMockReservation({ tableId: 'table-1' })]

      prismaMock.reservation.findMany.mockResolvedValue(existingRes)
      prismaMock.table.findMany.mockResolvedValue(tables)
      prismaMock.staff.findMany.mockResolvedValue([])

      // No partySize, no tableId
      const result = await getSlots()

      // 12:00 slot should exist but only show table-2 as available (table-1 is booked)
      const noon = result.find(s => s.startsAt.getUTCHours() === 12)
      expect(noon).toBeDefined()
      expect(noon!.availableTables).toHaveLength(1)
      expect(noon!.availableTables[0].id).toBe('table-2')
    })

    it('should use custom slot interval from module config', async () => {
      const config = {
        scheduling: {
          slotIntervalMin: 30, // 30-minute intervals
          defaultDurationMin: 60,
          onlineCapacityPercent: 100,
          pacingMaxPerSlot: null,
        },
        operatingHours: defaultModuleConfig.operatingHours,
      }

      prismaMock.reservation.findMany.mockResolvedValue([])
      prismaMock.table.findMany.mockResolvedValue([createMockTable()])
      prismaMock.staff.findMany.mockResolvedValue([])

      const result = await getSlots({}, config)

      // With 30min interval + 60min duration: 8:00 to 21:30 = 28 slots
      // (Last possible start: 21:00 because 21:30 + 60min = 22:30 > 22:00)
      expect(result.length).toBe(27)
    })
  })

  // ==========================================
  // checkConflicts
  // ==========================================

  describe('checkConflicts', () => {
    it('should return no conflicts when none exist', async () => {
      prismaMock.reservation.findMany.mockResolvedValue([])

      const result = await checkConflicts(VENUE_ID, new Date('2026-03-01T14:00:00Z'), new Date('2026-03-01T15:00:00Z'), {})

      expect(result.hasConflict).toBe(false)
      expect(result.conflicts).toHaveLength(0)
    })

    it('should detect overlapping reservations', async () => {
      const conflicting = {
        id: 'res-conflict',
        confirmationCode: 'RES-CONF',
        startsAt: new Date('2026-03-01T14:30:00Z'),
        endsAt: new Date('2026-03-01T15:30:00Z'),
        status: 'CONFIRMED',
      }

      prismaMock.reservation.findMany.mockResolvedValue([conflicting])

      const result = await checkConflicts(VENUE_ID, new Date('2026-03-01T14:00:00Z'), new Date('2026-03-01T15:00:00Z'), {})

      expect(result.hasConflict).toBe(true)
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0].id).toBe('res-conflict')
    })

    it('should filter by tableId when provided', async () => {
      prismaMock.reservation.findMany.mockResolvedValue([])

      await checkConflicts(VENUE_ID, new Date('2026-03-01T14:00:00Z'), new Date('2026-03-01T15:00:00Z'), { tableId: 'table-1' })

      expect(prismaMock.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tableId: 'table-1',
          }),
        }),
      )
    })

    it('should filter by staffId when provided', async () => {
      prismaMock.reservation.findMany.mockResolvedValue([])

      await checkConflicts(VENUE_ID, new Date('2026-03-01T14:00:00Z'), new Date('2026-03-01T15:00:00Z'), { staffId: 'staff-1' })

      expect(prismaMock.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            assignedStaffId: 'staff-1',
          }),
        }),
      )
    })

    it('should exclude a specific reservation when checking for reschedule', async () => {
      prismaMock.reservation.findMany.mockResolvedValue([])

      await checkConflicts(VENUE_ID, new Date('2026-03-01T14:00:00Z'), new Date('2026-03-01T15:00:00Z'), {
        excludeReservationId: 'res-1',
      })

      expect(prismaMock.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { not: 'res-1' },
          }),
        }),
      )
    })
  })

  // ==========================================
  // REGRESSION TESTS
  // ==========================================

  describe('Regression', () => {
    it('should only consider active statuses for conflicts (not CANCELLED/COMPLETED/NO_SHOW)', async () => {
      prismaMock.reservation.findMany.mockResolvedValue([])

      await checkConflicts(VENUE_ID, new Date('2026-03-01T14:00:00Z'), new Date('2026-03-01T15:00:00Z'), {})

      expect(prismaMock.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
          }),
        }),
      )
    })
  })
})
