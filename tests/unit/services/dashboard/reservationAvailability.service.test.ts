import { getAvailableSlots, checkConflicts } from '@/services/dashboard/reservationAvailability.service'
import { prismaMock, primeReservationStaffMocks } from '@tests/__helpers__/setup'

// ---- Helpers ----

const VENUE_ID = 'venue-123'

// getAvailableSlots now filters out slots before `now` (commit eed319e6), so a
// hardcoded calendar date silently rots into the past and zeroes out every slot
// (see memory: test-hardcoded-dates-timebomb). Anchor the suite to a future day
// computed at run time, and keep every mock reservation/block on that same day.
const TEST_DAY = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
const TEST_DATE = TEST_DAY.toISOString().slice(0, 10) // YYYY-MM-DD (UTC)

/** A UTC Date at HH:MM on TEST_DATE — keeps mock reservations/blocks on the test day. */
const at = (hour: number, minute = 0) => new Date(`${TEST_DATE}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`)

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
  startsAt: at(12),
  endsAt: at(13),
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

const getSlots = (options: any = {}, config: any = defaultModuleConfig) => getAvailableSlots(VENUE_ID, TEST_DATE, options, config, 'UTC')

const staffAwareConfig = (pacingMaxPerSlot: number | null = null) => ({
  ...defaultModuleConfig,
  scheduling: {
    ...defaultModuleConfig.scheduling,
    capacityMode: 'per_staff' as const,
    pacingMaxPerSlot,
  },
  publicBooking: { showStaffPicker: false },
})

function primeStaffAwareAvailability(
  overrides: {
    products?: Array<{ id: string; duration: number | null; durationMinutes: number | null }>
    existingReservations?: any[]
    staffConflicts?: any[]
    classConflicts?: any[]
    activeHolds?: any[]
    staffHolds?: any[]
    externalBlocks?: any[]
    candidates?: any[]
    mappings?: any[]
  } = {},
) {
  const products = overrides.products ?? [{ id: 'product-1', duration: 60, durationMinutes: null }]
  const candidates = overrides.candidates ?? [
    {
      id: 'sv-a',
      staffId: 'staff-a',
      startDate: new Date('2024-01-01T00:00:00.000Z'),
      venue: { organizationId: 'org-1', timezone: 'UTC' },
      staff: { id: 'staff-a', firstName: 'Ana', lastName: 'Alfa' },
    },
  ]
  const memberships = candidates.map(candidate => ({ staffId: candidate.staffId, venueId: VENUE_ID }))
  const mappings =
    overrides.mappings ?? candidates.flatMap(candidate => products.map(product => ({ productId: product.id, staffVenueId: candidate.id })))

  prismaMock.product.findMany.mockResolvedValue(products)
  prismaMock.product.findFirst.mockResolvedValue({ eventCapacity: null, type: 'APPOINTMENTS_SERVICE' })
  prismaMock.reservation.findMany
    .mockResolvedValueOnce(overrides.existingReservations ?? [])
    .mockResolvedValueOnce(overrides.staffConflicts ?? [])
  prismaMock.table.findMany.mockResolvedValue([])
  prismaMock.staff.findMany.mockResolvedValue(candidates.map(candidate => candidate.staff))
  prismaMock.staffVenue.findMany.mockResolvedValueOnce(candidates).mockResolvedValueOnce(memberships)
  prismaMock.productStaff.findMany.mockResolvedValue(mappings)
  prismaMock.staffSchedule.findMany.mockResolvedValue([])
  prismaMock.staffScheduleException.findMany.mockResolvedValue([])
  prismaMock.classSession.findMany.mockResolvedValue(overrides.classConflicts ?? [])
  prismaMock.slotHold.findMany.mockResolvedValueOnce(overrides.activeHolds ?? []).mockResolvedValueOnce(overrides.staffHolds ?? [])
  prismaMock.externalBusyBlock.findMany.mockResolvedValue(overrides.externalBlocks ?? [])
  prismaMock.reservation.groupBy.mockResolvedValue([])
}

describe('Reservation Availability Service', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    primeReservationStaffMocks()
    // Default: no external busy blocks. Tests opt in by overriding.
    prismaMock.externalBusyBlock.findMany.mockResolvedValue([])
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
      expect(result.every(slot => !('available' in slot) && !('reason' in slot))).toBe(true)
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
          startsAt: at(14),
          endsAt: at(15),
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

    describe('legacy reschedule staff eligibility', () => {
      it('returns no slots when the current staff venue membership is inactive', async () => {
        prismaMock.reservation.findMany.mockResolvedValue([])
        prismaMock.table.findMany.mockResolvedValue([])
        // Prisma excludes this staff member because the existing relation filter
        // requires an active StaffVenue membership.
        prismaMock.staff.findMany.mockResolvedValue([])

        const result = await getSlots({ staffId: 'staff-1', fixedDurationMin: 60 })

        expect(result).toEqual([])
        expect(prismaMock.staff.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              venues: { some: { venueId: VENUE_ID, active: true } },
            }),
          }),
        )
      })

      it('returns no slots when the current staff account is inactive', async () => {
        prismaMock.reservation.findMany.mockResolvedValue([])
        prismaMock.table.findMany.mockResolvedValue([])
        // Simulate Prisma query semantics: without Staff.active=true the legacy
        // query returns the inactive account; with the guard it returns none.
        prismaMock.staff.findMany.mockImplementation(({ where }: any) =>
          Promise.resolve(where?.active === true ? [] : [createMockStaff({ id: 'staff-1' })]),
        )

        const result = await getSlots({ staffId: 'staff-1', fixedDurationMin: 60 })

        expect(result).toEqual([])
        expect(prismaMock.staff.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              id: 'staff-1',
              active: true,
              venues: { some: { venueId: VENUE_ID, active: true } },
            }),
          }),
        )
      })
    })

    // ============================================================
    // ExternalBusyBlock integration (Phase 1 — Task 27)
    // ============================================================

    describe('external busy blocks (Google Calendar)', () => {
      it('excludes slots covered by a venue-master ExternalBusyBlock', async () => {
        prismaMock.reservation.findMany.mockResolvedValue([])
        prismaMock.table.findMany.mockResolvedValue([createMockTable()])
        prismaMock.staff.findMany.mockResolvedValue([createMockStaff()])
        prismaMock.externalBusyBlock.findMany.mockResolvedValue([
          {
            startsAt: at(12),
            endsAt: at(13),
            staffId: null,
            venueId: VENUE_ID,
          },
        ])

        const result = await getSlots()

        // The 12:00 slot should be excluded — venue-master block is in force
        const noon = result.find(s => s.startsAt.getUTCHours() === 12)
        expect(noon).toBeUndefined()
        // Adjacent and non-overlapping slots are still available
        const eleven = result.find(s => s.startsAt.getUTCHours() === 11)
        expect(eleven).toBeDefined()
        const onePm = result.find(s => s.startsAt.getUTCHours() === 13)
        expect(onePm).toBeDefined()
      })

      it('excludes slots when a staff-personal block applies and staffId is requested', async () => {
        prismaMock.reservation.findMany.mockResolvedValue([])
        prismaMock.table.findMany.mockResolvedValue([createMockTable()])
        prismaMock.staff.findMany.mockResolvedValue([createMockStaff({ id: 'staff-1' })])
        prismaMock.externalBusyBlock.findMany.mockResolvedValue([
          {
            startsAt: at(14),
            endsAt: at(15),
            staffId: 'staff-1',
            venueId: null,
          },
        ])

        const result = await getSlots({ staffId: 'staff-1' })

        // 14:00 slot blocked by the staff-personal external event
        const twoPm = result.find(s => s.startsAt.getUTCHours() === 14)
        expect(twoPm).toBeUndefined()
      })

      it('does not query staff-personal blocks when no staffId is requested', async () => {
        prismaMock.reservation.findMany.mockResolvedValue([])
        prismaMock.table.findMany.mockResolvedValue([createMockTable()])
        prismaMock.staff.findMany.mockResolvedValue([createMockStaff()])
        prismaMock.externalBusyBlock.findMany.mockResolvedValue([])

        await getSlots()

        const findArg = prismaMock.externalBusyBlock.findMany.mock.calls[0][0]
        // OR should only contain the venue clause when staffId is not provided
        expect(findArg.where.OR).toHaveLength(1)
        expect(findArg.where.OR[0].venueId).toBe(VENUE_ID)
      })

      it('queries staff-personal blocks when staffId is requested', async () => {
        prismaMock.reservation.findMany.mockResolvedValue([])
        prismaMock.table.findMany.mockResolvedValue([createMockTable()])
        prismaMock.staff.findMany.mockResolvedValue([createMockStaff({ id: 'staff-1' })])
        prismaMock.externalBusyBlock.findMany.mockResolvedValue([])

        await getSlots({ staffId: 'staff-1' })

        const findArg = prismaMock.externalBusyBlock.findMany.mock.calls[0][0]
        expect(findArg.where.OR).toHaveLength(2)
        expect(findArg.where.OR[0].venueId).toBe(VENUE_ID)
        expect(findArg.where.OR[1].staffId).toBe('staff-1')
      })

      it('REGRESSION: empty externalBusyBlock list does not affect normal availability', async () => {
        prismaMock.reservation.findMany.mockResolvedValue([])
        prismaMock.table.findMany.mockResolvedValue([createMockTable()])
        prismaMock.staff.findMany.mockResolvedValue([createMockStaff()])
        prismaMock.externalBusyBlock.findMany.mockResolvedValue([])

        const result = await getSlots()

        expect(result.length).toBe(14) // unchanged from the baseline
      })
    })

    describe('staff-aware availability', () => {
      it.each([undefined, 'base' as const])(
        'floors an advisory five-minute duration to a canonical sixty-minute service (windowSemantics=%s)',
        async windowSemantics => {
          primeStaffAwareAvailability()

          const result = await getSlots(
            { duration: 5, productId: 'product-1', productIds: ['product-1'], windowSemantics },
            staffAwareConfig(),
          )

          expect(result).toHaveLength(14)
          expect(result[0].endsAt.getTime() - result[0].startsAt.getTime()).toBe(60 * 60_000)
        },
      )

      it('sums canonical multi-service duration before applying the advisory floor', async () => {
        primeStaffAwareAvailability({
          products: [
            { id: 'product-1', duration: 30, durationMinutes: null },
            { id: 'product-2', duration: 45, durationMinutes: null },
          ],
        })

        const result = await getSlots({ duration: 5, productId: 'product-1', productIds: ['product-1', 'product-2'] }, staffAwareConfig())

        expect(result[0].endsAt.getTime() - result[0].startsAt.getTime()).toBe(75 * 60_000)
      })

      it('rejects a canonical duration above 1440 minutes', async () => {
        primeStaffAwareAvailability({ products: [{ id: 'product-1', duration: 1441, durationMinutes: null }] })

        await expect(getSlots({ productId: 'product-1', productIds: ['product-1'] }, staffAwareConfig())).rejects.toMatchObject({
          statusCode: 400,
        })
      })

      it.each([30, 120])(
        'uses fixedDurationMin=%i without catalog recanonicalization when the stored duration differs in either direction',
        async fixedDurationMin => {
          primeStaffAwareAvailability()
          const result = await getSlots({ productId: 'product-1', productIds: ['product-1'], fixedDurationMin }, staffAwareConfig())
          expect(result[0].endsAt.getTime() - result[0].startsAt.getTime()).toBe(fixedDurationMin * 60_000)
          expect(prismaMock.product.findMany).not.toHaveBeenCalled()
        },
      )

      it('validates the internal fixedDurationMin 1..1440 range', async () => {
        primeStaffAwareAvailability()
        await expect(
          getSlots({ productId: 'product-1', productIds: ['product-1'], fixedDurationMin: 1441 }, staffAwareConfig()),
        ).rejects.toMatchObject({ statusCode: 400 })
      })

      it('returns FULL only when pacing is the sole failed gate and includeFull is opted in', async () => {
        const appointment = createMockReservation({
          assignedStaffId: null,
          productId: 'product-1',
          product: { type: 'APPOINTMENTS_SERVICE' },
          tableId: null,
        })
        primeStaffAwareAvailability({ existingReservations: [appointment] })

        const result = await getSlots({ productId: 'product-1', productIds: ['product-1'], includeFull: true }, staffAwareConfig(1))

        expect(result.find(slot => slot.startsAt.getUTCHours() === 12)).toMatchObject({ available: false, reason: 'FULL' })
        expect(result.find(slot => slot.startsAt.getUTCHours() === 11)).not.toHaveProperty('available')
      })

      it('omits a pacing-full slot without includeFull', async () => {
        const appointment = createMockReservation({
          assignedStaffId: null,
          productId: 'product-1',
          product: { type: 'APPOINTMENTS_SERVICE' },
          tableId: null,
        })
        primeStaffAwareAvailability({ existingReservations: [appointment] })

        const result = await getSlots({ productId: 'product-1', productIds: ['product-1'] }, staffAwareConfig(1))

        expect(result.find(slot => slot.startsAt.getUTCHours() === 12)).toBeUndefined()
      })

      it('omits rather than mislabels FULL when the requested staff also has a hard conflict', async () => {
        const conflict = {
          assignedStaffId: 'staff-a',
          startsAt: at(12),
          endsAt: at(13),
        }
        primeStaffAwareAvailability({
          existingReservations: [
            createMockReservation({
              assignedStaffId: 'staff-a',
              productId: 'product-1',
              product: { type: 'APPOINTMENTS_SERVICE' },
              tableId: null,
            }),
          ],
          staffConflicts: [conflict],
        })

        const result = await getSlots(
          { productId: 'product-1', productIds: ['product-1'], staffId: 'staff-a', includeFull: true },
          staffAwareConfig(1),
        )

        expect(result.find(slot => slot.startsAt.getUTCHours() === 12)).toBeUndefined()
      })

      it('omits rather than mislabels FULL when a requested table does not exist', async () => {
        primeStaffAwareAvailability({
          existingReservations: [
            createMockReservation({
              assignedStaffId: null,
              productId: 'product-1',
              product: { type: 'APPOINTMENTS_SERVICE' },
              tableId: null,
            }),
          ],
        })

        const result = await getSlots(
          { productId: 'product-1', productIds: ['product-1'], tableId: 'missing-table', includeFull: true },
          staffAwareConfig(1),
        )

        expect(result.find(slot => slot.startsAt.getUTCHours() === 12)).toBeUndefined()
      })

      it('treats null staff-aware pacing as unlimited', async () => {
        primeStaffAwareAvailability({
          existingReservations: [
            createMockReservation({
              assignedStaffId: null,
              productId: 'product-1',
              product: { type: 'APPOINTMENTS_SERVICE' },
              tableId: null,
            }),
          ],
        })

        const result = await getSlots({ productId: 'product-1', productIds: ['product-1'] }, staffAwareConfig(null))

        expect(result.find(slot => slot.startsAt.getUTCHours() === 12)).toBeDefined()
      })

      it('does not let table or event reservations consume appointment pacing', async () => {
        primeStaffAwareAvailability({
          existingReservations: [
            createMockReservation({ productId: null, product: null, tableId: 'table-1' }),
            createMockReservation({ id: 'event', productId: 'event-1', product: { type: 'EVENT' }, tableId: null }),
          ],
        })

        const result = await getSlots({ productId: 'product-1', productIds: ['product-1'] }, staffAwareConfig(1))

        expect(result.find(slot => slot.startsAt.getUTCHours() === 12)).toBeDefined()
      })

      it('counts staggered appointment overlaps conservatively rather than using peak concurrency', async () => {
        primeStaffAwareAvailability({
          existingReservations: [
            createMockReservation({
              id: 'early',
              startsAt: at(11, 30),
              endsAt: at(12, 15),
              productId: 'product-1',
              product: { type: 'APPOINTMENTS_SERVICE' },
              tableId: null,
            }),
            createMockReservation({
              id: 'late',
              startsAt: at(12, 45),
              endsAt: at(13, 30),
              productId: 'product-1',
              product: { type: 'APPOINTMENTS_SERVICE' },
              tableId: null,
            }),
          ],
        })

        const result = await getSlots({ productId: 'product-1', productIds: ['product-1'], includeFull: true }, staffAwareConfig(2))

        expect(result.find(slot => slot.startsAt.getUTCHours() === 12)).toMatchObject({ available: false, reason: 'FULL' })
      })

      it('keeps an automatic slot when another eligible candidate remains free', async () => {
        const candidates = [
          {
            id: 'sv-a',
            staffId: 'staff-a',
            startDate: new Date('2024-01-01T00:00:00.000Z'),
            venue: { organizationId: 'org-1', timezone: 'UTC' },
            staff: { id: 'staff-a', firstName: 'Ana', lastName: 'Alfa' },
          },
          {
            id: 'sv-b',
            staffId: 'staff-b',
            startDate: new Date('2024-01-01T00:00:00.000Z'),
            venue: { organizationId: 'org-1', timezone: 'UTC' },
            staff: { id: 'staff-b', firstName: 'Beto', lastName: 'Bravo' },
          },
        ]
        primeStaffAwareAvailability({
          candidates,
          staffConflicts: [{ assignedStaffId: 'staff-a', startsAt: at(12), endsAt: at(13) }],
        })

        const result = await getSlots({ productId: 'product-1', productIds: ['product-1'] }, staffAwareConfig())

        expect(result.find(slot => slot.startsAt.getUTCHours() === 12)?.availableStaff).toEqual([
          { id: 'staff-b', firstName: 'Beto', lastName: 'Bravo' },
        ])
      })
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
