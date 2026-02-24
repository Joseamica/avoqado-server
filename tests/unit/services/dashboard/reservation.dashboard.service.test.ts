import {
  createReservation,
  getReservations,
  getReservationById,
  getReservationByCancelSecret,
  getReservationStats,
  confirmReservation,
  checkInReservation,
  completeReservation,
  markNoShow,
  cancelReservation,
  updateReservation,
  rescheduleReservation,
  getReservationsCalendar,
} from '@/services/dashboard/reservation.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { Prisma } from '@prisma/client'

// ---- Helpers ----

const VENUE_ID = 'venue-123'
const STAFF_ID = 'staff-456'

const createMockReservation = (overrides: Record<string, any> = {}) => ({
  id: 'res-1',
  venueId: VENUE_ID,
  confirmationCode: 'RES-ABC123',
  cancelSecret: 'cancel-secret-uuid',
  status: 'CONFIRMED',
  channel: 'DASHBOARD',
  startsAt: new Date('2026-03-01T14:00:00Z'),
  endsAt: new Date('2026-03-01T15:00:00Z'),
  duration: 60,
  customerId: null,
  guestName: 'Juan Perez',
  guestPhone: '+525551234567',
  guestEmail: null,
  partySize: 2,
  tableId: 'table-1',
  productId: null,
  assignedStaffId: null,
  depositAmount: null,
  depositStatus: null,
  depositPaidAt: null,
  depositPaymentRef: null,
  createdById: STAFF_ID,
  confirmedAt: new Date('2026-03-01T10:00:00Z'),
  checkedInAt: null,
  completedAt: null,
  cancelledAt: null,
  noShowAt: null,
  cancelledBy: null,
  cancellationReason: null,
  specialRequests: null,
  internalNotes: null,
  tags: [],
  statusLog: [{ status: 'CONFIRMED', at: '2026-03-01T10:00:00.000Z', by: STAFF_ID }],
  createdAt: new Date('2026-03-01T10:00:00Z'),
  updatedAt: new Date('2026-03-01T10:00:00Z'),
  customer: null,
  table: { id: 'table-1', number: '5', capacity: 4 },
  product: null,
  assignedStaff: null,
  createdBy: { id: STAFF_ID, firstName: 'Admin', lastName: 'User' },
  ...overrides,
})

describe('Reservation Dashboard Service', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    prismaMock.$transaction.mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') return arg(prismaMock)
      return arg
    })
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.table.findFirst.mockResolvedValue({ id: 'table-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
    prismaMock.product.findFirst.mockResolvedValue({
      id: 'prod-1',
      price: new Prisma.Decimal(100),
      eventCapacity: 20,
    })
  })

  // ==========================================
  // CREATE RESERVATION
  // ==========================================

  describe('createReservation', () => {
    it('should create a reservation with auto-confirm (default)', async () => {
      const mockCreated = createMockReservation()

      // $transaction calls the callback with the tx client (which is prismaMock)
      prismaMock.$transaction.mockImplementation(async (fn: any) => {
        if (typeof fn === 'function') return fn(prismaMock)
        // Array transaction (for getReservations)
        return fn
      })
      prismaMock.$queryRaw.mockResolvedValue([]) // No conflicts
      prismaMock.reservation.findUnique.mockResolvedValue(null) // Code is unique
      prismaMock.reservation.create.mockResolvedValue(mockCreated)

      const result = await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
          guestName: 'Juan Perez',
          guestPhone: '+525551234567',
          partySize: 2,
          tableId: 'table-1',
        },
        STAFF_ID,
        { scheduling: { autoConfirm: true } },
      )

      expect(result).toBeDefined()
      expect(result.confirmationCode).toBe('RES-ABC123')
      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            venueId: VENUE_ID,
            status: 'CONFIRMED',
            partySize: 2,
            tableId: 'table-1',
          }),
        }),
      )
    })

    it('should create a PENDING reservation when autoConfirm is false', async () => {
      const mockCreated = createMockReservation({ status: 'PENDING', confirmedAt: null })

      prismaMock.$transaction.mockImplementation(async (fn: any) => {
        if (typeof fn === 'function') return fn(prismaMock)
        return fn
      })
      prismaMock.$queryRaw.mockResolvedValue([])
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockResolvedValue(mockCreated)

      const result = await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
          guestName: 'Maria Lopez',
        },
        STAFF_ID,
        { scheduling: { autoConfirm: false } },
      )

      expect(result.status).toBe('PENDING')
      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PENDING',
            confirmedAt: null,
          }),
        }),
      )
    })

    it('should throw ConflictError when table has a conflict', async () => {
      prismaMock.$transaction.mockImplementation(async (fn: any) => {
        if (typeof fn === 'function') return fn(prismaMock)
        return fn
      })
      // Table conflict found
      prismaMock.$queryRaw.mockResolvedValueOnce([{ id: 'existing-res' }])

      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt: new Date('2026-03-01T15:00:00Z'),
            duration: 60,
            tableId: 'table-1',
          },
          STAFF_ID,
        ),
      ).rejects.toThrow(ConflictError)
    })

    it('should throw ConflictError when staff has a conflict', async () => {
      prismaMock.$transaction.mockImplementation(async (fn: any) => {
        if (typeof fn === 'function') return fn(prismaMock)
        return fn
      })
      // No table conflict (no tableId), but staff conflict
      prismaMock.$queryRaw.mockResolvedValueOnce([{ id: 'existing-res' }])

      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt: new Date('2026-03-01T15:00:00Z'),
            duration: 60,
            assignedStaffId: 'staff-1',
          },
          STAFF_ID,
        ),
      ).rejects.toThrow(ConflictError)
    })

    it('should throw ConflictError when product capacity is full', async () => {
      prismaMock.product.findFirst.mockResolvedValueOnce({
        id: 'prod-1',
        price: new Prisma.Decimal(100),
        eventCapacity: 2,
      })
      prismaMock.$queryRaw.mockResolvedValueOnce([{ partySize: 2 }]) // Already full

      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt: new Date('2026-03-01T15:00:00Z'),
            duration: 60,
            productId: 'prod-1',
          },
          STAFF_ID,
          { scheduling: { onlineCapacityPercent: 100 } },
        ),
      ).rejects.toThrow(ConflictError)
    })

    it('should calculate deposit when config requires it', async () => {
      const mockCreated = createMockReservation({
        depositAmount: new Prisma.Decimal(200),
        depositStatus: 'PENDING',
      })

      prismaMock.$transaction.mockImplementation(async (fn: any) => {
        if (typeof fn === 'function') return fn(prismaMock)
        return fn
      })
      prismaMock.$queryRaw.mockResolvedValue([])
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockResolvedValue(mockCreated)

      await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
          partySize: 6,
        },
        STAFF_ID,
        {
          deposits: {
            enabled: true,
            mode: 'deposit',
            fixedAmount: 200,
            percentageOfTotal: null,
            requiredForPartySizeGte: 5,
          },
        },
      )

      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            depositAmount: new Prisma.Decimal(200),
            depositStatus: 'PENDING',
          }),
        }),
      )
    })

    it('should not require deposit when party size is below threshold', async () => {
      const mockCreated = createMockReservation({ depositAmount: null, depositStatus: null })

      prismaMock.$transaction.mockImplementation(async (fn: any) => {
        if (typeof fn === 'function') return fn(prismaMock)
        return fn
      })
      prismaMock.$queryRaw.mockResolvedValue([])
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockResolvedValue(mockCreated)

      await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
          partySize: 2,
        },
        STAFF_ID,
        {
          deposits: {
            enabled: true,
            mode: 'deposit',
            fixedAmount: 200,
            percentageOfTotal: null,
            requiredForPartySizeGte: 5,
          },
        },
      )

      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            depositAmount: null,
            depositStatus: null,
          }),
        }),
      )
    })

    it('should retry on P2034 serialization conflict', async () => {
      let attempt = 0
      prismaMock.$transaction.mockImplementation(async (fn: any) => {
        attempt++
        if (attempt === 1) {
          const error: any = new Error('Serialization conflict')
          error.code = 'P2034'
          throw error
        }
        if (typeof fn === 'function') return fn(prismaMock)
        return fn
      })
      prismaMock.$queryRaw.mockResolvedValue([])
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockResolvedValue(createMockReservation())

      const result = await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
        },
        STAFF_ID,
      )

      expect(result).toBeDefined()
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    })
  })

  // ==========================================
  // LIST / GET
  // ==========================================

  describe('getReservations', () => {
    it('should return paginated results', async () => {
      const mockData = [createMockReservation()]

      prismaMock.$transaction.mockResolvedValue([mockData, 1])

      const result = await getReservations(VENUE_ID, {}, 1, 50)

      expect(result.data).toHaveLength(1)
      expect(result.meta).toEqual({
        total: 1,
        page: 1,
        pageSize: 50,
        totalPages: 1,
      })
    })

    it('should filter by status array', async () => {
      prismaMock.$transaction.mockResolvedValue([[], 0])

      await getReservations(VENUE_ID, { status: ['PENDING', 'CONFIRMED'] as any })

      // The findMany call should include status filter
      expect(prismaMock.reservation.findMany).toHaveBeenCalled()
    })

    it('should support search across guest name, phone, and confirmation code', async () => {
      prismaMock.$transaction.mockResolvedValue([[], 0])

      await getReservations(VENUE_ID, { search: 'Juan' })

      expect(prismaMock.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([expect.objectContaining({ guestName: { contains: 'Juan', mode: 'insensitive' } })]),
          }),
        }),
      )
    })
  })

  describe('getReservationById', () => {
    it('should return reservation when found', async () => {
      const mockRes = createMockReservation()
      prismaMock.reservation.findFirst.mockResolvedValue(mockRes)

      const result = await getReservationById(VENUE_ID, 'res-1')

      expect(result.id).toBe('res-1')
      expect(prismaMock.reservation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'res-1', venueId: VENUE_ID },
        }),
      )
    })

    it('should throw NotFoundError when reservation does not exist', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(null)

      await expect(getReservationById(VENUE_ID, 'nonexistent')).rejects.toThrow(NotFoundError)
    })
  })

  describe('getReservationByCancelSecret', () => {
    it('should find reservation by cancel secret (public route)', async () => {
      const mockRes = createMockReservation()
      prismaMock.reservation.findFirst.mockResolvedValue(mockRes)

      const result = await getReservationByCancelSecret('venue-slug', 'cancel-secret-uuid')

      expect(result).toBeDefined()
      expect(prismaMock.reservation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { cancelSecret: 'cancel-secret-uuid', venue: { slug: 'venue-slug' } },
        }),
      )
    })

    it('should throw NotFoundError for invalid cancel secret', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(null)

      await expect(getReservationByCancelSecret('venue-slug', 'bad-secret')).rejects.toThrow(NotFoundError)
    })
  })

  // ==========================================
  // STATE TRANSITIONS
  // ==========================================

  describe('State Transitions', () => {
    describe('confirmReservation', () => {
      it('should transition PENDING -> CONFIRMED', async () => {
        const mockPending = createMockReservation({ status: 'PENDING' })
        const mockConfirmed = createMockReservation({ status: 'CONFIRMED' })

        prismaMock.reservation.findFirst.mockResolvedValue(mockPending)
        prismaMock.reservation.update.mockResolvedValue(mockConfirmed)

        const result = await confirmReservation(VENUE_ID, 'res-1', STAFF_ID)

        expect(result.status).toBe('CONFIRMED')
        expect(prismaMock.reservation.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: 'CONFIRMED',
              confirmedAt: expect.any(Date),
            }),
          }),
        )
      })

      it('should reject CHECKED_IN -> CONFIRMED (invalid)', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'CHECKED_IN' }))

        await expect(confirmReservation(VENUE_ID, 'res-1', STAFF_ID)).rejects.toThrow(BadRequestError)
      })
    })

    describe('checkInReservation', () => {
      it('should transition CONFIRMED -> CHECKED_IN', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'CONFIRMED' }))
        prismaMock.reservation.update.mockResolvedValue(createMockReservation({ status: 'CHECKED_IN' }))

        const result = await checkInReservation(VENUE_ID, 'res-1', STAFF_ID)

        expect(result.status).toBe('CHECKED_IN')
        expect(prismaMock.reservation.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: 'CHECKED_IN',
              checkedInAt: expect.any(Date),
            }),
          }),
        )
      })

      it('should reject PENDING -> CHECKED_IN (invalid)', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'PENDING' }))

        await expect(checkInReservation(VENUE_ID, 'res-1', STAFF_ID)).rejects.toThrow(BadRequestError)
      })
    })

    describe('completeReservation', () => {
      it('should transition CHECKED_IN -> COMPLETED', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'CHECKED_IN' }))
        prismaMock.reservation.update.mockResolvedValue(createMockReservation({ status: 'COMPLETED' }))

        const result = await completeReservation(VENUE_ID, 'res-1')

        expect(result.status).toBe('COMPLETED')
        expect(prismaMock.reservation.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: 'COMPLETED',
              completedAt: expect.any(Date),
            }),
          }),
        )
      })

      it('should reject CONFIRMED -> COMPLETED (must check in first)', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'CONFIRMED' }))

        await expect(completeReservation(VENUE_ID, 'res-1')).rejects.toThrow(BadRequestError)
      })
    })

    describe('markNoShow', () => {
      it('should transition CONFIRMED -> NO_SHOW', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'CONFIRMED' }))
        prismaMock.reservation.update.mockResolvedValue(createMockReservation({ status: 'NO_SHOW' }))

        const result = await markNoShow(VENUE_ID, 'res-1', STAFF_ID)

        expect(result.status).toBe('NO_SHOW')
        expect(prismaMock.reservation.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: 'NO_SHOW',
              noShowAt: expect.any(Date),
            }),
          }),
        )
      })

      it('should reject PENDING -> NO_SHOW (must be confirmed first)', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'PENDING' }))

        await expect(markNoShow(VENUE_ID, 'res-1', STAFF_ID)).rejects.toThrow(BadRequestError)
      })
    })

    describe('cancelReservation', () => {
      it('should transition PENDING -> CANCELLED with reason', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'PENDING' }))
        prismaMock.reservation.update.mockResolvedValue(
          createMockReservation({
            status: 'CANCELLED',
            cancelledBy: 'CUSTOMER',
            cancellationReason: 'Changed plans',
          }),
        )

        const result = await cancelReservation(VENUE_ID, 'res-1', 'CUSTOMER', 'Changed plans')

        expect(result.status).toBe('CANCELLED')
        expect(prismaMock.reservation.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: 'CANCELLED',
              cancelledAt: expect.any(Date),
              cancelledBy: 'CUSTOMER',
              cancellationReason: 'Changed plans',
            }),
          }),
        )
      })

      it('should transition CONFIRMED -> CANCELLED', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'CONFIRMED' }))
        prismaMock.reservation.update.mockResolvedValue(createMockReservation({ status: 'CANCELLED' }))

        const result = await cancelReservation(VENUE_ID, 'res-1', STAFF_ID)
        expect(result.status).toBe('CANCELLED')
      })

      it('should reject COMPLETED -> CANCELLED (terminal state)', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'COMPLETED' }))

        await expect(cancelReservation(VENUE_ID, 'res-1', STAFF_ID)).rejects.toThrow(BadRequestError)
      })

      it('should reject NO_SHOW -> CANCELLED (terminal state)', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'NO_SHOW' }))

        await expect(cancelReservation(VENUE_ID, 'res-1', STAFF_ID)).rejects.toThrow(BadRequestError)
      })

      it('should reject CANCELLED -> CANCELLED (already cancelled)', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'CANCELLED' }))

        await expect(cancelReservation(VENUE_ID, 'res-1', STAFF_ID)).rejects.toThrow(BadRequestError)
      })
    })

    describe('transition - reservation not found', () => {
      it('should throw NotFoundError when reservation does not exist', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(null)

        await expect(confirmReservation(VENUE_ID, 'nonexistent', STAFF_ID)).rejects.toThrow(NotFoundError)
        await expect(checkInReservation(VENUE_ID, 'nonexistent', STAFF_ID)).rejects.toThrow(NotFoundError)
        await expect(completeReservation(VENUE_ID, 'nonexistent')).rejects.toThrow(NotFoundError)
        await expect(markNoShow(VENUE_ID, 'nonexistent', STAFF_ID)).rejects.toThrow(NotFoundError)
        await expect(cancelReservation(VENUE_ID, 'nonexistent', STAFF_ID)).rejects.toThrow(NotFoundError)
      })
    })
  })

  // ==========================================
  // UPDATE
  // ==========================================

  describe('updateReservation', () => {
    it('should update allowed fields on CONFIRMED reservation', async () => {
      const existing = createMockReservation({ status: 'CONFIRMED' })
      const updated = createMockReservation({ status: 'CONFIRMED', guestName: 'Updated Name', partySize: 4 })

      prismaMock.reservation.findFirst.mockResolvedValueOnce(existing)
      prismaMock.reservation.update.mockResolvedValue(updated)

      const result = await updateReservation(VENUE_ID, 'res-1', { guestName: 'Updated Name', partySize: 4 }, STAFF_ID)

      expect(result.guestName).toBe('Updated Name')
      expect(result.partySize).toBe(4)
    })

    it('should reject updates on CHECKED_IN reservation', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'CHECKED_IN' }))

      await expect(updateReservation(VENUE_ID, 'res-1', { guestName: 'New' }, STAFF_ID)).rejects.toThrow(BadRequestError)
    })

    it('should reject updates on COMPLETED reservation', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'COMPLETED' }))

      await expect(updateReservation(VENUE_ID, 'res-1', { guestName: 'New' }, STAFF_ID)).rejects.toThrow(BadRequestError)
    })

    it('should reject updates on CANCELLED reservation', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'CANCELLED' }))

      await expect(updateReservation(VENUE_ID, 'res-1', { guestName: 'New' }, STAFF_ID)).rejects.toThrow(BadRequestError)
    })

    it('should check table conflicts when changing table', async () => {
      const existing = createMockReservation({ status: 'CONFIRMED', tableId: 'table-1' })

      prismaMock.reservation.findFirst.mockResolvedValueOnce(existing)
      prismaMock.$queryRaw.mockResolvedValueOnce([{ id: 'other-res', confirmationCode: 'RES-OTHER' }])

      await expect(updateReservation(VENUE_ID, 'res-1', { tableId: 'table-2' }, STAFF_ID)).rejects.toThrow(ConflictError)
    })

    it('should check staff conflicts when changing staff', async () => {
      const existing = createMockReservation({ status: 'CONFIRMED', assignedStaffId: null })

      prismaMock.reservation.findFirst.mockResolvedValueOnce(existing)
      prismaMock.$queryRaw
        .mockResolvedValueOnce([]) // table conflict check
        .mockResolvedValueOnce([{ id: 'other-res', confirmationCode: 'RES-OTHER' }]) // staff conflict check

      await expect(updateReservation(VENUE_ID, 'res-1', { assignedStaffId: 'staff-2' }, STAFF_ID)).rejects.toThrow(ConflictError)
    })

    it('should throw NotFoundError for nonexistent reservation', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(null)

      await expect(updateReservation(VENUE_ID, 'nonexistent', { guestName: 'New' }, STAFF_ID)).rejects.toThrow(NotFoundError)
    })
  })

  // ==========================================
  // RESCHEDULE
  // ==========================================

  describe('rescheduleReservation', () => {
    it('should update startsAt, endsAt, and recalculate duration', async () => {
      const existing = createMockReservation({ status: 'CONFIRMED' })
      const rescheduled = createMockReservation({
        startsAt: new Date('2026-03-02T16:00:00Z'),
        endsAt: new Date('2026-03-02T17:30:00Z'),
        duration: 90,
      })

      prismaMock.reservation.findFirst.mockResolvedValueOnce(existing)
      prismaMock.$queryRaw.mockResolvedValueOnce([]) // table conflict check
      prismaMock.reservation.update.mockResolvedValue(rescheduled)

      await rescheduleReservation(VENUE_ID, 'res-1', new Date('2026-03-02T16:00:00Z'), new Date('2026-03-02T17:30:00Z'), STAFF_ID)

      expect(prismaMock.reservation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startsAt: new Date('2026-03-02T16:00:00Z'),
            endsAt: new Date('2026-03-02T17:30:00Z'),
            duration: 90,
          }),
        }),
      )
    })
  })

  // ==========================================
  // STATS
  // ==========================================

  describe('getReservationStats', () => {
    it('should return aggregated stats', async () => {
      prismaMock.$transaction.mockResolvedValue([
        25, // total
        [
          { status: 'CONFIRMED', _count: { _all: 15 } },
          { status: 'CANCELLED', _count: { _all: 5 } },
          { status: 'NO_SHOW', _count: { _all: 5 } },
        ],
        [
          { channel: 'DASHBOARD', _count: { _all: 10 } },
          { channel: 'WEB', _count: { _all: 15 } },
        ],
      ])

      const result = await getReservationStats(VENUE_ID, new Date('2026-03-01'), new Date('2026-03-31'))

      expect(result.total).toBe(25)
      expect(result.byStatus['CONFIRMED']).toBe(15)
      expect(result.byStatus['NO_SHOW']).toBe(5)
      expect(result.byChannel['WEB']).toBe(15)
      expect(result.noShowRate).toBe(20) // 5/25 * 100
    })

    it('should handle zero reservations gracefully', async () => {
      prismaMock.$transaction.mockResolvedValue([0, [], []])

      const result = await getReservationStats(VENUE_ID, new Date('2026-03-01'), new Date('2026-03-31'))

      expect(result.total).toBe(0)
      expect(result.noShowRate).toBe(0)
    })
  })

  // ==========================================
  // CALENDAR VIEW
  // ==========================================

  describe('getReservationsCalendar', () => {
    it('should return flat list when no groupBy', async () => {
      const mockReservations = [createMockReservation({ id: 'res-1' }), createMockReservation({ id: 'res-2' })]

      prismaMock.reservation.findMany.mockResolvedValue(mockReservations)

      const result = await getReservationsCalendar(VENUE_ID, new Date('2026-03-01'), new Date('2026-03-02'))

      expect(result.reservations).toHaveLength(2)
      expect(result).not.toHaveProperty('grouped')
    })

    it('should group by table when specified', async () => {
      const mockReservations = [
        createMockReservation({ id: 'res-1', tableId: 'table-1' }),
        createMockReservation({ id: 'res-2', tableId: 'table-2' }),
        createMockReservation({ id: 'res-3', tableId: 'table-1' }),
      ]

      prismaMock.reservation.findMany.mockResolvedValue(mockReservations)

      const result = await getReservationsCalendar(VENUE_ID, new Date('2026-03-01'), new Date('2026-03-02'), 'table')

      expect(result.grouped!['table-1']).toHaveLength(2)
      expect(result.grouped!['table-2']).toHaveLength(1)
    })

    it('should group by staff when specified', async () => {
      const mockReservations = [
        createMockReservation({ id: 'res-1', assignedStaffId: 'staff-1' }),
        createMockReservation({ id: 'res-2', assignedStaffId: null }),
      ]

      prismaMock.reservation.findMany.mockResolvedValue(mockReservations)

      const result = await getReservationsCalendar(VENUE_ID, new Date('2026-03-01'), new Date('2026-03-02'), 'staff')

      expect(result.grouped!['staff-1']).toHaveLength(1)
      expect(result.grouped!['unassigned']).toHaveLength(1)
    })
  })

  // ==========================================
  // TIME INVARIANT VALIDATION (Bug 7)
  // ==========================================

  describe('Time invariant validation', () => {
    it('should reject reservation where endsAt <= startsAt', async () => {
      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T15:00:00Z'),
            endsAt: new Date('2026-03-01T14:00:00Z'), // Before startsAt
            duration: 60,
          },
          STAFF_ID,
        ),
      ).rejects.toThrow(BadRequestError)
    })

    it('should reject reservation where endsAt equals startsAt', async () => {
      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt: new Date('2026-03-01T14:00:00Z'), // Same as startsAt
            duration: 0,
          },
          STAFF_ID,
        ),
      ).rejects.toThrow(BadRequestError)
    })
  })

  // ==========================================
  // REGRESSION TESTS — State machine completeness
  // ==========================================

  describe('Regression: all terminal states reject transitions', () => {
    const terminalStates = ['COMPLETED', 'CANCELLED', 'NO_SHOW'] as const

    for (const terminal of terminalStates) {
      it(`should reject all transitions from ${terminal}`, async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: terminal }))

        await expect(confirmReservation(VENUE_ID, 'res-1', STAFF_ID)).rejects.toThrow(BadRequestError)
        await expect(checkInReservation(VENUE_ID, 'res-1', STAFF_ID)).rejects.toThrow(BadRequestError)
        await expect(completeReservation(VENUE_ID, 'res-1')).rejects.toThrow(BadRequestError)
        await expect(markNoShow(VENUE_ID, 'res-1', STAFF_ID)).rejects.toThrow(BadRequestError)
        await expect(cancelReservation(VENUE_ID, 'res-1', STAFF_ID)).rejects.toThrow(BadRequestError)
      })
    }
  })
})
