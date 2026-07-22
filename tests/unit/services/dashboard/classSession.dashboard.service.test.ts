import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/communication/rabbitmq/gcal-push-consumer', () => ({
  __esModule: true,
  publishPushNotification: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/dashboard/appointmentStaffAssignment.service', () => ({
  ...jest.requireActual('@/services/dashboard/appointmentStaffAssignment.service'),
  assertOrganizationStaffAvailability: jest.fn(),
  lockAppointmentVenue: jest.fn(),
}))

import {
  getClassSession,
  createClassSession,
  createClassSessionsBulk,
  updateClassSession,
  cancelClassSession,
  addAttendee,
  removeAttendee,
} from '@/services/dashboard/classSession.dashboard.service'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { publishPushNotification } from '@/communication/rabbitmq/gcal-push-consumer'
import { assertOrganizationStaffAvailability, lockAppointmentVenue } from '@/services/dashboard/appointmentStaffAssignment.service'
import { logAction } from '@/services/dashboard/activity-log.service'

// ---- Constants ----

const VENUE_ID = 'venue-001'
const SESSION_ID = 'sess-001'
const PRODUCT_ID = 'prod-001'
const STAFF_ID = 'staff-001'
const RESERVATION_ID = 'res-001'
const ORGANIZATION_ID = 'org-001'

const availabilityMock = assertOrganizationStaffAvailability as jest.MockedFunction<typeof assertOrganizationStaffAvailability>
const lockAppointmentVenueMock = lockAppointmentVenue as jest.MockedFunction<typeof lockAppointmentVenue>
const publishMock = publishPushNotification as jest.MockedFunction<typeof publishPushNotification>
const logActionMock = logAction as jest.MockedFunction<typeof logAction>

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

const makeLockedSession = (overrides: Record<string, any> = {}) => ({
  id: SESSION_ID,
  startsAt: new Date('2026-03-01T10:00:00Z'),
  endsAt: new Date('2026-03-01T11:00:00Z'),
  duration: 60,
  capacity: 10,
  status: 'SCHEDULED',
  assignedStaffId: null,
  internalNotes: null,
  ...overrides,
})

// ============================================================
// getClassSession
// ============================================================

describe('ClassSession Dashboard Service', () => {
  beforeEach(() => {
    prismaMock.product.findFirst.mockReset()
    prismaMock.staffVenue.findFirst.mockReset()
    prismaMock.classSession.findFirst.mockReset()
    prismaMock.classSession.findMany.mockReset()
    prismaMock.classSession.create.mockReset()
    prismaMock.classSession.update.mockReset()
    prismaMock.reservation.aggregate.mockReset()
    prismaMock.$queryRaw.mockReset()
    prismaMock.reservationSettings.findUnique.mockReset()
    prismaMock.googleCalendarConnection.findFirst.mockReset()
    prismaMock.calendarSyncOutbox.create.mockReset()
    availabilityMock.mockReset().mockResolvedValue(undefined)
    lockAppointmentVenueMock.mockReset().mockResolvedValue(undefined)
    publishMock.mockReset().mockResolvedValue(undefined)
    logActionMock.mockReset()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.reservationSettings.findUnique.mockResolvedValue({
      googleCalendarPushEnabled: false,
      googleCalendarDualWrite: false,
    })
    prismaMock.googleCalendarConnection.findFirst.mockResolvedValue(null)
    prismaMock.calendarSyncOutbox.create.mockResolvedValue({ id: 'outbox-default' })
  })

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
    // Use a date 30 days in the future so the past-time guard doesn't trip the test
    // as wall-clock advances. Picks 10:00–11:00 UTC on day+30.
    const futureDay = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
    const createDto = {
      productId: PRODUCT_ID,
      startsAt: `${futureDay}T10:00:00Z`,
      endsAt: `${futureDay}T11:00:00Z`,
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

    it('retries atomically, re-reads active staff context, and emits post-commit effects once', async () => {
      const assignedDto = { ...createDto, assignedStaffId: STAFF_ID }
      const firstSession = makeSession({ id: 'session-attempt-1', assignedStaffId: STAFF_ID })
      const committedSession = makeSession({ id: 'session-attempt-2', assignedStaffId: STAFF_ID })

      prismaMock.product.findFirst.mockResolvedValue({ id: PRODUCT_ID, type: 'CLASS', maxParticipants: 20 })
      prismaMock.staffVenue.findFirst
        .mockResolvedValueOnce({ id: 'sv-1', venue: { organizationId: 'org-attempt-1' } })
        .mockResolvedValueOnce({ id: 'sv-2', venue: { organizationId: 'org-attempt-2' } })
      prismaMock.classSession.create.mockResolvedValueOnce(firstSession).mockResolvedValueOnce(committedSession)
      prismaMock.reservationSettings.findUnique.mockResolvedValue({
        googleCalendarPushEnabled: true,
        googleCalendarDualWrite: false,
      })
      prismaMock.googleCalendarConnection.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where.scope === 'STAFF_PERSONAL' ? { id: 'conn-staff' } : null),
      )
      prismaMock.calendarSyncOutbox.create.mockImplementation(({ data }: any) => Promise.resolve({ id: `outbox-${data.classSessionId}` }))

      let attempt = 0
      prismaMock.$transaction.mockImplementation(async (callback: any) => {
        attempt += 1
        const result = await callback(prismaMock)
        if (attempt === 1) throw { code: 'P2034' }
        return result
      })

      const result = await createClassSession(VENUE_ID, assignedDto as any, STAFF_ID)

      expect(result).toEqual(committedSession)
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
      expect(prismaMock.$transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
        isolationLevel: 'Serializable',
        timeout: 10_000,
      })
      expect(prismaMock.product.findFirst).toHaveBeenCalledTimes(2)
      expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledTimes(2)
      expect(prismaMock.staffVenue.findFirst).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { venueId: VENUE_ID, staffId: STAFF_ID, active: true, staff: { active: true } },
          select: expect.objectContaining({ venue: { select: { organizationId: true } } }),
        }),
      )
      expect(availabilityMock.mock.calls.map(([, args]) => args.organizationId)).toEqual(['org-attempt-1', 'org-attempt-2'])
      expect(prismaMock.calendarSyncOutbox.create).toHaveBeenCalledTimes(2)
      expect(publishMock).toHaveBeenCalledTimes(1)
      expect(publishMock).toHaveBeenCalledWith(['outbox-session-attempt-2'])
      expect(logActionMock).toHaveBeenCalledTimes(1)
      expect(lockAppointmentVenueMock).not.toHaveBeenCalled()
      expect(prismaMock.productStaff.findMany).not.toHaveBeenCalled()
      expect(prismaMock.staffSchedule.findFirst).not.toHaveBeenCalled()
      expect(prismaMock.staffScheduleException.findMany).not.toHaveBeenCalled()
    })

    it('rejects inactive local staff before availability or insertion', async () => {
      prismaMock.product.findFirst.mockResolvedValue({ id: PRODUCT_ID, type: 'CLASS', maxParticipants: 20 })
      prismaMock.staffVenue.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where.active === true && where.staff?.active === true ? null : { id: 'inactive-membership' }),
      )
      prismaMock.classSession.create.mockResolvedValue(makeSession())

      await expect(createClassSession(VENUE_ID, { ...createDto, assignedStaffId: STAFF_ID } as any, STAFF_ID)).rejects.toThrow(
        'El staff asignado no pertenece a este negocio',
      )

      expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: VENUE_ID, staffId: STAFF_ID, active: true, staff: { active: true } },
        }),
      )
      expect(availabilityMock).not.toHaveBeenCalled()
      expect(prismaMock.classSession.create).not.toHaveBeenCalled()
    })

    it('defensively rejects a non-positive interval before insertion', async () => {
      prismaMock.product.findFirst.mockResolvedValue({ id: PRODUCT_ID, type: 'CLASS', maxParticipants: 20 })
      prismaMock.classSession.create.mockResolvedValue(makeSession())

      await expect(createClassSession(VENUE_ID, { ...createDto, endsAt: `${futureDay}T09:00:00Z` } as any, STAFF_ID)).rejects.toThrow(
        'La hora de inicio debe ser anterior a la hora de fin',
      )

      expect(prismaMock.classSession.create).not.toHaveBeenCalled()
    })
  })

  // ============================================================
  // createClassSessionsBulk
  // ============================================================

  describe('createClassSessionsBulk', () => {
    const recurrenceDay = new Date(Date.now() + 60 * 86_400_000)
    const startDate = recurrenceDay.toISOString().slice(0, 10)
    const firstStartsAt = new Date(`${startDate}T10:00:00Z`)
    const secondStartsAt = new Date(firstStartsAt.getTime() + 7 * 86_400_000)
    const bulkDto = {
      productId: PRODUCT_ID,
      startDate,
      startTime: '10:00',
      endTime: '11:00',
      weekdays: [firstStartsAt.getUTCDay()],
      occurrences: 2,
      capacity: 10,
      assignedStaffId: STAFF_ID,
      internalNotes: null,
    }

    it('retries the whole batch, re-reads the skip set, and returns only committed rows', async () => {
      prismaMock.product.findFirst.mockResolvedValue({ id: PRODUCT_ID, type: 'CLASS' })
      prismaMock.staffVenue.findFirst
        .mockResolvedValueOnce({ id: 'sv-1', venue: { organizationId: 'org-attempt-1' } })
        .mockResolvedValueOnce({ id: 'sv-2', venue: { organizationId: 'org-attempt-2' } })
      prismaMock.classSession.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ startsAt: firstStartsAt }])

      let attempt = 0
      prismaMock.classSession.create.mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: `attempt-${attempt}-${data.startsAt.toISOString()}`,
          startsAt: data.startsAt,
          endsAt: data.endsAt,
        }),
      )
      prismaMock.$transaction.mockImplementation(async (callback: any) => {
        attempt += 1
        const result = await callback(prismaMock)
        if (attempt === 1) throw { code: 'P2034' }
        return result
      })

      const result = await createClassSessionsBulk(VENUE_ID, bulkDto as any, STAFF_ID, 'UTC')

      expect(result).toEqual({
        created: [
          {
            id: `attempt-2-${secondStartsAt.toISOString()}`,
            startsAt: secondStartsAt,
            endsAt: new Date(secondStartsAt.getTime() + 60 * 60_000),
          },
        ],
        count: 1,
        skipped: 1,
      })
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
      expect(prismaMock.$transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
        isolationLevel: 'Serializable',
        timeout: 10_000,
      })
      expect(prismaMock.product.findFirst).toHaveBeenCalledTimes(2)
      expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledTimes(2)
      expect(prismaMock.staffVenue.findFirst).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { venueId: VENUE_ID, staffId: STAFF_ID, active: true, staff: { active: true } },
        }),
      )
      expect(prismaMock.classSession.findMany).toHaveBeenCalledTimes(2)
      expect(availabilityMock.mock.calls.map(([, args]) => args.organizationId)).toEqual([
        'org-attempt-1',
        'org-attempt-1',
        'org-attempt-2',
      ])
      expect(availabilityMock).toHaveBeenLastCalledWith(
        prismaMock,
        expect.objectContaining({
          staffId: STAFF_ID,
          startsAt: secondStartsAt,
          endsAt: new Date(secondStartsAt.getTime() + 60 * 60_000),
          checkedAt: expect.any(Date),
        }),
      )
      expect(logActionMock).toHaveBeenCalledTimes(1)
      expect(logActionMock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ created: 1, skipped: 1 }) }))
      expect(lockAppointmentVenueMock).not.toHaveBeenCalled()
      expect(prismaMock.productStaff.findMany).not.toHaveBeenCalled()
      expect(prismaMock.staffSchedule.findFirst).not.toHaveBeenCalled()
      expect(prismaMock.staffScheduleException.findMany).not.toHaveBeenCalled()
    })

    it('validates every assigned interval before any insert or outbox work', async () => {
      prismaMock.product.findFirst.mockResolvedValue({ id: PRODUCT_ID, type: 'CLASS' })
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', venue: { organizationId: ORGANIZATION_ID } })
      prismaMock.classSession.findMany.mockResolvedValue([])
      availabilityMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ConflictError('staff busy'))
      prismaMock.reservationSettings.findUnique.mockResolvedValue({
        googleCalendarPushEnabled: true,
        googleCalendarDualWrite: false,
      })
      prismaMock.googleCalendarConnection.findFirst.mockResolvedValue({ id: 'conn-staff' })
      prismaMock.classSession.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'should-not-exist', startsAt: data.startsAt, endsAt: data.endsAt }),
      )

      await expect(createClassSessionsBulk(VENUE_ID, bulkDto as any, STAFF_ID, 'UTC')).rejects.toThrow('staff busy')

      expect(availabilityMock).toHaveBeenCalledTimes(2)
      expect(prismaMock.classSession.create).not.toHaveBeenCalled()
      expect(prismaMock.calendarSyncOutbox.create).not.toHaveBeenCalled()
      expect(publishMock).not.toHaveBeenCalled()
      expect(logActionMock).not.toHaveBeenCalled()
    })

    it('preserves missing-product error precedence over malformed recurrence input', async () => {
      prismaMock.product.findFirst.mockResolvedValue(null)

      await expect(createClassSessionsBulk(VENUE_ID, { ...bulkDto, startDate: 'not-a-date' } as any, STAFF_ID, 'UTC')).rejects.toThrow(
        'Producto no encontrado',
      )

      expect(prismaMock.product.findFirst).toHaveBeenCalledTimes(1)
      expect(prismaMock.classSession.findMany).not.toHaveBeenCalled()
    })

    it('preserves inactive-membership error precedence over malformed recurrence input', async () => {
      prismaMock.product.findFirst.mockResolvedValue({ id: PRODUCT_ID, type: 'CLASS' })
      prismaMock.staffVenue.findFirst.mockResolvedValue(null)

      await expect(createClassSessionsBulk(VENUE_ID, { ...bulkDto, startDate: 'not-a-date' } as any, STAFF_ID, 'UTC')).rejects.toThrow(
        'El staff asignado no pertenece a este negocio',
      )

      expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: VENUE_ID, staffId: STAFF_ID, active: true, staff: { active: true } },
        }),
      )
      expect(prismaMock.classSession.findMany).not.toHaveBeenCalled()
    })

    it('re-filters past candidates and reapplies the occurrence cap on retry', async () => {
      jest.useFakeTimers()
      const firstDate = '2030-01-07'
      const secondDate = '2030-01-08'
      const firstStart = new Date(`${firstDate}T10:00:00Z`)
      const secondStart = new Date(`${secondDate}T10:00:00Z`)
      jest.setSystemTime(new Date(`${firstDate}T09:59:30Z`))

      try {
        prismaMock.product.findFirst.mockResolvedValue({ id: PRODUCT_ID, type: 'CLASS' })
        prismaMock.classSession.findMany.mockResolvedValue([])
        let attempt = 0
        prismaMock.classSession.create.mockImplementation(({ data }: any) =>
          Promise.resolve({ id: `attempt-${attempt}`, startsAt: data.startsAt, endsAt: data.endsAt }),
        )
        prismaMock.$transaction.mockImplementation(async (callback: any) => {
          attempt += 1
          const result = await callback(prismaMock)
          if (attempt === 1) {
            jest.setSystemTime(new Date(`${firstDate}T10:01:30Z`))
            throw { code: 'P2034' }
          }
          return result
        })

        const promise = createClassSessionsBulk(
          VENUE_ID,
          {
            ...bulkDto,
            startDate: firstDate,
            weekdays: [firstStart.getUTCDay(), secondStart.getUTCDay()],
            occurrences: 1,
            assignedStaffId: null,
          } as any,
          STAFF_ID,
          'UTC',
        )
        const [result] = await Promise.all([promise, jest.runAllTimersAsync()])
        expect(result).toMatchObject({
          count: 1,
          skipped: 0,
          created: [{ id: 'attempt-2', startsAt: secondStart }],
        })

        expect(prismaMock.product.findFirst).toHaveBeenCalledTimes(2)
        expect(prismaMock.classSession.findMany).toHaveBeenCalledTimes(2)
        expect(prismaMock.classSession.findMany).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ where: expect.objectContaining({ startsAt: { gte: firstStart, lte: firstStart } }) }),
        )
        expect(prismaMock.classSession.findMany).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ where: expect.objectContaining({ startsAt: { gte: secondStart, lte: secondStart } }) }),
        )
        expect(prismaMock.classSession.create).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ data: expect.objectContaining({ startsAt: secondStart }) }),
        )
      } finally {
        jest.useRealTimers()
      }
    })
  })

  // ============================================================
  // updateClassSession
  // ============================================================

  describe('updateClassSession', () => {
    beforeEach(() => {
      prismaMock.$queryRaw.mockResolvedValue([makeLockedSession()])
    })

    it('should update session fields successfully', async () => {
      const updatedSession = makeSession({ capacity: 15 })

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
      prismaMock.$queryRaw.mockResolvedValue([])

      await expect(updateClassSession(VENUE_ID, SESSION_ID, { capacity: 15 } as any)).rejects.toThrow(NotFoundError)
      await expect(updateClassSession(VENUE_ID, SESSION_ID, { capacity: 15 } as any)).rejects.toThrow('Sesión no encontrada')
    })

    it('should throw BadRequestError when session is CANCELLED', async () => {
      prismaMock.$queryRaw.mockResolvedValue([makeLockedSession({ status: 'CANCELLED' })])

      await expect(updateClassSession(VENUE_ID, SESSION_ID, { capacity: 15 } as any)).rejects.toThrow(BadRequestError)
      await expect(updateClassSession(VENUE_ID, SESSION_ID, { capacity: 15 } as any)).rejects.toThrow(
        'No se puede modificar una sesión cancelada',
      )
      expect(prismaMock.classSession.update).not.toHaveBeenCalled()
    })

    it('should throw BadRequestError when reducing capacity below current enrollment', async () => {
      // 8 people currently enrolled
      prismaMock.reservation.aggregate.mockResolvedValue({ _sum: { partySize: 8 } })

      // Trying to reduce to 5 which is below 8 enrolled
      await expect(updateClassSession(VENUE_ID, SESSION_ID, { capacity: 5 } as any)).rejects.toThrow(BadRequestError)
      await expect(updateClassSession(VENUE_ID, SESSION_ID, { capacity: 5 } as any)).rejects.toThrow('No se puede reducir la capacidad a 5')
    })

    it('should allow reducing capacity down to exact enrollment count', async () => {
      // 5 people enrolled
      prismaMock.reservation.aggregate.mockResolvedValue({ _sum: { partySize: 5 } })
      prismaMock.classSession.update.mockResolvedValue(makeSession({ capacity: 5 }))

      // Reducing to exactly 5 (equal to enrolled) should succeed
      const result = await updateClassSession(VENUE_ID, SESSION_ID, { capacity: 5 } as any)
      expect(result).toBeDefined()
      expect(prismaMock.classSession.update).toHaveBeenCalled()
    })

    it('tenant-locks first and validates time-only changes for the existing active staff', async () => {
      const events: string[] = []
      const locked = makeLockedSession({ assignedStaffId: STAFF_ID })
      const updated = makeSession({
        startsAt: new Date('2026-03-01T10:30:00Z'),
        endsAt: locked.endsAt,
        duration: 30,
        assignedStaffId: STAFF_ID,
      })
      prismaMock.$queryRaw.mockImplementation(async () => {
        events.push('lock')
        return [locked]
      })
      prismaMock.staffVenue.findFirst.mockImplementation(async () => {
        events.push('membership')
        return { id: 'sv-1', venue: { organizationId: ORGANIZATION_ID } }
      })
      availabilityMock.mockImplementation(async () => {
        events.push('availability')
      })
      prismaMock.classSession.update.mockImplementation(async () => {
        events.push('update')
        return updated
      })

      await updateClassSession(VENUE_ID, SESSION_ID, { startsAt: '2026-03-01T10:30:00Z' } as any)

      expect(events.slice(0, 4)).toEqual(['lock', 'membership', 'availability', 'update'])
      const lockQuery = prismaMock.$queryRaw.mock.calls[0][0] as any
      expect(lockQuery.sql).toContain('FROM "ClassSession"')
      expect(lockQuery.sql).toContain('AND "venueId" = ?')
      expect(lockQuery.sql).toContain('FOR UPDATE')
      expect(lockQuery.values).toEqual([SESSION_ID, VENUE_ID])
      expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: VENUE_ID, staffId: STAFF_ID, active: true, staff: { active: true } },
        }),
      )
      expect(availabilityMock).toHaveBeenCalledWith(
        prismaMock,
        expect.objectContaining({
          organizationId: ORGANIZATION_ID,
          staffId: STAFF_ID,
          startsAt: new Date('2026-03-01T10:30:00Z'),
          endsAt: locked.endsAt,
          checkedAt: expect.any(Date),
          excludeClassSessionId: SESSION_ID,
        }),
      )
      expect(prismaMock.classSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ startsAt: new Date('2026-03-01T10:30:00Z'), duration: 30 }) }),
      )
      expect(lockAppointmentVenueMock).not.toHaveBeenCalled()
      expect(prismaMock.productStaff.findMany).not.toHaveBeenCalled()
      expect(prismaMock.staffSchedule.findFirst).not.toHaveBeenCalled()
      expect(prismaMock.staffScheduleException.findMany).not.toHaveBeenCalled()
    })

    it('derives an end-only duration from the freshly locked start', async () => {
      prismaMock.$queryRaw.mockResolvedValue([makeLockedSession({ startsAt: new Date('2026-03-01T09:30:00Z') })])
      prismaMock.classSession.update.mockResolvedValue(makeSession())

      await updateClassSession(VENUE_ID, SESSION_ID, { endsAt: '2026-03-01T12:00:00Z' } as any)

      expect(prismaMock.classSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ endsAt: new Date('2026-03-01T12:00:00Z'), duration: 150 }),
        }),
      )
    })

    it('re-reads the opposite endpoint after retry and emits outbox effects once', async () => {
      const lockedRows = [
        makeLockedSession({ endsAt: new Date('2026-03-01T12:00:00Z'), assignedStaffId: STAFF_ID }),
        makeLockedSession({ endsAt: new Date('2026-03-01T13:00:00Z'), assignedStaffId: STAFF_ID }),
      ]
      let attempt = 0
      prismaMock.$queryRaw.mockImplementation(async () => [lockedRows[attempt - 1]])
      prismaMock.staffVenue.findFirst
        .mockResolvedValueOnce({ id: 'sv-1', venue: { organizationId: 'org-attempt-1' } })
        .mockResolvedValueOnce({ id: 'sv-2', venue: { organizationId: 'org-attempt-2' } })
      prismaMock.classSession.update.mockImplementation(({ data }: any) =>
        Promise.resolve(
          makeSession({
            id: `updated-attempt-${attempt}`,
            startsAt: data.startsAt,
            endsAt: lockedRows[attempt - 1].endsAt,
            duration: data.duration,
            assignedStaffId: STAFF_ID,
          }),
        ),
      )
      prismaMock.reservationSettings.findUnique.mockResolvedValue({
        googleCalendarPushEnabled: true,
        googleCalendarDualWrite: false,
      })
      prismaMock.googleCalendarConnection.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where.scope === 'STAFF_PERSONAL' ? { id: 'conn-staff' } : null),
      )
      prismaMock.calendarSyncOutbox.create.mockImplementation(({ data }: any) => Promise.resolve({ id: `outbox-${data.classSessionId}` }))
      prismaMock.$transaction.mockImplementation(async (callback: any) => {
        attempt += 1
        const result = await callback(prismaMock)
        if (attempt === 1) throw { code: 'P2034' }
        return result
      })

      const result = await updateClassSession(VENUE_ID, SESSION_ID, { startsAt: '2026-03-01T11:30:00Z' } as any)

      expect(result.id).toBe('updated-attempt-2')
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2)
      expect(prismaMock.classSession.update).toHaveBeenCalledTimes(2)
      expect(prismaMock.classSession.update).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ data: expect.objectContaining({ duration: 30 }) }),
      )
      expect(prismaMock.classSession.update).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ data: expect.objectContaining({ duration: 90 }) }),
      )
      expect(availabilityMock.mock.calls.map(([, args]) => args.organizationId)).toEqual(['org-attempt-1', 'org-attempt-2'])
      expect(prismaMock.calendarSyncOutbox.create).toHaveBeenCalledTimes(2)
      expect(publishMock).toHaveBeenCalledTimes(1)
      expect(publishMock).toHaveBeenCalledWith(['outbox-updated-attempt-2'])
      expect(logActionMock).toHaveBeenCalledTimes(1)
    })

    it('rejects an interval inverted by a concurrent partial-end update after retry', async () => {
      const lockedRows = [
        makeLockedSession({ endsAt: new Date('2026-03-01T13:00:00Z') }),
        makeLockedSession({ endsAt: new Date('2026-03-01T11:00:00Z') }),
      ]
      let attempt = 0
      prismaMock.$queryRaw.mockImplementation(async () => [lockedRows[attempt - 1]])
      prismaMock.classSession.update.mockResolvedValue(makeSession())
      prismaMock.$transaction.mockImplementation(async (callback: any) => {
        attempt += 1
        const result = await callback(prismaMock)
        if (attempt === 1) throw { code: 'P2034' }
        return result
      })

      await expect(updateClassSession(VENUE_ID, SESSION_ID, { startsAt: '2026-03-01T12:00:00Z' } as any)).rejects.toThrow(
        'La hora de inicio debe ser anterior a la hora de fin',
      )

      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2)
      expect(prismaMock.classSession.update).toHaveBeenCalledTimes(1)
      expect(publishMock).not.toHaveBeenCalled()
      expect(logActionMock).not.toHaveBeenCalled()
    })

    it.each([
      ['not-found', null, 'Sesión no encontrada'],
      ['cancelled', makeLockedSession({ status: 'CANCELLED' }), 'No se puede modificar una sesión cancelada'],
    ])('re-runs %s validation against the second locked state', async (_label, secondState, expectedMessage) => {
      let attempt = 0
      prismaMock.$queryRaw.mockImplementation(async () => (attempt === 1 ? [makeLockedSession()] : secondState ? [secondState] : []))
      prismaMock.classSession.update.mockResolvedValue(makeSession({ internalNotes: 'first attempt' }))
      prismaMock.$transaction.mockImplementation(async (callback: any) => {
        attempt += 1
        const result = await callback(prismaMock)
        if (attempt === 1) throw { code: 'P2034' }
        return result
      })

      await expect(updateClassSession(VENUE_ID, SESSION_ID, { internalNotes: 'retry me' } as any)).rejects.toThrow(expectedMessage)

      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2)
      expect(prismaMock.classSession.update).toHaveBeenCalledTimes(1)
      expect(logActionMock).not.toHaveBeenCalled()
    })

    it('re-counts enrollment on retry before reducing capacity', async () => {
      let attempt = 0
      prismaMock.$queryRaw.mockResolvedValue([makeLockedSession()])
      prismaMock.reservation.aggregate.mockResolvedValueOnce({ _sum: { partySize: 5 } }).mockResolvedValueOnce({ _sum: { partySize: 8 } })
      prismaMock.classSession.update.mockResolvedValue(makeSession({ capacity: 6 }))
      prismaMock.$transaction.mockImplementation(async (callback: any) => {
        attempt += 1
        const result = await callback(prismaMock)
        if (attempt === 1) throw { code: 'P2034' }
        return result
      })

      await expect(updateClassSession(VENUE_ID, SESSION_ID, { capacity: 6 } as any)).rejects.toThrow('No se puede reducir la capacidad a 6')

      expect(prismaMock.reservation.aggregate).toHaveBeenCalledTimes(2)
      expect(prismaMock.classSession.update).toHaveBeenCalledTimes(1)
      expect(logActionMock).not.toHaveBeenCalled()
    })

    it('re-validates existing-staff membership on a time-change retry', async () => {
      let attempt = 0
      prismaMock.$queryRaw.mockResolvedValue([makeLockedSession({ assignedStaffId: STAFF_ID })])
      prismaMock.staffVenue.findFirst
        .mockResolvedValueOnce({ id: 'sv-1', venue: { organizationId: ORGANIZATION_ID } })
        .mockResolvedValueOnce(null)
      prismaMock.classSession.update.mockResolvedValue(makeSession({ assignedStaffId: STAFF_ID }))
      prismaMock.$transaction.mockImplementation(async (callback: any) => {
        attempt += 1
        const result = await callback(prismaMock)
        if (attempt === 1) throw { code: 'P2034' }
        return result
      })

      await expect(updateClassSession(VENUE_ID, SESSION_ID, { endsAt: '2026-03-01T12:00:00Z' } as any)).rejects.toThrow(
        'El staff asignado no pertenece a este negocio',
      )

      expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledTimes(2)
      expect(availabilityMock).toHaveBeenCalledTimes(1)
      expect(prismaMock.classSession.update).toHaveBeenCalledTimes(1)
    })

    it('validates a newly assigned staff member and excludes the session from conflicts', async () => {
      prismaMock.$queryRaw.mockResolvedValue([makeLockedSession({ assignedStaffId: null })])
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', venue: { organizationId: ORGANIZATION_ID } })
      prismaMock.classSession.update.mockResolvedValue(makeSession({ assignedStaffId: STAFF_ID }))

      await updateClassSession(VENUE_ID, SESSION_ID, { assignedStaffId: STAFF_ID } as any)

      expect(availabilityMock).toHaveBeenCalledWith(
        prismaMock,
        expect.objectContaining({
          organizationId: ORGANIZATION_ID,
          staffId: STAFF_ID,
          startsAt: new Date('2026-03-01T10:00:00Z'),
          endsAt: new Date('2026-03-01T11:00:00Z'),
          excludeClassSessionId: SESSION_ID,
        }),
      )
      expect(prismaMock.classSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ assignedStaffId: STAFF_ID }) }),
      )
    })

    it('skips personal conflict validation for metadata-only updates', async () => {
      prismaMock.$queryRaw.mockResolvedValue([makeLockedSession({ assignedStaffId: STAFF_ID })])
      availabilityMock.mockRejectedValue(new ConflictError('legacy conflict'))
      prismaMock.classSession.update.mockResolvedValue(makeSession({ assignedStaffId: STAFF_ID, internalNotes: 'updated' }))

      const result = await updateClassSession(VENUE_ID, SESSION_ID, { internalNotes: 'updated' } as any)

      expect(result.internalNotes).toBe('updated')
      expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
      expect(availabilityMock).not.toHaveBeenCalled()
    })

    it('clears staff without running membership or personal conflict validation', async () => {
      prismaMock.$queryRaw.mockResolvedValue([makeLockedSession({ assignedStaffId: STAFF_ID })])
      availabilityMock.mockRejectedValue(new ConflictError('legacy conflict'))
      prismaMock.classSession.update.mockResolvedValue(makeSession({ assignedStaffId: null }))

      const result = await updateClassSession(VENUE_ID, SESSION_ID, { assignedStaffId: null } as any)

      expect(result.assignedStaffId).toBeNull()
      expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
      expect(availabilityMock).not.toHaveBeenCalled()
      expect(prismaMock.classSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ assignedStaffId: null }) }),
      )
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

    const sessionRow = {
      id: SESSION_ID,
      productId: PRODUCT_ID,
      startsAt: new Date('2026-03-01T10:00:00Z'),
      endsAt: new Date('2026-03-01T11:00:00Z'),
      duration: 60,
      capacity: 10,
      status: 'SCHEDULED',
    }

    beforeEach(() => {
      jest.clearAllMocks()
      // Re-setup $transaction mock after clearAllMocks
      prismaMock.$transaction = jest.fn((callback: any) => callback(prismaMock))
    })

    // Helper: mock the raw SQL queries used inside the serializable transaction
    function mockSessionAndEnrolled(sessionRowData: Record<string, any> | null, enrolled: number) {
      prismaMock.$queryRaw
        .mockResolvedValueOnce(sessionRowData ? [sessionRowData] : []) // ClassSession FOR UPDATE
        .mockResolvedValueOnce([{ total: BigInt(enrolled) }]) // Enrolled count FOR UPDATE
    }

    it('should create a CONFIRMED reservation linked to the session', async () => {
      const createdReservation = makeReservation({ status: 'CONFIRMED', classSessionId: SESSION_ID })

      mockSessionAndEnrolled(sessionRow, 3)
      prismaMock.reservation.create.mockResolvedValue(createdReservation)

      const result = await addAttendee(VENUE_ID, SESSION_ID, addAttendeeDto as any, STAFF_ID)

      expect(prismaMock.$transaction).toHaveBeenCalled()
      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            venueId: VENUE_ID,
            classSessionId: SESSION_ID,
            productId: PRODUCT_ID,
            status: 'CONFIRMED',
            channel: 'DASHBOARD',
            guestName: 'Ana Lopez',
            partySize: 2,
            createdById: STAFF_ID,
          }),
        }),
      )
      // addAttendee now returns { reservation, orderId } so the controller can
      // surface a TPV deep-link on walk-in flows. orderId stays null here
      // because checkInImmediately defaults to false in this test path.
      expect(result.orderId).toBeNull()
      expect(result.reservation.status).toBe('CONFIRMED')
      expect(result.reservation.classSessionId).toBe(SESSION_ID)
    })

    it('should default partySize to 1 when not specified', async () => {
      mockSessionAndEnrolled(sessionRow, 0)
      prismaMock.reservation.create.mockResolvedValue(makeReservation({ partySize: 1 }))

      await addAttendee(VENUE_ID, SESSION_ID, { guestName: 'Test' } as any, STAFF_ID)

      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ partySize: 1 }),
        }),
      )
    })

    it('should throw NotFoundError when session not found', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]) // Always return empty for this test

      await expect(addAttendee(VENUE_ID, SESSION_ID, addAttendeeDto as any, STAFF_ID)).rejects.toThrow(NotFoundError)
      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    })

    it('should throw NotFoundError with correct message', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]) // Always return empty

      await expect(addAttendee(VENUE_ID, SESSION_ID, addAttendeeDto as any, STAFF_ID)).rejects.toThrow('Sesión no encontrada')
    })

    it('should throw BadRequestError when session is not SCHEDULED', async () => {
      prismaMock.$queryRaw.mockResolvedValue([{ ...sessionRow, status: 'CANCELLED' }])

      await expect(addAttendee(VENUE_ID, SESSION_ID, addAttendeeDto as any, STAFF_ID)).rejects.toThrow(BadRequestError)
    })

    it('should throw BadRequestError when session is CANCELLED with correct message', async () => {
      prismaMock.$queryRaw.mockResolvedValue([{ ...sessionRow, status: 'CANCELLED' }])

      await expect(addAttendee(VENUE_ID, SESSION_ID, addAttendeeDto as any, STAFF_ID)).rejects.toThrow(
        'Solo se pueden añadir asistentes a sesiones programadas',
      )
      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    })

    it('should throw BadRequestError when session status is COMPLETED', async () => {
      prismaMock.$queryRaw.mockResolvedValue([{ ...sessionRow, status: 'COMPLETED' }])

      await expect(addAttendee(VENUE_ID, SESSION_ID, addAttendeeDto as any, STAFF_ID)).rejects.toThrow(BadRequestError)
    })

    it('should throw ConflictError when no capacity available', async () => {
      // capacity=10, 9 already enrolled, partySize=2 → would exceed by 1
      mockSessionAndEnrolled(sessionRow, 9)

      await expect(addAttendee(VENUE_ID, SESSION_ID, { ...addAttendeeDto, partySize: 2 } as any, STAFF_ID)).rejects.toThrow(ConflictError)
    })

    it('should throw ConflictError with correct message', async () => {
      mockSessionAndEnrolled(sessionRow, 9)

      await expect(addAttendee(VENUE_ID, SESSION_ID, { ...addAttendeeDto, partySize: 2 } as any, STAFF_ID)).rejects.toThrow(
        'Sin capacidad suficiente',
      )
      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    })

    it('should throw ConflictError when session is exactly full', async () => {
      // capacity=10 (from sessionRow), all 10 spots taken
      mockSessionAndEnrolled(sessionRow, 10)

      await expect(addAttendee(VENUE_ID, SESSION_ID, { ...addAttendeeDto, partySize: 1 } as any, STAFF_ID)).rejects.toThrow(ConflictError)
    })

    // ====================================================
    // checkInImmediately (walk-in flow): reservation enters
    // CHECKED_IN and an Order is auto-built in the same TX
    // ====================================================

    // Mocks the second leg of the same TX: createOrderFromReservation()
    // querying its own data. The helper does:
    //   1. tx.order.findFirst (idempotency check)
    //   2. tx.reservation.findFirst (load reservation+modifiers)
    //   3. tx.product.findMany (load product catalog)
    //   4. tx.order.create (build the Order)
    //   5. tx.orderItem.create (one per product)
    function mockHelperHappyPath(opts: { partySize: number; price: number; orderId?: string } = { partySize: 1, price: 200 }) {
      const orderId = opts.orderId ?? 'order-walkin-001'
      prismaMock.order.findFirst.mockResolvedValueOnce(null) // no prior order — idempotent allow
      prismaMock.reservation.findFirst.mockResolvedValueOnce({
        id: RESERVATION_ID,
        productId: PRODUCT_ID,
        productIds: [],
        partySize: opts.partySize,
        tableId: null,
        customerId: null,
        guestName: 'Ana Lopez',
        guestPhone: '+525551234567',
        guestEmail: null,
        specialRequests: null,
        modifiers: [],
      } as any)
      prismaMock.product.findMany.mockResolvedValueOnce([
        {
          id: PRODUCT_ID,
          name: 'Yoga Class',
          sku: 'YOGA-001',
          price: opts.price,
          taxRate: 0,
          category: { name: 'Wellness' },
        } as any,
      ])
      prismaMock.order.create.mockResolvedValueOnce({ id: orderId } as any)
      prismaMock.orderItem.create.mockResolvedValue({ id: 'orderitem-001' } as any)
    }

    it('should create CHECKED_IN reservation + build Order when checkInImmediately=true', async () => {
      mockSessionAndEnrolled(sessionRow, 3)
      const checkedInReservation = makeReservation({
        status: 'CHECKED_IN',
        classSessionId: SESSION_ID,
        partySize: 1,
        checkedInAt: new Date(),
      })
      prismaMock.reservation.create.mockResolvedValue(checkedInReservation)
      mockHelperHappyPath({ partySize: 1, price: 200, orderId: 'order-abc-123' })

      const result = await addAttendee(VENUE_ID, SESSION_ID, { ...addAttendeeDto, partySize: 1, checkInImmediately: true } as any, STAFF_ID)

      // 1) Reservation persisted as CHECKED_IN with checkedInAt set
      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'CHECKED_IN',
            checkedInAt: expect.any(Date),
          }),
        }),
      )
      // 2) Helper built an Order — verified by the orderItem mock being touched
      expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
      expect(prismaMock.orderItem.create).toHaveBeenCalledTimes(1)
      // 3) Result shape carries the orderId so the controller can deep-link
      expect(result.orderId).toBe('order-abc-123')
      expect(result.reservation.status).toBe('CHECKED_IN')
    })

    it('should pass quantity=partySize to OrderItem when checkInImmediately=true and partySize>1', async () => {
      // Capacity 10, 0 enrolled, partySize=3 — full family bought in one charge.
      mockSessionAndEnrolled(sessionRow, 0)
      const familyReservation = makeReservation({
        status: 'CHECKED_IN',
        classSessionId: SESSION_ID,
        partySize: 3,
        checkedInAt: new Date(),
      })
      prismaMock.reservation.create.mockResolvedValue(familyReservation)
      mockHelperHappyPath({ partySize: 3, price: 200 })

      await addAttendee(VENUE_ID, SESSION_ID, { ...addAttendeeDto, partySize: 3, checkInImmediately: true } as any, STAFF_ID)

      // OrderItem.quantity reflects seatCount so the cashier charges 3× the class price
      expect(prismaMock.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: PRODUCT_ID,
            quantity: 3,
          }),
        }),
      )
      // And the Order subtotal should be 3 × 200 = 600 (no modifiers, taxRate=0)
      const orderCreateCall = prismaMock.order.create.mock.calls[0][0] as any
      expect(orderCreateCall.data.subtotal.toString()).toBe('600')
      expect(orderCreateCall.data.total.toString()).toBe('600')
    })

    it('should not call the Order helper when checkInImmediately is absent (regression guard)', async () => {
      mockSessionAndEnrolled(sessionRow, 3)
      prismaMock.reservation.create.mockResolvedValue(makeReservation({ status: 'CONFIRMED' }))

      const result = await addAttendee(VENUE_ID, SESSION_ID, addAttendeeDto as any, STAFF_ID)

      // The helper's first query (order.findFirst) must NOT have fired,
      // proving the default path is unchanged for legacy callers.
      expect(prismaMock.order.findFirst).not.toHaveBeenCalled()
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(prismaMock.orderItem.create).not.toHaveBeenCalled()
      expect(result.orderId).toBeNull()
    })

    it('should return orderId=null when helper cannot build the Order (productId soft-deleted)', async () => {
      mockSessionAndEnrolled(sessionRow, 3)
      prismaMock.reservation.create.mockResolvedValue(makeReservation({ status: 'CHECKED_IN', classSessionId: SESSION_ID, partySize: 1 }))
      // Helper happy path UNTIL product.findMany — return empty so the
      // helper bails out at "no products resolved" and returns null.
      prismaMock.order.findFirst.mockResolvedValueOnce(null)
      prismaMock.reservation.findFirst.mockResolvedValueOnce({
        id: RESERVATION_ID,
        productId: PRODUCT_ID,
        productIds: [],
        partySize: 1,
        tableId: null,
        customerId: null,
        guestName: 'Test',
        guestPhone: null,
        guestEmail: null,
        specialRequests: null,
        modifiers: [],
      } as any)
      prismaMock.product.findMany.mockResolvedValueOnce([]) // ← key: no product visible

      const result = await addAttendee(VENUE_ID, SESSION_ID, { ...addAttendeeDto, partySize: 1, checkInImmediately: true } as any, STAFF_ID)

      // Reservation IS still CHECKED_IN (capacity already consumed),
      // but no Order was created.
      expect(result.reservation.status).toBe('CHECKED_IN')
      expect(result.orderId).toBeNull()
      expect(prismaMock.order.create).not.toHaveBeenCalled()
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
