import {
  addToWaitlist,
  getWaitlist,
  getWaitlistEntry,
  removeFromWaitlist,
  promoteWaitlistEntry,
  findMatchingWaitlistEntries,
  notifyWaitlistEntry,
  expireWaitlistEntry,
} from '@/services/dashboard/reservationWaitlist.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'

// ---- Helpers ----

const VENUE_ID = 'venue-123'

const createMockEntry = (overrides: Record<string, any> = {}) => ({
  id: 'entry-1',
  venueId: VENUE_ID,
  customerId: null,
  guestName: 'Carlos Ruiz',
  guestPhone: '+525559876543',
  partySize: 3,
  desiredStartAt: new Date('2026-03-01T19:00:00Z'),
  desiredEndAt: null,
  position: 1,
  status: 'WAITING',
  notes: null,
  notifiedAt: null,
  responseDeadline: null,
  promotedReservationId: null,
  createdAt: new Date('2026-03-01T18:00:00Z'),
  updatedAt: new Date('2026-03-01T18:00:00Z'),
  customer: null,
  ...overrides,
})

describe('Reservation Waitlist Service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ==========================================
  // ADD TO WAITLIST
  // ==========================================

  describe('addToWaitlist', () => {
    it('should add entry with FIFO position (default)', async () => {
      prismaMock.reservationWaitlistEntry.count.mockResolvedValue(3) // 3 in queue
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue({ position: 3 }) // Max position
      prismaMock.reservationWaitlistEntry.create.mockResolvedValue(createMockEntry({ position: 4 }))

      const result = await addToWaitlist(VENUE_ID, {
        guestName: 'Carlos Ruiz',
        guestPhone: '+525559876543',
        partySize: 3,
        desiredStartAt: new Date('2026-03-01T19:00:00Z'),
      })

      expect(result.position).toBe(4)
      expect(prismaMock.reservationWaitlistEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            venueId: VENUE_ID,
            guestName: 'Carlos Ruiz',
            partySize: 3,
            position: 4,
          }),
        }),
      )
    })

    it('should assign position 1 when waitlist is empty (FIFO)', async () => {
      prismaMock.reservationWaitlistEntry.count.mockResolvedValue(0)
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(null) // No max position
      prismaMock.reservationWaitlistEntry.create.mockResolvedValue(createMockEntry({ position: 1 }))

      const result = await addToWaitlist(VENUE_ID, {
        guestName: 'First Guest',
        desiredStartAt: new Date('2026-03-01T19:00:00Z'),
      })

      expect(result.position).toBe(1)
    })

    it('should use party_size priority mode', async () => {
      prismaMock.reservationWaitlistEntry.count
        .mockResolvedValueOnce(5) // Total WAITING
        .mockResolvedValueOnce(2) // Same partySize=2 count

      prismaMock.reservationWaitlistEntry.create.mockResolvedValue(createMockEntry({ position: 203, partySize: 2 }))

      const result = await addToWaitlist(
        VENUE_ID,
        {
          guestName: 'Party of 2',
          partySize: 2,
          desiredStartAt: new Date('2026-03-01T19:00:00Z'),
        },
        { waitlist: { priorityMode: 'party_size' } },
      )

      // Position = partySize*100 + sameSize+1 = 200 + 2 + 1 = 203
      expect(result.position).toBe(203)
    })

    it('should assign position 0 in broadcast mode', async () => {
      prismaMock.reservationWaitlistEntry.count.mockResolvedValue(3)
      prismaMock.reservationWaitlistEntry.create.mockResolvedValue(createMockEntry({ position: 0 }))

      const result = await addToWaitlist(
        VENUE_ID,
        {
          guestName: 'Broadcast Guest',
          desiredStartAt: new Date('2026-03-01T19:00:00Z'),
        },
        { waitlist: { priorityMode: 'broadcast' } },
      )

      expect(result.position).toBe(0)
    })

    it('should throw ConflictError when waitlist is full', async () => {
      prismaMock.reservationWaitlistEntry.count.mockResolvedValue(50) // At max

      await expect(
        addToWaitlist(
          VENUE_ID,
          {
            guestName: 'Overflow Guest',
            desiredStartAt: new Date('2026-03-01T19:00:00Z'),
          },
          { waitlist: { maxSize: 50 } },
        ),
      ).rejects.toThrow(ConflictError)
    })

    it('should use custom maxSize from module config', async () => {
      prismaMock.reservationWaitlistEntry.count.mockResolvedValue(10)

      await expect(
        addToWaitlist(
          VENUE_ID,
          {
            guestName: 'Guest',
            desiredStartAt: new Date('2026-03-01T19:00:00Z'),
          },
          { waitlist: { maxSize: 10 } },
        ),
      ).rejects.toThrow(ConflictError)
    })

    it('should default partySize to 1 when not provided', async () => {
      prismaMock.reservationWaitlistEntry.count.mockResolvedValue(0)
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(null)
      prismaMock.reservationWaitlistEntry.create.mockResolvedValue(createMockEntry({ partySize: 1 }))

      await addToWaitlist(VENUE_ID, {
        guestName: 'Solo Guest',
        desiredStartAt: new Date('2026-03-01T19:00:00Z'),
      })

      expect(prismaMock.reservationWaitlistEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            partySize: 1,
          }),
        }),
      )
    })
  })

  // ==========================================
  // GET WAITLIST
  // ==========================================

  describe('getWaitlist', () => {
    it('should return WAITING and NOTIFIED entries by default', async () => {
      prismaMock.reservationWaitlistEntry.findMany.mockResolvedValue([createMockEntry()])

      await getWaitlist(VENUE_ID)

      expect(prismaMock.reservationWaitlistEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venueId: VENUE_ID,
            status: { in: ['WAITING', 'NOTIFIED'] },
          }),
          orderBy: { position: 'asc' },
        }),
      )
    })

    it('should filter by specific status when provided', async () => {
      prismaMock.reservationWaitlistEntry.findMany.mockResolvedValue([])

      await getWaitlist(VENUE_ID, 'PROMOTED' as any)

      expect(prismaMock.reservationWaitlistEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'PROMOTED',
          }),
        }),
      )
    })
  })

  // ==========================================
  // GET SINGLE ENTRY
  // ==========================================

  describe('getWaitlistEntry', () => {
    it('should return entry when found', async () => {
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(createMockEntry())

      const result = await getWaitlistEntry(VENUE_ID, 'entry-1')

      expect(result.id).toBe('entry-1')
    })

    it('should throw NotFoundError when entry does not exist', async () => {
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(null)

      await expect(getWaitlistEntry(VENUE_ID, 'nonexistent')).rejects.toThrow(NotFoundError)
    })
  })

  // ==========================================
  // REMOVE FROM WAITLIST
  // ==========================================

  describe('removeFromWaitlist', () => {
    it('should cancel a WAITING entry', async () => {
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(createMockEntry({ status: 'WAITING' }))
      prismaMock.reservationWaitlistEntry.update.mockResolvedValue(createMockEntry({ status: 'CANCELLED' }))

      const result = await removeFromWaitlist(VENUE_ID, 'entry-1')

      expect(prismaMock.reservationWaitlistEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'CANCELLED' },
        }),
      )
    })

    it('should cancel a NOTIFIED entry', async () => {
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(createMockEntry({ status: 'NOTIFIED' }))
      prismaMock.reservationWaitlistEntry.update.mockResolvedValue(createMockEntry({ status: 'CANCELLED' }))

      await removeFromWaitlist(VENUE_ID, 'entry-1')

      expect(prismaMock.reservationWaitlistEntry.update).toHaveBeenCalled()
    })

    it('should reject removal of PROMOTED entry', async () => {
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(createMockEntry({ status: 'PROMOTED' }))

      await expect(removeFromWaitlist(VENUE_ID, 'entry-1')).rejects.toThrow(BadRequestError)
    })

    it('should reject removal of EXPIRED entry', async () => {
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(createMockEntry({ status: 'EXPIRED' }))

      await expect(removeFromWaitlist(VENUE_ID, 'entry-1')).rejects.toThrow(BadRequestError)
    })

    it('should throw NotFoundError for nonexistent entry', async () => {
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(null)

      await expect(removeFromWaitlist(VENUE_ID, 'nonexistent')).rejects.toThrow(NotFoundError)
    })
  })

  // ==========================================
  // PROMOTE WAITLIST ENTRY
  // ==========================================

  describe('promoteWaitlistEntry', () => {
    it('should promote a WAITING entry to a reservation', async () => {
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(createMockEntry({ status: 'WAITING' }))
      prismaMock.reservation.findFirst.mockResolvedValue({ id: 'res-new' }) // Reservation exists in venue
      prismaMock.reservationWaitlistEntry.update.mockResolvedValue(
        createMockEntry({ status: 'PROMOTED', promotedReservationId: 'res-new' }),
      )

      const result = await promoteWaitlistEntry(VENUE_ID, 'entry-1', 'res-new')

      expect(prismaMock.reservationWaitlistEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: 'PROMOTED',
            promotedReservationId: 'res-new',
          },
        }),
      )
    })

    it('should promote a NOTIFIED entry', async () => {
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(createMockEntry({ status: 'NOTIFIED' }))
      prismaMock.reservation.findFirst.mockResolvedValue({ id: 'res-new' }) // Reservation exists in venue
      prismaMock.reservationWaitlistEntry.update.mockResolvedValue(createMockEntry({ status: 'PROMOTED' }))

      await promoteWaitlistEntry(VENUE_ID, 'entry-1', 'res-new')

      expect(prismaMock.reservationWaitlistEntry.update).toHaveBeenCalled()
    })

    it('should reject promoting a CANCELLED entry', async () => {
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(createMockEntry({ status: 'CANCELLED' }))

      await expect(promoteWaitlistEntry(VENUE_ID, 'entry-1', 'res-new')).rejects.toThrow(BadRequestError)
    })

    it('should throw NotFoundError for nonexistent entry', async () => {
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(null)

      await expect(promoteWaitlistEntry(VENUE_ID, 'nonexistent', 'res-new')).rejects.toThrow(NotFoundError)
    })

    it('should reject cross-venue reservation linking (Bug 5)', async () => {
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(createMockEntry({ status: 'WAITING' }))
      // Reservation not found in this venue
      prismaMock.reservation.findFirst.mockResolvedValue(null)

      await expect(promoteWaitlistEntry(VENUE_ID, 'entry-1', 'res-from-other-venue')).rejects.toThrow(NotFoundError)
    })

    it('should allow promotion with valid same-venue reservation', async () => {
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(createMockEntry({ status: 'WAITING' }))
      prismaMock.reservation.findFirst.mockResolvedValue({ id: 'res-valid' })
      prismaMock.reservationWaitlistEntry.update.mockResolvedValue(
        createMockEntry({ status: 'PROMOTED', promotedReservationId: 'res-valid' }),
      )

      const result = await promoteWaitlistEntry(VENUE_ID, 'entry-1', 'res-valid')

      expect(result.status).toBe('PROMOTED')
      expect(prismaMock.reservation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'res-valid', venueId: VENUE_ID },
        }),
      )
    })
  })

  // ==========================================
  // FIND MATCHING ENTRIES (auto-promote)
  // ==========================================

  describe('findMatchingWaitlistEntries', () => {
    it('should find entries matching party size and time window (fifo)', async () => {
      const entries = [createMockEntry({ partySize: 2, position: 1 }), createMockEntry({ id: 'entry-2', partySize: 3, position: 2 })]

      prismaMock.reservationWaitlistEntry.findMany.mockResolvedValue(entries)

      const result = await findMatchingWaitlistEntries(VENUE_ID, new Date('2026-03-01T19:00:00Z'), 4, 'fifo')

      expect(result).toHaveLength(2)
      expect(prismaMock.reservationWaitlistEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            partySize: { lte: 4 },
            status: 'WAITING',
          }),
          orderBy: { position: 'asc' },
          take: 5,
        }),
      )
    })

    it('should return all matching entries in broadcast mode (no take limit)', async () => {
      prismaMock.reservationWaitlistEntry.findMany.mockResolvedValue([])

      await findMatchingWaitlistEntries(VENUE_ID, new Date('2026-03-01T19:00:00Z'), 4, 'broadcast')

      expect(prismaMock.reservationWaitlistEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'asc' },
        }),
      )
      // No `take` limit in broadcast mode
      const callArgs = prismaMock.reservationWaitlistEntry.findMany.mock.calls[0][0]
      expect(callArgs.take).toBeUndefined()
    })

    it('should match within 2-hour time window', async () => {
      prismaMock.reservationWaitlistEntry.findMany.mockResolvedValue([])

      const slotTime = new Date('2026-03-01T19:00:00Z')
      await findMatchingWaitlistEntries(VENUE_ID, slotTime, 4, 'fifo')

      const callArgs = prismaMock.reservationWaitlistEntry.findMany.mock.calls[0][0]
      const desiredStartAt = callArgs.where.desiredStartAt

      // Should be 2 hours before and after
      expect(desiredStartAt.gte.getTime()).toBe(slotTime.getTime() - 2 * 60 * 60 * 1000)
      expect(desiredStartAt.lte.getTime()).toBe(slotTime.getTime() + 2 * 60 * 60 * 1000)
    })
  })

  // ==========================================
  // NOTIFY / EXPIRE
  // ==========================================

  describe('notifyWaitlistEntry', () => {
    it('should set status to NOTIFIED with response deadline', async () => {
      prismaMock.reservationWaitlistEntry.update.mockResolvedValue(
        createMockEntry({
          status: 'NOTIFIED',
          notifiedAt: new Date(),
          responseDeadline: new Date(Date.now() + 15 * 60 * 1000),
        }),
      )

      await notifyWaitlistEntry(VENUE_ID, 'entry-1', 15)

      expect(prismaMock.reservationWaitlistEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'NOTIFIED',
            notifiedAt: expect.any(Date),
            responseDeadline: expect.any(Date),
          }),
        }),
      )
    })
  })

  describe('expireWaitlistEntry', () => {
    it('should set status to EXPIRED', async () => {
      prismaMock.reservationWaitlistEntry.update.mockResolvedValue(createMockEntry({ status: 'EXPIRED' }))

      await expireWaitlistEntry('entry-1')

      expect(prismaMock.reservationWaitlistEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'entry-1' },
          data: { status: 'EXPIRED' },
        }),
      )
    })
  })

  // ==========================================
  // REGRESSION TESTS
  // ==========================================

  describe('Regression', () => {
    it('should scope all queries by venueId', async () => {
      prismaMock.reservationWaitlistEntry.findMany.mockResolvedValue([])
      prismaMock.reservationWaitlistEntry.findFirst.mockResolvedValue(null)

      await getWaitlist(VENUE_ID)

      expect(prismaMock.reservationWaitlistEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ venueId: VENUE_ID }),
        }),
      )
    })

    it('should include customer relation in list queries', async () => {
      prismaMock.reservationWaitlistEntry.findMany.mockResolvedValue([])

      await getWaitlist(VENUE_ID)

      expect(prismaMock.reservationWaitlistEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            customer: expect.any(Object),
          }),
        }),
      )
    })
  })
})
