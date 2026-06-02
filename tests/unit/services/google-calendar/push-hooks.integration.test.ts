/**
 * Integration tests for Google Calendar push hooks (Phase 2 — Section D).
 *
 * Verifies that the reservation / classSession service mutations co-commit
 * CalendarSyncOutbox rows when the venue has CONNECTED Google Calendar
 * connections + push enabled in ReservationSettings.
 *
 * Scope (per Phase 2 plan §D):
 *   • createReservation → emits CREATE outbox row + publishes to RMQ.
 *   • createReservation with no connections → 0 outbox rows; success still.
 *   • cancelReservation upgrades a PENDING CREATE to SKIPPED then enqueues CANCEL.
 *   • createReservation against a ClassSession → debounced UPDATE_ROSTER on the
 *     CLASS (not a per-attendee CREATE).
 *   • updateReservation (time change) → UPDATE outbox row.
 *   • cancelClassSession → ONE CANCEL row for the class (not per attendee).
 *   • Hooks are NO-OPs when googleCalendarPushEnabled=false on ReservationSettings.
 *
 * Strategy: lean on the global prismaMock + mock the gcal-push RabbitMQ publish
 * so we can assert it gets called with the right ids AFTER the tx commits.
 */
import { prismaMock } from '@tests/__helpers__/setup'

// Mock the RabbitMQ publish helper BEFORE importing services. The push consumer
// module also boots a connection lazily; we only want the spy on publishPushNotification.
jest.mock('@/communication/rabbitmq/gcal-push-consumer', () => ({
  __esModule: true,
  GCAL_PUSH_ROUTING_KEY: 'gcal.push',
  publishPushNotification: jest.fn().mockResolvedValue(undefined),
  startGcalPushConsumer: jest.fn().mockResolvedValue(undefined),
}))

import * as reservationService from '@/services/dashboard/reservation.dashboard.service'
import * as classSessionService from '@/services/dashboard/classSession.dashboard.service'
import { publishPushNotification } from '@/communication/rabbitmq/gcal-push-consumer'

const publishMock = publishPushNotification as jest.MockedFunction<typeof publishPushNotification>

const VENUE_ID = 'venue-1'
const STAFF_ID = 'staff-1'
const STAFF_CONN_ID = 'conn-staff-1'
const VENUE_CONN_ID = 'conn-venue-1'

/** A non-class reservation row stub. */
function buildReservation(overrides: Record<string, any> = {}) {
  return {
    id: 'res-1',
    venueId: VENUE_ID,
    confirmationCode: 'RES-ABC123',
    cancelSecret: 'cancel-secret-uuid',
    status: 'CONFIRMED',
    channel: 'DASHBOARD',
    startsAt: new Date('2026-06-01T14:00:00Z'),
    endsAt: new Date('2026-06-01T15:00:00Z'),
    duration: 60,
    customerId: null,
    guestName: 'Juan',
    guestPhone: '+5215551234567',
    guestEmail: null,
    partySize: 2,
    tableId: null,
    productId: null,
    assignedStaffId: STAFF_ID,
    classSessionId: null,
    spotIds: [],
    statusLog: [{ status: 'CONFIRMED', at: '2026-06-01T10:00:00.000Z', by: STAFF_ID }],
    createdAt: new Date('2026-06-01T10:00:00Z'),
    updatedAt: new Date('2026-06-01T10:00:00Z'),
    customer: null,
    table: null,
    product: null,
    assignedStaff: { id: STAFF_ID, firstName: 'Ana', lastName: 'Garcia' },
    createdBy: null,
    confirmedAt: new Date('2026-06-01T10:00:00Z'),
    checkedInAt: null,
    completedAt: null,
    cancelledAt: null,
    noShowAt: null,
    cancelledBy: null,
    cancellationReason: null,
    depositAmount: null,
    depositStatus: null,
    depositExpiresAt: null,
    refundStatus: null,
    refundRequestedAt: null,
    refundFailedReason: null,
    specialRequests: null,
    internalNotes: null,
    tags: [],
    idempotencyKey: null,
    ...overrides,
  }
}

function buildClassSession(overrides: Record<string, any> = {}) {
  return {
    id: 'class-1',
    venueId: VENUE_ID,
    productId: 'prod-class-1',
    startsAt: new Date('2026-06-01T18:00:00Z'),
    endsAt: new Date('2026-06-01T19:00:00Z'),
    duration: 60,
    capacity: 10,
    status: 'SCHEDULED',
    assignedStaffId: STAFF_ID,
    internalNotes: null,
    ...overrides,
  }
}

/** Standard happy-path push-enabled settings. */
function mockPushEnabled(dualWrite = false) {
  prismaMock.reservationSettings.findUnique.mockResolvedValue({
    googleCalendarPushEnabled: true,
    googleCalendarDualWrite: dualWrite,
  } as any)
}

/** Hook the connection lookup helper: staff first, venue second. */
function mockConnectionLookup({ staff, venue }: { staff?: string | null; venue?: string | null }) {
  prismaMock.googleCalendarConnection.findFirst
    .mockReset()
    .mockResolvedValueOnce(staff ? { id: staff } : null)
    .mockResolvedValueOnce(venue ? { id: venue } : null)
}

describe('Phase 2 push hooks integration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Pass-through transaction by default (callback form).
    prismaMock.$transaction.mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') return arg(prismaMock)
      return arg
    })
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.product.findFirst.mockResolvedValue(null)
    prismaMock.table.findFirst.mockResolvedValue(null)
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
    prismaMock.productModifierGroup.findMany.mockResolvedValue([])
    prismaMock.externalBusyBlock.findFirst.mockResolvedValue(null)
    prismaMock.reservation.findUnique.mockResolvedValue(null)
    prismaMock.reservation.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.calendarSyncOutbox.create.mockImplementation((args: any) => ({
      id: `outbox-${args.data.operation}-${args.data.targetConnectionId}`,
    }))
    prismaMock.calendarSyncOutbox.updateMany.mockResolvedValue({ count: 0 } as any)
  })

  describe('createReservation', () => {
    it('emits 1 CREATE outbox row + publishes when staff has a connected calendar', async () => {
      mockPushEnabled()
      mockConnectionLookup({ staff: STAFF_CONN_ID, venue: VENUE_CONN_ID })
      prismaMock.reservation.create.mockResolvedValue(buildReservation())

      await reservationService.createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-06-01T14:00:00Z'),
          endsAt: new Date('2026-06-01T15:00:00Z'),
          duration: 60,
          guestName: 'Juan',
          guestPhone: '+5215551234567',
          partySize: 2,
          assignedStaffId: STAFF_ID,
        },
        STAFF_ID,
        { scheduling: { autoConfirm: true } },
      )

      // Outbox row: kind=reservation, op=CREATE, target=staff connection, correct syncKey.
      expect(prismaMock.calendarSyncOutbox.create).toHaveBeenCalledTimes(1)
      expect(prismaMock.calendarSyncOutbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            venueId: VENUE_ID,
            reservationId: 'res-1',
            classSessionId: null,
            operation: 'CREATE',
            targetConnectionId: STAFF_CONN_ID,
            syncKey: `reservation:res-1:${STAFF_CONN_ID}`,
            status: 'PENDING',
          }),
        }),
      )

      // RMQ publish fired AFTER tx with the inserted row ids.
      expect(publishMock).toHaveBeenCalledTimes(1)
      expect(publishMock).toHaveBeenCalledWith([`outbox-CREATE-${STAFF_CONN_ID}`])
    })

    it('emits 0 outbox rows when no calendar is connected (still succeeds)', async () => {
      mockPushEnabled()
      mockConnectionLookup({ staff: null, venue: null })
      prismaMock.reservation.create.mockResolvedValue(buildReservation())

      const result = await reservationService.createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-06-01T14:00:00Z'),
          endsAt: new Date('2026-06-01T15:00:00Z'),
          duration: 60,
          guestName: 'Juan',
          assignedStaffId: STAFF_ID,
        },
        STAFF_ID,
        { scheduling: { autoConfirm: true } },
      )

      expect(result).toBeDefined()
      expect(result.confirmationCode).toBe('RES-ABC123')
      expect(prismaMock.calendarSyncOutbox.create).not.toHaveBeenCalled()
      expect(publishMock).not.toHaveBeenCalled()
    })

    it('NO-OP when ReservationSettings.googleCalendarPushEnabled=false', async () => {
      prismaMock.reservationSettings.findUnique.mockResolvedValue({
        googleCalendarPushEnabled: false,
        googleCalendarDualWrite: false,
      } as any)
      // No connection lookup should even happen — but if it did, return none.
      prismaMock.googleCalendarConnection.findFirst.mockResolvedValue(null)
      prismaMock.reservation.create.mockResolvedValue(buildReservation())

      await reservationService.createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-06-01T14:00:00Z'),
          endsAt: new Date('2026-06-01T15:00:00Z'),
          duration: 60,
          guestName: 'Juan',
          assignedStaffId: STAFF_ID,
        },
        STAFF_ID,
        { scheduling: { autoConfirm: true } },
      )

      expect(prismaMock.calendarSyncOutbox.create).not.toHaveBeenCalled()
      expect(prismaMock.googleCalendarConnection.findFirst).not.toHaveBeenCalled()
      expect(publishMock).not.toHaveBeenCalled()
    })

    it('emits 2 rows in dual-write mode when both staff + venue connections exist', async () => {
      mockPushEnabled(true)
      mockConnectionLookup({ staff: STAFF_CONN_ID, venue: VENUE_CONN_ID })
      prismaMock.reservation.create.mockResolvedValue(buildReservation())

      await reservationService.createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-06-01T14:00:00Z'),
          endsAt: new Date('2026-06-01T15:00:00Z'),
          duration: 60,
          guestName: 'Juan',
          assignedStaffId: STAFF_ID,
        },
        STAFF_ID,
        { scheduling: { autoConfirm: true } },
      )

      expect(prismaMock.calendarSyncOutbox.create).toHaveBeenCalledTimes(2)
      // Publish gets BOTH row ids in a single call.
      expect(publishMock).toHaveBeenCalledTimes(1)
      expect(publishMock).toHaveBeenCalledWith([`outbox-CREATE-${STAFF_CONN_ID}`, `outbox-CREATE-${VENUE_CONN_ID}`])
    })
  })

  describe('updateReservation', () => {
    it('emits 1 UPDATE outbox row when push enabled', async () => {
      mockPushEnabled()
      mockConnectionLookup({ staff: STAFF_CONN_ID, venue: null })

      const existing = buildReservation({ status: 'CONFIRMED' })
      prismaMock.reservation.findFirst.mockResolvedValue(existing)
      prismaMock.reservation.update.mockResolvedValue({
        ...existing,
        startsAt: new Date('2026-06-01T16:00:00Z'),
        endsAt: new Date('2026-06-01T17:00:00Z'),
      })

      await reservationService.updateReservation(
        VENUE_ID,
        'res-1',
        {
          startsAt: new Date('2026-06-01T16:00:00Z'),
          endsAt: new Date('2026-06-01T17:00:00Z'),
        },
        STAFF_ID,
      )

      expect(prismaMock.calendarSyncOutbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            operation: 'UPDATE',
            reservationId: 'res-1',
            targetConnectionId: STAFF_CONN_ID,
          }),
        }),
      )
      expect(publishMock).toHaveBeenCalledWith([`outbox-UPDATE-${STAFF_CONN_ID}`])
    })
  })

  describe('cancelReservation', () => {
    it('collapses superseded PENDING rows AND enqueues a CANCEL row', async () => {
      mockPushEnabled()
      mockConnectionLookup({ staff: STAFF_CONN_ID, venue: null })

      // updateMany on outbox simulates the "1 row marked SKIPPED" outcome.
      prismaMock.calendarSyncOutbox.updateMany.mockResolvedValue({ count: 1 } as any)

      const existing = buildReservation({ status: 'CONFIRMED' })
      prismaMock.reservation.findFirst.mockResolvedValue(existing)
      prismaMock.reservation.findUniqueOrThrow.mockResolvedValue({
        ...existing,
        status: 'CANCELLED',
        cancelledAt: new Date(),
      })

      await reservationService.cancelReservation(VENUE_ID, 'res-1', STAFF_ID, 'Changed plans')

      // 1) Collapse pre-flight: any PENDING/FAILED CREATE|UPDATE for the same syncKey.
      expect(prismaMock.calendarSyncOutbox.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            syncKey: `reservation:res-1:${STAFF_CONN_ID}`,
            status: { in: ['PENDING', 'FAILED'] },
            operation: { in: ['CREATE', 'UPDATE', 'UPDATE_ROSTER'] },
          }),
          data: expect.objectContaining({ status: 'SKIPPED', lastError: 'superseded_by_cancel' }),
        }),
      )
      // 2) New CANCEL row enqueued.
      expect(prismaMock.calendarSyncOutbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            operation: 'CANCEL',
            reservationId: 'res-1',
            targetConnectionId: STAFF_CONN_ID,
          }),
        }),
      )
      // 3) RMQ publish fired with the CANCEL row id.
      expect(publishMock).toHaveBeenCalledWith([`outbox-CANCEL-${STAFF_CONN_ID}`])
    })

    it('does NOT emit a per-attendee CANCEL when the reservation belongs to a ClassSession', async () => {
      mockPushEnabled()
      // Connection lookup runs for the CLASS resolution (UPDATE_ROSTER path).
      mockConnectionLookup({ staff: STAFF_CONN_ID, venue: null })

      const existing = buildReservation({ status: 'CONFIRMED', classSessionId: 'class-1' })
      prismaMock.reservation.findFirst.mockResolvedValue(existing)
      prismaMock.reservation.findUniqueOrThrow.mockResolvedValue({
        ...existing,
        status: 'CANCELLED',
        cancelledAt: new Date(),
      })
      prismaMock.classSession.findUnique.mockResolvedValue(buildClassSession())

      await reservationService.cancelReservation(VENUE_ID, 'res-1', STAFF_ID, 'Plans changed')

      // No per-reservation CANCEL outbox row — only an UPDATE_ROSTER on the class.
      const calls = prismaMock.calendarSyncOutbox.create.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      const ops = calls.map((c: any[]) => c[0].data.operation)
      expect(ops).not.toContain('CANCEL')
      expect(ops).toContain('UPDATE_ROSTER')
      // Roster row is debounced — sweeper publishes, we should NOT fire RMQ here.
      expect(publishMock).not.toHaveBeenCalled()
    })
  })

  describe('cancelClassSession', () => {
    it('emits ONE CANCEL row for the class (NOT one per attendee)', async () => {
      mockPushEnabled()
      mockConnectionLookup({ staff: STAFF_CONN_ID, venue: null })
      prismaMock.calendarSyncOutbox.updateMany.mockResolvedValue({ count: 2 } as any)

      const session = buildClassSession({ status: 'SCHEDULED' })
      prismaMock.classSession.findFirst.mockResolvedValue(session)
      // After cancel inside the tx — include SESSION_INCLUDE shape.
      prismaMock.classSession.update.mockResolvedValue({
        ...session,
        status: 'CANCELLED',
        product: null,
        assignedStaff: null,
        createdBy: null,
        reservations: [],
      })
      prismaMock.reservation.updateMany.mockResolvedValue({ count: 3 } as any)

      await classSessionService.cancelClassSession(VENUE_ID, 'class-1')

      // Earlier PENDING CREATEs for the class are collapsed.
      expect(prismaMock.calendarSyncOutbox.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            syncKey: `class:class-1:${STAFF_CONN_ID}`,
          }),
        }),
      )
      // Exactly ONE CANCEL row — NOT one per attendee reservation.
      const cancelCalls = prismaMock.calendarSyncOutbox.create.mock.calls.filter((c: any[]) => c[0].data.operation === 'CANCEL')
      expect(cancelCalls).toHaveLength(1)
      expect(cancelCalls[0][0].data).toMatchObject({
        classSessionId: 'class-1',
        reservationId: null,
        operation: 'CANCEL',
        targetConnectionId: STAFF_CONN_ID,
      })
      expect(publishMock).toHaveBeenCalledWith([`outbox-CANCEL-${STAFF_CONN_ID}`])
    })

    it('NO-OP when push disabled', async () => {
      prismaMock.reservationSettings.findUnique.mockResolvedValue({
        googleCalendarPushEnabled: false,
        googleCalendarDualWrite: false,
      } as any)

      const session = buildClassSession({ status: 'SCHEDULED' })
      prismaMock.classSession.findFirst.mockResolvedValue(session)
      prismaMock.classSession.update.mockResolvedValue({
        ...session,
        status: 'CANCELLED',
        product: null,
        assignedStaff: null,
        createdBy: null,
        reservations: [],
      })
      prismaMock.reservation.updateMany.mockResolvedValue({ count: 0 } as any)

      await classSessionService.cancelClassSession(VENUE_ID, 'class-1')

      expect(prismaMock.calendarSyncOutbox.create).not.toHaveBeenCalled()
      expect(publishMock).not.toHaveBeenCalled()
    })
  })

  describe('createClassSession', () => {
    it('emits 1 CREATE row + publishes when class has a connected instructor', async () => {
      mockPushEnabled()
      mockConnectionLookup({ staff: STAFF_CONN_ID, venue: null })
      prismaMock.product.findFirst.mockResolvedValue({ id: 'prod-class-1', type: 'CLASS', maxParticipants: 10 } as any)
      const newSession = {
        ...buildClassSession(),
        product: null,
        assignedStaff: null,
        createdBy: null,
        reservations: [],
      }
      prismaMock.classSession.create.mockResolvedValue(newSession)

      // createClassSession rejects past scheduling (startsAt < Date.now() - 60s),
      // so the input dates must be relative to now — a hardcoded absolute date is a time-bomb.
      const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
      const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000)

      await classSessionService.createClassSession(
        VENUE_ID,
        {
          productId: 'prod-class-1',
          startsAt: startsAt.toISOString() as any,
          endsAt: endsAt.toISOString() as any,
          capacity: 10,
          assignedStaffId: STAFF_ID,
        } as any,
        STAFF_ID,
      )

      expect(prismaMock.calendarSyncOutbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            operation: 'CREATE',
            classSessionId: 'class-1',
            reservationId: null,
            targetConnectionId: STAFF_CONN_ID,
            syncKey: `class:class-1:${STAFF_CONN_ID}`,
          }),
        }),
      )
      expect(publishMock).toHaveBeenCalledWith([`outbox-CREATE-${STAFF_CONN_ID}`])
    })
  })

  describe('addAttendee (dashboard side)', () => {
    it('emits a DEBOUNCED UPDATE_ROSTER (no immediate RMQ publish — sweeper handles it)', async () => {
      mockPushEnabled()
      mockConnectionLookup({ staff: STAFF_CONN_ID, venue: null })
      // Lock the class session row.
      prismaMock.$queryRaw.mockResolvedValueOnce([
        {
          id: 'class-1',
          productId: 'prod-class-1',
          startsAt: new Date('2026-06-01T18:00:00Z'),
          endsAt: new Date('2026-06-01T19:00:00Z'),
          duration: 60,
          capacity: 10,
          status: 'SCHEDULED',
        },
      ])
      // Enrolled count
      prismaMock.$queryRaw.mockResolvedValueOnce([{ total: BigInt(2) }])
      prismaMock.classSession.findUnique.mockResolvedValue(buildClassSession())
      prismaMock.reservation.create.mockResolvedValue(buildReservation({ classSessionId: 'class-1' }))

      await classSessionService.addAttendee(
        VENUE_ID,
        'class-1',
        {
          guestName: 'Pedro',
          guestPhone: '+5215559876543',
          partySize: 1,
        } as any,
        STAFF_ID,
      )

      const calls = prismaMock.calendarSyncOutbox.create.mock.calls
      expect(calls).toHaveLength(1)
      expect(calls[0][0].data).toMatchObject({
        operation: 'UPDATE_ROSTER',
        classSessionId: 'class-1',
        reservationId: null,
        targetConnectionId: STAFF_CONN_ID,
      })
      // debounceUntil should be ~30s in the future.
      const debounceUntil = calls[0][0].data.debounceUntil as Date
      expect(debounceUntil).toBeInstanceOf(Date)
      expect(debounceUntil.getTime()).toBeGreaterThan(Date.now() + 25_000)
      // No immediate RMQ publish for debounced rows.
      expect(publishMock).not.toHaveBeenCalled()
    })
  })

  describe('removeAttendee', () => {
    it('emits debounced UPDATE_ROSTER instead of per-attendee CANCEL', async () => {
      mockPushEnabled()
      mockConnectionLookup({ staff: STAFF_CONN_ID, venue: null })
      prismaMock.reservation.findFirst.mockResolvedValue(buildReservation({ status: 'CONFIRMED', classSessionId: 'class-1' }))
      prismaMock.reservation.update.mockResolvedValue(buildReservation({ status: 'CANCELLED', classSessionId: 'class-1' }))
      prismaMock.classSession.findUnique.mockResolvedValue(buildClassSession())

      await classSessionService.removeAttendee(VENUE_ID, 'class-1', 'res-1')

      const calls = prismaMock.calendarSyncOutbox.create.mock.calls
      expect(calls).toHaveLength(1)
      expect(calls[0][0].data.operation).toBe('UPDATE_ROSTER')
      expect(publishMock).not.toHaveBeenCalled()
    })
  })
})
