import { prismaMock } from '@tests/__helpers__/setup'
import {
  getClassSession,
  createClassSession,
  updateClassSession,
  cancelClassSession,
  addAttendee,
  removeAttendee,
} from '@/services/dashboard/classSession.dashboard.service'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'

// ---- Constants ----

const VENUE_ID = 'venue-001'
const SESSION_ID = 'sess-001'
const PRODUCT_ID = 'prod-001'
const STAFF_ID = 'staff-001'
const RESERVATION_ID = 'res-001'

// ---- Helpers ----

const makeReservation = (overrides: Record<string, any> = {}) => ({
  id: RESERVATION_ID,
  venueId: VENUE_ID,
  classSessionId: SESSION_ID,
  confirmationCode: 'RES-ABC123',
  status: 'CONFIRMED',
  partySize: 2,
  guestName: 'Ana Lopez',
  guestPhone: '+525551234567',
  guestEmail: null,
  specialRequests: null,
  customer: null,
  ...overrides,
})

const makeSession = (overrides: Record<string, any> = {}) => ({
  id: SESSION_ID,
  venueId: VENUE_ID,
  productId: PRODUCT_ID,
  capacity: 10,
  status: 'SCHEDULED',
  startsAt: new Date('2026-03-01T10:00:00Z'),
  endsAt: new Date('2026-03-01T11:00:00Z'),
  duration: 60,
  assignedStaffId: null,
  internalNotes: null,
  createdById: STAFF_ID,
  createdAt: new Date('2026-02-24T00:00:00Z'),
  updatedAt: new Date('2026-02-24T00:00:00Z'),
  product: { id: PRODUCT_ID, name: 'Yoga Class', price: 200, duration: 60, maxParticipants: 10 },
  assignedStaff: null,
  createdBy: { id: STAFF_ID, firstName: 'Admin', lastName: 'User' },
  reservations: [
    {
      id: 'res-a',
      partySize: 2,
      status: 'CONFIRMED',
      confirmationCode: 'RES-AAA001',
      guestName: 'Maria',
      guestPhone: null,
      guestEmail: null,
      specialRequests: null,
      customer: null,
    },
    {
      id: 'res-b',
      partySize: 3,
      status: 'CONFIRMED',
      confirmationCode: 'RES-BBB002',
      guestName: 'Carlos',
      guestPhone: null,
      guestEmail: null,
      specialRequests: null,
      customer: null,
    },
  ],
  ...overrides,
})

// ============================================================
// getClassSession
// ============================================================

describe('ClassSession Dashboard Service', () => {
  describe('getClassSession', () => {
    it('should return session with enrolled and available computed fields', async () => {
      const session = makeSession()
      prismaMock.classSession.findFirst.mockResolvedValue(session)

      const result = await getClassSession(VENUE_ID, SESSION_ID)

      expect(prismaMock.classSession.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SESSION_ID, venueId: VENUE_ID } }),
      )
      // enrolled = 2 + 3 = 5
      expect(result.enrolled).toBe(5)
      // available = 10 - 5 = 5
      expect(result.available).toBe(5)
      expect(result.id).toBe(SESSION_ID)
    })

    it('should return enrolled=0 and available=capacity when no active reservations', async () => {
      const session = makeSession({ reservations: [] })
      prismaMock.classSession.findFirst.mockResolvedValue(session)

      const result = await getClassSession(VENUE_ID, SESSION_ID)

      expect(result.enrolled).toBe(0)
      expect(result.available).toBe(10)
    })

    it('should throw NotFoundError when session not found', async () => {
      prismaMock.classSession.findFirst.mockResolvedValue(null)

      await expect(getClassSession(VENUE_ID, SESSION_ID)).rejects.toThrow(NotFoundError)
      await expect(getClassSession(VENUE_ID, SESSION_ID)).rejects.toThrow('Sesión no encontrada')
    })
  })

  // ============================================================
  // createClassSession
  // ============================================================

  describe('createClassSession', () => {
    const createDto = {
      productId: PRODUCT_ID,
      startsAt: '2026-03-01T10:00:00Z',
      endsAt: '2026-03-01T11:00:00Z',
      capacity: 10,
      assignedStaffId: undefined,
      internalNotes: undefined,
    }

    it('should create session successfully when product is CLASS type', async () => {
      const product = { id: PRODUCT_ID, type: 'CLASS', maxParticipants: 20 }
      const createdSession = makeSession()

      prismaMock.product.findFirst.mockResolvedValue(product)
      prismaMock.classSession.create.mockResolvedValue(createdSession)

      const result = await createClassSession(VENUE_ID, createDto as any, STAFF_ID)

      expect(prismaMock.product.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: PRODUCT_ID, venueId: VENUE_ID } }))
      expect(prismaMock.classSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            venueId: VENUE_ID,
            productId: PRODUCT_ID,
            capacity: 10,
            createdById: STAFF_ID,
          }),
        }),
      )
      expect(result).toEqual(createdSession)
    })

    it('should calculate duration from startsAt and endsAt', async () => {
      const product = { id: PRODUCT_ID, type: 'CLASS', maxParticipants: 20 }
      prismaMock.product.findFirst.mockResolvedValue(product)
      prismaMock.classSession.create.mockResolvedValue(makeSession())

      await createClassSession(VENUE_ID, createDto as any, STAFF_ID)

      expect(prismaMock.classSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            duration: 60, // 60 minutes between 10:00 and 11:00
          }),
        }),
      )
    })

    it('should throw NotFoundError when product not found', async () => {
      prismaMock.product.findFirst.mockResolvedValue(null)

      await expect(createClassSession(VENUE_ID, createDto as any, STAFF_ID)).rejects.toThrow(NotFoundError)
      await expect(createClassSession(VENUE_ID, createDto as any, STAFF_ID)).rejects.toThrow('Producto no encontrado')
      expect(prismaMock.classSession.create).not.toHaveBeenCalled()
    })

    it('should throw BadRequestError when product type is not CLASS', async () => {
      const product = { id: PRODUCT_ID, type: 'SERVICE', maxParticipants: null }
      prismaMock.product.findFirst.mockResolvedValue(product)

      await expect(createClassSession(VENUE_ID, createDto as any, STAFF_ID)).rejects.toThrow(BadRequestError)
      await expect(createClassSession(VENUE_ID, createDto as any, STAFF_ID)).rejects.toThrow('El producto debe ser de tipo Clase')
      expect(prismaMock.classSession.create).not.toHaveBeenCalled()
    })
  })

  // ============================================================
  // updateClassSession
  // ============================================================

  describe('updateClassSession', () => {
    it('should update session fields successfully', async () => {
      const existingSession = makeSession()
      const updatedSession = makeSession({ capacity: 15 })

      prismaMock.classSession.findFirst.mockResolvedValue(existingSession)
      prismaMock.reservation.aggregate.mockResolvedValue({ _sum: { partySize: 5 } })
      prismaMock.classSession.update.mockResolvedValue(updatedSession)

      const result = await updateClassSession(VENUE_ID, SESSION_ID, { capacity: 15 } as any)

      expect(prismaMock.classSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SESSION_ID },
          data: expect.objectContaining({ capacity: 15 }),
        }),
      )
      expect(result).toEqual(updatedSession)
    })

    it('should update startsAt, endsAt and recalculate duration', async () => {
      const existingSession = makeSession()
      prismaMock.classSession.findFirst.mockResolvedValue(existingSession)
      prismaMock.classSession.update.mockResolvedValue(makeSession())

      await updateClassSession(VENUE_ID, SESSION_ID, {
        startsAt: '2026-03-01T09:00:00Z',
        endsAt: '2026-03-01T10:30:00Z',
      } as any)

      expect(prismaMock.classSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startsAt: new Date('2026-03-01T09:00:00Z'),
            endsAt: new Date('2026-03-01T10:30:00Z'),
            duration: 90,
          }),
        }),
      )
    })

    it('should throw NotFoundError when session not found', async () => {
      prismaMock.classSession.findFirst.mockResolvedValue(null)

      await expect(updateClassSession(VENUE_ID, SESSION_ID, { capacity: 15 } as any)).rejects.toThrow(NotFoundError)
      await expect(updateClassSession(VENUE_ID, SESSION_ID, { capacity: 15 } as any)).rejects.toThrow('Sesión no encontrada')
    })

    it('should throw BadRequestError when session is CANCELLED', async () => {
      prismaMock.classSession.findFirst.mockResolvedValue(makeSession({ status: 'CANCELLED' }))

      await expect(updateClassSession(VENUE_ID, SESSION_ID, { capacity: 15 } as any)).rejects.toThrow(BadRequestError)
      await expect(updateClassSession(VENUE_ID, SESSION_ID, { capacity: 15 } as any)).rejects.toThrow(
        'No se puede modificar una sesión cancelada',
      )
      expect(prismaMock.classSession.update).not.toHaveBeenCalled()
    })

    it('should throw BadRequestError when reducing capacity below current enrollment', async () => {
      prismaMock.classSession.findFirst.mockResolvedValue(makeSession({ capacity: 10 }))
      // 8 people currently enrolled
      prismaMock.reservation.aggregate.mockResolvedValue({ _sum: { partySize: 8 } })

      // Trying to reduce to 5 which is below 8 enrolled
      await expect(updateClassSession(VENUE_ID, SESSION_ID, { capacity: 5 } as any)).rejects.toThrow(BadRequestError)
      await expect(updateClassSession(VENUE_ID, SESSION_ID, { capacity: 5 } as any)).rejects.toThrow('No se puede reducir la capacidad a 5')
    })

    it('should allow reducing capacity down to exact enrollment count', async () => {
      prismaMock.classSession.findFirst.mockResolvedValue(makeSession({ capacity: 10 }))
      // 5 people enrolled
      prismaMock.reservation.aggregate.mockResolvedValue({ _sum: { partySize: 5 } })
      prismaMock.classSession.update.mockResolvedValue(makeSession({ capacity: 5 }))

      // Reducing to exactly 5 (equal to enrolled) should succeed
      const result = await updateClassSession(VENUE_ID, SESSION_ID, { capacity: 5 } as any)
      expect(result).toBeDefined()
      expect(prismaMock.classSession.update).toHaveBeenCalled()
    })
  })

  // ============================================================
  // cancelClassSession
  // ============================================================

  describe('cancelClassSession', () => {
    it('should cancel session and its active reservations in a transaction', async () => {
      const session = makeSession()
      const cancelledSession = makeSession({ status: 'CANCELLED' })

      prismaMock.classSession.findFirst.mockResolvedValue(session)
      prismaMock.reservation.updateMany.mockResolvedValue({ count: 2 })
      prismaMock.classSession.update.mockResolvedValue(cancelledSession)

      const result = await cancelClassSession(VENUE_ID, SESSION_ID)

      expect(prismaMock.$transaction).toHaveBeenCalled()
      expect(prismaMock.reservation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            classSessionId: SESSION_ID,
            status: { in: ['PENDING', 'CONFIRMED'] },
          }),
          data: expect.objectContaining({
            status: 'CANCELLED',
            cancelledBy: 'SYSTEM',
            cancellationReason: 'Sesión cancelada por el establecimiento',
          }),
        }),
      )
      expect(prismaMock.classSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SESSION_ID },
          data: expect.objectContaining({ status: 'CANCELLED' }),
        }),
      )
      expect(result.status).toBe('CANCELLED')
    })

    it('should throw NotFoundError when session not found', async () => {
      prismaMock.classSession.findFirst.mockResolvedValue(null)

      await expect(cancelClassSession(VENUE_ID, SESSION_ID)).rejects.toThrow(NotFoundError)
      await expect(cancelClassSession(VENUE_ID, SESSION_ID)).rejects.toThrow('Sesión no encontrada')
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
    })

    it('should throw ConflictError when session is already CANCELLED', async () => {
      prismaMock.classSession.findFirst.mockResolvedValue(makeSession({ status: 'CANCELLED' }))

      await expect(cancelClassSession(VENUE_ID, SESSION_ID)).rejects.toThrow(ConflictError)
      await expect(cancelClassSession(VENUE_ID, SESSION_ID)).rejects.toThrow('La sesión ya está cancelada')
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
    })
  })

  // ============================================================
  // addAttendee
  // ============================================================

  describe('addAttendee', () => {
    const addAttendeeDto = {
      guestName: 'Ana Lopez',
      guestPhone: '+525551234567',
      guestEmail: null,
      partySize: 2,
      specialRequests: null,
      customerId: null,
    }

    it('should create a CONFIRMED reservation linked to the session', async () => {
      const session = makeSession({ capacity: 10, reservations: [{ partySize: 3 }] })
      const createdReservation = makeReservation({ status: 'CONFIRMED', classSessionId: SESSION_ID })

      prismaMock.classSession.findFirst.mockResolvedValue(session)
      prismaMock.reservation.create.mockResolvedValue(createdReservation)

      const result = await addAttendee(VENUE_ID, SESSION_ID, addAttendeeDto as any, STAFF_ID)

      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            venueId: VENUE_ID,
            classSessionId: SESSION_ID,
            productId: session.productId,
            status: 'CONFIRMED',
            channel: 'DASHBOARD',
            guestName: 'Ana Lopez',
            partySize: 2,
            createdById: STAFF_ID,
          }),
        }),
      )
      expect(result.status).toBe('CONFIRMED')
      expect(result.classSessionId).toBe(SESSION_ID)
    })

    it('should default partySize to 1 when not specified', async () => {
      const session = makeSession({ capacity: 10, reservations: [] })
      prismaMock.classSession.findFirst.mockResolvedValue(session)
      prismaMock.reservation.create.mockResolvedValue(makeReservation({ partySize: 1 }))

      await addAttendee(VENUE_ID, SESSION_ID, { guestName: 'Test' } as any, STAFF_ID)

      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ partySize: 1 }),
        }),
      )
    })

    it('should throw NotFoundError when session not found', async () => {
      prismaMock.classSession.findFirst.mockResolvedValue(null)

      await expect(addAttendee(VENUE_ID, SESSION_ID, addAttendeeDto as any, STAFF_ID)).rejects.toThrow(NotFoundError)
      await expect(addAttendee(VENUE_ID, SESSION_ID, addAttendeeDto as any, STAFF_ID)).rejects.toThrow('Sesión no encontrada')
      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    })

    it('should throw BadRequestError when session is not SCHEDULED', async () => {
      prismaMock.classSession.findFirst.mockResolvedValue(makeSession({ status: 'CANCELLED' }))

      await expect(addAttendee(VENUE_ID, SESSION_ID, addAttendeeDto as any, STAFF_ID)).rejects.toThrow(BadRequestError)
      await expect(addAttendee(VENUE_ID, SESSION_ID, addAttendeeDto as any, STAFF_ID)).rejects.toThrow(
        'Solo se pueden añadir asistentes a sesiones programadas',
      )
      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    })

    it('should throw BadRequestError when session status is COMPLETED', async () => {
      prismaMock.classSession.findFirst.mockResolvedValue(makeSession({ status: 'COMPLETED' }))

      await expect(addAttendee(VENUE_ID, SESSION_ID, addAttendeeDto as any, STAFF_ID)).rejects.toThrow(BadRequestError)
    })

    it('should throw ConflictError when no capacity available', async () => {
      // capacity=10, 9 already enrolled, partySize=2 → would exceed by 1
      const session = makeSession({
        capacity: 10,
        reservations: [{ partySize: 9 }],
      })
      prismaMock.classSession.findFirst.mockResolvedValue(session)

      await expect(addAttendee(VENUE_ID, SESSION_ID, { ...addAttendeeDto, partySize: 2 } as any, STAFF_ID)).rejects.toThrow(ConflictError)
      await expect(addAttendee(VENUE_ID, SESSION_ID, { ...addAttendeeDto, partySize: 2 } as any, STAFF_ID)).rejects.toThrow(
        'Sin capacidad suficiente',
      )
      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    })

    it('should throw ConflictError when session is exactly full', async () => {
      // capacity=5, all 5 spots taken
      const session = makeSession({
        capacity: 5,
        reservations: [{ partySize: 5 }],
      })
      prismaMock.classSession.findFirst.mockResolvedValue(session)

      await expect(addAttendee(VENUE_ID, SESSION_ID, { ...addAttendeeDto, partySize: 1 } as any, STAFF_ID)).rejects.toThrow(ConflictError)
    })
  })

  // ============================================================
  // removeAttendee
  // ============================================================

  describe('removeAttendee', () => {
    it('should cancel reservation by setting status to CANCELLED', async () => {
      const reservation = makeReservation({ status: 'CONFIRMED' })
      const cancelledReservation = makeReservation({ status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'STAFF' })

      prismaMock.reservation.findFirst.mockResolvedValue(reservation)
      prismaMock.reservation.update.mockResolvedValue(cancelledReservation)

      const result = await removeAttendee(VENUE_ID, SESSION_ID, RESERVATION_ID)

      expect(prismaMock.reservation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: RESERVATION_ID, venueId: VENUE_ID, classSessionId: SESSION_ID },
        }),
      )
      expect(prismaMock.reservation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: RESERVATION_ID },
          data: expect.objectContaining({
            status: 'CANCELLED',
            cancelledBy: 'STAFF',
          }),
        }),
      )
      expect(result.status).toBe('CANCELLED')
    })

    it('should cancel a PENDING reservation', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(makeReservation({ status: 'PENDING' }))
      prismaMock.reservation.update.mockResolvedValue(makeReservation({ status: 'CANCELLED' }))

      const result = await removeAttendee(VENUE_ID, SESSION_ID, RESERVATION_ID)

      expect(prismaMock.reservation.update).toHaveBeenCalled()
      expect(result.status).toBe('CANCELLED')
    })

    it('should throw NotFoundError when reservation not found', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(null)

      await expect(removeAttendee(VENUE_ID, SESSION_ID, RESERVATION_ID)).rejects.toThrow(NotFoundError)
      await expect(removeAttendee(VENUE_ID, SESSION_ID, RESERVATION_ID)).rejects.toThrow('Asistente no encontrado en esta sesión')
      expect(prismaMock.reservation.update).not.toHaveBeenCalled()
    })

    it('should throw BadRequestError when reservation is already CANCELLED', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(makeReservation({ status: 'CANCELLED' }))

      await expect(removeAttendee(VENUE_ID, SESSION_ID, RESERVATION_ID)).rejects.toThrow(BadRequestError)
      await expect(removeAttendee(VENUE_ID, SESSION_ID, RESERVATION_ID)).rejects.toThrow('Esta reservación ya no puede ser cancelada')
      expect(prismaMock.reservation.update).not.toHaveBeenCalled()
    })

    it('should throw BadRequestError when reservation is COMPLETED', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(makeReservation({ status: 'COMPLETED' }))

      await expect(removeAttendee(VENUE_ID, SESSION_ID, RESERVATION_ID)).rejects.toThrow(BadRequestError)
      await expect(removeAttendee(VENUE_ID, SESSION_ID, RESERVATION_ID)).rejects.toThrow('Esta reservación ya no puede ser cancelada')
    })

    it('should throw BadRequestError when reservation is NO_SHOW', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(makeReservation({ status: 'NO_SHOW' }))

      await expect(removeAttendee(VENUE_ID, SESSION_ID, RESERVATION_ID)).rejects.toThrow(BadRequestError)
      await expect(removeAttendee(VENUE_ID, SESSION_ID, RESERVATION_ID)).rejects.toThrow('Esta reservación ya no puede ser cancelada')
    })
  })
})
