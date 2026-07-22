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
  rescheduleAppointmentReservation,
  getReservationsCalendar,
  handleNoShowDepositForfeit,
} from '@/services/dashboard/reservation.dashboard.service'
import { countAppointmentOccupancy } from '@/services/dashboard/reservationAvailability.service'
import * as reservationAvailabilityService from '@/services/dashboard/reservationAvailability.service'
import * as appointmentStaffAssignmentService from '@/services/dashboard/appointmentStaffAssignment.service'
import * as calendarOutboxService from '@/services/google-calendar/outbox.service'
import * as reservationSettingsService from '@/services/dashboard/reservationSettings.service'
import * as appointmentWindowService from '@/services/reservation/resolveAppointmentWindow'
import * as appointmentSlotHoldService from '@/services/reservation/appointmentSlotHold.service'
import * as basePlanService from '@/services/access/basePlan.service'
import * as rabbitCalendarPublisher from '@/communication/rabbitmq/gcal-push-consumer'
import * as activityLogService from '@/services/dashboard/activity-log.service'
import * as whatsappService from '@/services/whatsapp.service'
import emailService from '@/services/email.service'
import { getDefaultOperatingHours, type ReservationConfig } from '@/services/dashboard/reservationSettings.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { Prisma } from '@prisma/client'
import logger from '@/config/logger'

// ---- Helpers ----

const VENUE_ID = 'venue-123'
const STAFF_ID = 'staff-456'
const DASHBOARD_WRITE = { writeOrigin: 'DASHBOARD' as const }

function makeReservationSettings(
  overrides: {
    autoConfirm?: boolean
    minNoticeMin?: number
    onlineCapacityPercent?: number
    capacityMode?: 'pacing' | 'per_staff'
    pacingMaxPerSlot?: number | null
    showStaffPicker?: boolean
    deposits?: Partial<ReservationConfig['deposits']>
  } = {},
): ReservationConfig {
  return {
    scheduling: {
      slotIntervalMin: 15,
      defaultDurationMin: 60,
      autoConfirm: overrides.autoConfirm ?? true,
      maxAdvanceDays: 365,
      minNoticeMin: overrides.minNoticeMin ?? 0,
      noShowGraceMin: 15,
      pacingMaxPerSlot: overrides.pacingMaxPerSlot ?? null,
      onlineCapacityPercent: overrides.onlineCapacityPercent ?? 100,
      capacityMode: overrides.capacityMode ?? 'pacing',
    },
    deposits: {
      enabled: false,
      mode: 'none',
      percentageOfTotal: null,
      fixedAmount: null,
      requiredForPartySizeGte: null,
      paymentWindowHrs: 24,
      ...overrides.deposits,
    },
    payments: { appointmentUpfrontDefault: 'at_venue', classUpfrontDefault: 'required' },
    cancellation: {
      allowCustomerCancel: true,
      minHoursBeforeStart: null,
      forfeitDeposit: false,
      noShowFeePercent: null,
      creditRefundMode: 'TIME_BASED',
      creditFreeRefundHoursBefore: 24,
      creditLateRefundPercent: 0,
      creditNoShowRefund: false,
      allowCustomerReschedule: true,
    },
    waitlist: { enabled: false, maxSize: 20, priorityMode: 'fifo', notifyWindowMin: 15 },
    reminders: { enabled: false, channels: [], minutesBefore: [] },
    publicBooking: {
      enabled: true,
      requirePhone: false,
      requireEmail: false,
      requireAccount: false,
      showStaffPicker: overrides.showStaffPicker ?? false,
    },
    googleCalendar: {
      pushEnabled: false,
      dualWrite: false,
      eventDetailLevel: 'FULL',
      removeCancelled: false,
      classRosterInDescription: false,
    },
    operatingHours: getDefaultOperatingHours(),
  }
}

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
  productIds: [],
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
    jest.restoreAllMocks()
    jest.resetAllMocks()
    jest.spyOn(reservationSettingsService, 'getReservationSettings').mockResolvedValue(makeReservationSettings())
    prismaMock.$transaction.mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') return arg(prismaMock)
      return arg
    })
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.table.findFirst.mockResolvedValue({ id: 'table-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({
      id: 'sv-1',
      staffId: STAFF_ID,
      venue: { organizationId: 'org-1' },
    } as any)
    prismaMock.product.findFirst.mockResolvedValue({
      id: 'prod-1',
      price: new Prisma.Decimal(100),
      eventCapacity: 20,
    })
    // transitionReservation now uses an atomic guarded updateMany + a findUniqueOrThrow
    // re-read for the race-condition fix. Default both to "happy path" so old tests that
    // only mocked .update keep working — individual tests can override findUniqueOrThrow
    // when they want a specific shape returned to the caller.
    prismaMock.reservation.updateMany.mockResolvedValue({ count: 1 } as any)
    // Task 4: resolveModifierSelections calls productModifierGroup.findMany in all reservation creations.
    // Default to empty array to maintain backward compatibility with existing tests that don't mock this.
    prismaMock.productModifierGroup.findMany.mockResolvedValue([])
    jest.spyOn(appointmentStaffAssignmentService, 'lockAppointmentVenue').mockResolvedValue()
    jest.spyOn(appointmentStaffAssignmentService, 'resolveStaffAssignment').mockResolvedValue(STAFF_ID)
    jest.spyOn(appointmentStaffAssignmentService, 'assertOrganizationStaffAvailability').mockResolvedValue()
  })

  // ==========================================
  // CREATE RESERVATION
  // ==========================================

  describe('createReservation', () => {
    it('atomically persists the canonical lead and an explicitly supplied ordered product list', async () => {
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.product.findMany.mockResolvedValue([
        { id: 'prod-1', price: new Prisma.Decimal(100), eventCapacity: null, type: 'APPOINTMENTS_SERVICE' },
        { id: 'prod-2', price: new Prisma.Decimal(200), eventCapacity: null, type: 'APPOINTMENTS_SERVICE' },
      ] as any)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))

      await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
          productId: 'prod-1',
          productIds: [' prod-1 ', 'prod-2', 'prod-1'],
        },
        DASHBOARD_WRITE,
        STAFF_ID,
      )

      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ productId: 'prod-1', productIds: ['prod-1', 'prod-2'] }),
        }),
      )
    })

    it.each([
      ['legacy scalar', { productId: 'prod-1' }, []],
      ['explicit singleton', { productId: 'prod-1', productIds: ['prod-1'] }, ['prod-1']],
    ])('preserves %s productIds storage compatibility', async (_label, productInput, expectedProductIds) => {
      prismaMock.product.findMany.mockResolvedValue([
        { id: 'prod-1', price: new Prisma.Decimal(100), eventCapacity: null, type: 'APPOINTMENTS_SERVICE' },
      ] as any)
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))

      await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
          ...productInput,
        },
        DASHBOARD_WRITE,
        STAFF_ID,
      )

      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ productId: 'prod-1', productIds: expectedProductIds }) }),
      )
    })

    it.each([
      ['lead mismatch', { productId: 'prod-2', productIds: ['prod-1', 'prod-2'] }],
      ['explicit empty mismatch', { productId: 'prod-1', productIds: [] }],
      ['more than twenty', { productIds: Array.from({ length: 21 }, (_, index) => `prod-${index}`) }],
    ])('rejects %s before any transactional write', async (_label, productInput) => {
      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt: new Date('2026-03-01T15:00:00Z'),
            duration: 60,
            ...productInput,
          },
          DASHBOARD_WRITE,
          STAFF_ID,
        ),
      ).rejects.toBeInstanceOf(BadRequestError)

      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
      expect(prismaMock.reservationModifier.createMany).not.toHaveBeenCalled()
      expect(prismaMock.calendarSyncOutbox.create).not.toHaveBeenCalled()
    })

    it.each([
      ['foreign second service', [{ id: 'prod-1', price: new Prisma.Decimal(100), eventCapacity: null, type: 'APPOINTMENTS_SERVICE' }]],
      [
        'class in list',
        [
          { id: 'prod-1', price: new Prisma.Decimal(100), eventCapacity: null, type: 'APPOINTMENTS_SERVICE' },
          { id: 'prod-2', price: new Prisma.Decimal(100), eventCapacity: null, type: 'CLASS' },
        ],
      ],
    ])('rejects an explicit list containing a %s with zero writes', async (_label, rows) => {
      prismaMock.product.findMany.mockResolvedValue(rows as any)

      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt: new Date('2026-03-01T15:00:00Z'),
            duration: 60,
            productId: 'prod-1',
            productIds: ['prod-1', 'prod-2'],
          },
          DASHBOARD_WRITE,
          STAFF_ID,
        ),
      ).rejects.toBeInstanceOf(BadRequestError)

      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
      expect(prismaMock.reservationModifier.createMany).not.toHaveBeenCalled()
      expect(prismaMock.calendarSyncOutbox.create).not.toHaveBeenCalled()
    })

    it('returns a recoverable conflict for a stale base window before any write', async () => {
      prismaMock.product.findMany.mockResolvedValue([
        {
          id: 'prod-1',
          duration: 60,
          durationMinutes: null,
          price: new Prisma.Decimal(100),
          eventCapacity: null,
          type: 'APPOINTMENTS_SERVICE',
        },
      ] as any)

      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt: new Date('2026-03-01T14:05:00Z'),
            duration: 5,
            productId: 'prod-1',
            productIds: ['prod-1'],
          },
          { ...DASHBOARD_WRITE, windowSemantics: 'base' },
          STAFF_ID,
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'APPOINTMENT_WINDOW_CHANGED',
        details: { expectedBaseDurationMin: 60, expectedBaseEndsAt: '2026-03-01T15:00:00.000Z' },
      })
      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
      expect(prismaMock.reservationModifier.createMany).not.toHaveBeenCalled()
      expect(prismaMock.calendarSyncOutbox.create).not.toHaveBeenCalled()
    })

    it.each([
      ['raw interval', 60, new Date('2026-03-01T14:05:00Z')],
      ['declared duration', 5, new Date('2026-03-01T15:00:00Z')],
      ['exact raw interval', 60, new Date('2026-03-01T14:59:31Z')],
    ])('rejects when the %s is below the staff-aware legacy floor', async (_label, duration, endsAt) => {
      prismaMock.product.findFirst.mockResolvedValue({
        id: 'prod-1',
        price: new Prisma.Decimal(100),
        eventCapacity: null,
        type: 'APPOINTMENTS_SERVICE',
      } as any)
      prismaMock.product.findMany.mockResolvedValue([{ id: 'prod-1', duration: 60, durationMinutes: null }] as any)
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))
      jest
        .spyOn(reservationSettingsService, 'getReservationSettings')
        .mockResolvedValue(makeReservationSettings({ capacityMode: 'per_staff' }))

      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt,
            duration,
            productId: 'prod-1',
          },
          DASHBOARD_WRITE,
          STAFF_ID,
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: 'APPOINTMENT_WINDOW_CHANGED' })
      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
      expect(prismaMock.reservationModifier.createMany).not.toHaveBeenCalled()
      expect(prismaMock.calendarSyncOutbox.create).not.toHaveBeenCalled()
    })

    it('keeps a longer raw interval valid when its declared duration meets the staff-aware floor', async () => {
      const endsAt = new Date('2026-03-01T15:15:00Z')
      prismaMock.product.findFirst.mockResolvedValue({
        id: 'prod-1',
        price: new Prisma.Decimal(100),
        eventCapacity: null,
        type: 'APPOINTMENTS_SERVICE',
      } as any)
      prismaMock.product.findMany.mockResolvedValue([{ id: 'prod-1', duration: 60, durationMinutes: null }] as any)
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))
      jest
        .spyOn(reservationSettingsService, 'getReservationSettings')
        .mockResolvedValue(makeReservationSettings({ capacityMode: 'per_staff' }))

      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt,
            duration: 60,
            productId: 'prod-1',
          },
          DASHBOARD_WRITE,
          STAFF_ID,
        ),
      ).resolves.toBeDefined()

      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ duration: 60, endsAt }),
        }),
      )
    })

    it('persists a canonical one-minute appointment under base semantics', async () => {
      prismaMock.product.findMany.mockResolvedValue([
        {
          id: 'prod-1',
          duration: 1,
          durationMinutes: null,
          price: new Prisma.Decimal(100),
          eventCapacity: null,
          type: 'APPOINTMENTS_SERVICE',
        },
      ] as any)
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))

      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt: new Date('2026-03-01T14:01:00Z'),
            duration: 1,
            productId: 'prod-1',
            productIds: ['prod-1'],
          },
          { ...DASHBOARD_WRITE, windowSemantics: 'base' },
          STAFF_ID,
        ),
      ).resolves.toBeDefined()

      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ duration: 1, endsAt: new Date('2026-03-01T14:01:00Z') }),
        }),
      )
    })

    it('keeps the same five-minute legacy appointment under default settings and rejects raw 481', async () => {
      prismaMock.product.findFirst.mockResolvedValue({
        id: 'prod-1',
        price: new Prisma.Decimal(100),
        eventCapacity: null,
        type: 'APPOINTMENTS_SERVICE',
      } as any)
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))

      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt: new Date('2026-03-01T14:05:00Z'),
            duration: 5,
            productId: 'prod-1',
          },
          DASHBOARD_WRITE,
          STAFF_ID,
        ),
      ).resolves.toBeDefined()
      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ duration: 5, endsAt: new Date('2026-03-01T14:05:00Z') }) }),
      )

      jest.clearAllMocks()
      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt: new Date('2026-03-01T22:01:00Z'),
            duration: 481,
            productId: 'prod-1',
          },
          DASHBOARD_WRITE,
          STAFF_ID,
        ),
      ).rejects.toBeInstanceOf(BadRequestError)
      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    })

    it('reads authoritative settings from the transaction and keeps actor attribution separate from write context', async () => {
      const settings = makeReservationSettings({ autoConfirm: false })
      const settingsSpy = jest.spyOn(reservationSettingsService, 'getReservationSettings').mockResolvedValue(settings)
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))

      await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
        },
        DASHBOARD_WRITE,
        STAFF_ID,
      )

      expect(settingsSpy).toHaveBeenCalledWith(VENUE_ID, prismaMock)
      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PENDING', createdById: STAFF_ID }),
        }),
      )
    })

    it('re-reads settings after P2034 and commits only the successful attempt policy', async () => {
      const firstAttempt = makeReservationSettings({ autoConfirm: true })
      const secondAttempt = makeReservationSettings({
        autoConfirm: false,
        deposits: { enabled: true, mode: 'deposit', fixedAmount: 175, paymentWindowHrs: 45 },
      })
      const settingsSpy = jest
        .spyOn(reservationSettingsService, 'getReservationSettings')
        .mockResolvedValueOnce(firstAttempt)
        .mockResolvedValueOnce(secondAttempt)
      const serializationError = Object.assign(new Error('serialization conflict'), { code: 'P2034' })
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create
        .mockRejectedValueOnce(serializationError)
        .mockImplementationOnce(async ({ data }: any) => createMockReservation(data))

      await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
          partySize: 2,
        },
        DASHBOARD_WRITE,
        STAFF_ID,
      )

      expect(settingsSpy).toHaveBeenCalledTimes(2)
      expect(settingsSpy).toHaveBeenNthCalledWith(1, VENUE_ID, prismaMock)
      expect(settingsSpy).toHaveBeenNthCalledWith(2, VENUE_ID, prismaMock)
      expect(prismaMock.reservation.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PENDING',
            depositAmount: new Prisma.Decimal(175),
            depositStatus: 'PENDING',
            createdById: STAFF_ID,
          }),
        }),
      )
    })

    it('emits the successful create log once when a completed transaction attempt is retried', async () => {
      const settingsSpy = jest
        .spyOn(reservationSettingsService, 'getReservationSettings')
        .mockResolvedValueOnce(makeReservationSettings({ autoConfirm: true }))
        .mockResolvedValueOnce(makeReservationSettings({ autoConfirm: false }))
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger)
      const serializationError = Object.assign(new Error('serialization conflict'), { code: 'P2034' })
      let attempts = 0
      prismaMock.$transaction.mockImplementation(async (fn: any) => {
        const result = await fn(prismaMock)
        attempts += 1
        if (attempts === 1) throw serializationError
        return result
      })
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))

      await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
        },
        DASHBOARD_WRITE,
        STAFF_ID,
      )

      expect(settingsSpy).toHaveBeenCalledTimes(2)
      expect(prismaMock.reservation.create).toHaveBeenCalledTimes(2)
      expect(infoSpy.mock.calls.filter(([message]) => String(message).includes('[RESERVATION] Created'))).toHaveLength(1)
    })

    it('honors only the trusted deposits override and ignores policy-shaped body/context extras', async () => {
      const settingsSpy = jest
        .spyOn(reservationSettingsService, 'getReservationSettings')
        .mockResolvedValue(makeReservationSettings({ autoConfirm: true, minNoticeMin: 0 }))
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))

      await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
          partySize: 1,
          paymentPolicyOverride: { deposits: { enabled: false, mode: 'none' } },
          moduleConfig: { scheduling: { autoConfirm: false } },
        } as any,
        {
          writeOrigin: 'PUBLIC',
          paymentPolicyOverride: {
            deposits: {
              enabled: true,
              mode: 'prepaid',
              fixedAmount: 225,
              percentageOfTotal: null,
              requiredForPartySizeGte: null,
              paymentWindowHrs: 60,
            },
            scheduling: { autoConfirm: false },
          } as any,
        },
      )

      expect(settingsSpy).toHaveBeenCalledWith(VENUE_ID, prismaMock)
      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PENDING',
            depositAmount: new Prisma.Decimal(225),
            depositStatus: 'PENDING',
          }),
        }),
      )
    })

    it('keeps WALK_IN exempt from transactional minimum-notice settings', async () => {
      const settingsSpy = jest
        .spyOn(reservationSettingsService, 'getReservationSettings')
        .mockResolvedValue(makeReservationSettings({ minNoticeMin: 240 }))
      const startsAt = new Date(Date.now() + 30 * 60_000)
      const endsAt = new Date(startsAt.getTime() + 60 * 60_000)
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))

      await expect(
        createReservation(VENUE_ID, { startsAt, endsAt, duration: 60, channel: 'WALK_IN' }, DASHBOARD_WRITE, STAFF_ID),
      ).resolves.toBeDefined()

      expect(settingsSpy).toHaveBeenCalledWith(VENUE_ID, prismaMock)
    })

    async function arrangeStaffAwareAppointment(
      overrides: {
        pacingMaxPerSlot?: number | null
        showStaffPicker?: boolean
        resolvedStaffId?: string
        occupancy?: { reservations: number; holds: number }
      } = {},
    ) {
      jest.spyOn(reservationSettingsService, 'getReservationSettings').mockResolvedValue(
        makeReservationSettings({
          capacityMode: 'per_staff',
          pacingMaxPerSlot: overrides.pacingMaxPerSlot,
          showStaffPicker: overrides.showStaffPicker,
        }),
      )
      prismaMock.product.findFirst.mockResolvedValue({
        id: 'prod-1',
        duration: 60,
        durationMinutes: null,
        price: new Prisma.Decimal(100),
        eventCapacity: null,
        type: 'APPOINTMENTS_SERVICE',
      } as any)
      prismaMock.product.findMany.mockResolvedValue([
        {
          id: 'prod-1',
          duration: 60,
          durationMinutes: null,
          price: new Prisma.Decimal(100),
          eventCapacity: null,
          type: 'APPOINTMENTS_SERVICE',
        },
      ] as any)
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))
      const lock = jest.spyOn(appointmentStaffAssignmentService, 'lockAppointmentVenue').mockResolvedValue()
      const resolveStaff = jest
        .spyOn(appointmentStaffAssignmentService, 'resolveStaffAssignment')
        .mockResolvedValue(overrides.resolvedStaffId ?? 'staff-resolved')
      const occupancy = jest
        .spyOn(reservationAvailabilityService, 'countAppointmentOccupancy')
        .mockResolvedValue(overrides.occupancy ?? { reservations: 0, holds: 0 })
      return { lock, resolveStaff, occupancy }
    }

    const appointmentInput = {
      startsAt: new Date('2026-03-01T14:00:00Z'),
      endsAt: new Date('2026-03-01T15:00:00Z'),
      duration: 60,
      productId: 'prod-1',
      productIds: ['prod-1'],
    }

    it('fails closed when a normal appointment candidate token is attached to a non-appointment create', async () => {
      prismaMock.product.findMany.mockResolvedValue([
        {
          id: 'prod-1',
          price: new Prisma.Decimal(100),
          eventCapacity: 20,
          type: 'EVENT',
        },
      ] as any)

      await expect(
        createReservation(VENUE_ID, appointmentInput, {
          writeOrigin: 'CONSUMER',
          appointmentHoldId: 'hold-candidate',
        }),
      ).rejects.toMatchObject({ statusCode: 409, message: expect.any(String) })

      expect(appointmentStaffAssignmentService.lockAppointmentVenue).not.toHaveBeenCalled()
      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
      expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
    })

    it.each([
      ['missing', [], 'base', undefined],
      ['foreign', [], 'base', undefined],
      ['expired', [{ expiresAt: new Date('2000-01-01T00:00:00.000Z') }], 'base', undefined],
      ['class', [{ classSessionId: 'class-1' }], 'base', undefined],
      ['new reschedule', [{ heldForReservationId: 'reservation-1' }], 'base', undefined],
      ['marker upgrade', [{ windowSemantics: null }], 'base', undefined],
      ['marker downgrade', [{}], undefined, undefined],
      ['product order', [{ productIds: ['prod-2', 'prod-1'] }], 'base', undefined],
      ['explicit staff mismatch', [{ staffId: 'staff-held' }], 'base', 'staff-requested'],
    ] as const)(
      'rejects the full-create %s token case with zero booking writes and no hold deletion',
      async (_label, rowOverrides, semantics, assignedStaffId) => {
        const matrixProducts = [
          {
            id: 'prod-1',
            duration: 30,
            durationMinutes: null,
            price: new Prisma.Decimal(100),
            eventCapacity: null,
            type: 'APPOINTMENTS_SERVICE',
          },
          {
            id: 'prod-2',
            duration: 30,
            durationMinutes: null,
            price: new Prisma.Decimal(100),
            eventCapacity: null,
            type: 'APPOINTMENTS_SERVICE',
          },
        ]
        prismaMock.product.findMany.mockResolvedValue(matrixProducts as any)
        jest.spyOn(appointmentWindowService, 'resolveAppointmentWindow').mockResolvedValue({
          startsAt: appointmentInput.startsAt,
          baseEndsAt: appointmentInput.endsAt,
          finalEndsAt: appointmentInput.endsAt,
          canonicalBaseDurationMin: 60,
          modifierDurationDelta: 0,
          finalDurationMin: 60,
          productIds: ['prod-1', 'prod-2'],
          modifierRows: [],
          modifierPriceDelta: new Prisma.Decimal(0),
        })
        const liveRow = {
          id: 'hold-matrix',
          venueId: VENUE_ID,
          startsAt: appointmentInput.startsAt,
          endsAt: appointmentInput.endsAt,
          productIds: ['prod-1', 'prod-2'],
          classSessionId: null,
          staffId: null,
          heldForReservationId: null,
          windowSemantics: 'base',
          expiresAt: new Date('2099-03-01T13:00:00.000Z'),
        }
        prismaMock.$queryRaw.mockResolvedValue(rowOverrides.length === 0 ? [] : ([{ ...liveRow, ...rowOverrides[0] }] as any))
        const enqueue = jest.spyOn(calendarOutboxService, 'enqueuePush').mockResolvedValue([])

        await expect(
          createReservation(
            VENUE_ID,
            {
              ...appointmentInput,
              productIds: ['prod-1', 'prod-2'],
              ...(assignedStaffId ? { assignedStaffId } : {}),
            },
            {
              writeOrigin: 'PUBLIC',
              ...(semantics === 'base' ? { windowSemantics: semantics } : {}),
              appointmentHoldId: 'hold-matrix',
            },
          ),
        ).rejects.toMatchObject({ statusCode: 409, message: expect.any(String) })

        expect(prismaMock.reservation.create).not.toHaveBeenCalled()
        expect(prismaMock.reservationModifier.createMany).not.toHaveBeenCalled()
        expect(enqueue).not.toHaveBeenCalled()
        expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
      },
    )

    it('locks the appointment venue before resource authority, pacing, and writes and captures checkedAt after the lock', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-02-01T10:00:00Z'))
      try {
        const { lock, resolveStaff, occupancy } = await arrangeStaffAwareAppointment({ pacingMaxPerSlot: 2, showStaffPicker: true })
        lock.mockImplementation(async () => {
          jest.setSystemTime(new Date('2026-02-01T10:00:01Z'))
        })

        await createReservation(VENUE_ID, { ...appointmentInput, assignedStaffId: 'staff-requested' }, {
          writeOrigin: 'PUBLIC',
          windowSemantics: 'base',
        } as any)

        expect(lock).toHaveBeenCalledTimes(1)
        expect(resolveStaff).toHaveBeenCalledWith(
          prismaMock,
          expect.objectContaining({
            requestedStaffId: 'staff-requested',
            checkedAt: new Date('2026-02-01T10:00:01Z'),
            excludeHoldId: undefined,
          }),
        )
        expect(occupancy).toHaveBeenCalledWith(prismaMock, expect.objectContaining({ checkedAt: new Date('2026-02-01T10:00:01Z') }))
        expect(lock.mock.invocationCallOrder[0]).toBeLessThan(resolveStaff.mock.invocationCallOrder[0])
        expect(resolveStaff.mock.invocationCallOrder[0]).toBeLessThan(occupancy.mock.invocationCallOrder[0])
        expect(occupancy.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.reservation.create.mock.invocationCallOrder[0])
      } finally {
        jest.useRealTimers()
      }
    })

    it('row-locks and atomically consumes a normal hold after reservation and outbox writes', async () => {
      prismaMock.product.findFirst.mockResolvedValue({
        id: 'prod-1',
        duration: 60,
        durationMinutes: null,
        price: new Prisma.Decimal(100),
        eventCapacity: null,
        type: 'APPOINTMENTS_SERVICE',
      } as any)
      prismaMock.product.findMany.mockResolvedValue([
        {
          id: 'prod-1',
          duration: 60,
          durationMinutes: null,
          price: new Prisma.Decimal(100),
          eventCapacity: null,
          type: 'APPOINTMENTS_SERVICE',
        },
      ] as any)
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))
      const lock = jest.spyOn(appointmentStaffAssignmentService, 'lockAppointmentVenue').mockResolvedValue()
      const occupancy = jest.spyOn(reservationAvailabilityService, 'countAppointmentOccupancy').mockResolvedValue({
        reservations: 0,
        holds: 0,
      })
      const holdId = 'hold-normal'
      const holdRow = {
        id: holdId,
        venueId: VENUE_ID,
        startsAt: appointmentInput.startsAt,
        endsAt: appointmentInput.endsAt,
        productIds: ['prod-1'],
        classSessionId: null,
        staffId: null,
        heldForReservationId: null,
        windowSemantics: 'base',
        expiresAt: new Date('2099-03-01T13:00:00.000Z'),
      }
      prismaMock.$queryRaw.mockResolvedValueOnce([holdRow] as any).mockResolvedValue([])
      jest.spyOn(appointmentWindowService, 'resolveAppointmentWindow').mockResolvedValue({
        startsAt: appointmentInput.startsAt,
        baseEndsAt: appointmentInput.endsAt,
        finalEndsAt: appointmentInput.endsAt,
        canonicalBaseDurationMin: 60,
        modifierDurationDelta: 0,
        finalDurationMin: 60,
        productIds: ['prod-1'],
        modifierRows: [
          {
            productId: 'prod-1',
            modifierId: 'modifier-1',
            name: 'Extra',
            quantity: 1,
            price: new Prisma.Decimal(10),
          },
        ],
        modifierPriceDelta: new Prisma.Decimal(10),
      })
      prismaMock.reservationModifier.createMany.mockResolvedValue({ count: 1 } as any)
      const targets = jest.spyOn(calendarOutboxService, 'resolveReservationPushTargets').mockResolvedValue([{ id: 'connection-1' }] as any)
      const enqueue = jest.spyOn(calendarOutboxService, 'enqueuePush').mockResolvedValue(['outbox-1'])

      await createReservation(VENUE_ID, { ...appointmentInput, modifierSelections: [{ productId: 'prod-1', modifierId: 'modifier-1' }] }, {
        writeOrigin: 'PUBLIC',
        windowSemantics: 'base',
        appointmentHoldId: holdId,
      } as any)

      expect(lock).toHaveBeenCalledTimes(1)
      expect(prismaMock.$queryRaw).toHaveBeenCalled()
      expect(lock.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.$queryRaw.mock.invocationCallOrder[0])
      expect(occupancy).not.toHaveBeenCalled()
      expect(appointmentStaffAssignmentService.resolveStaffAssignment).not.toHaveBeenCalled()
      expect(targets).toHaveBeenCalled()
      expect(enqueue).toHaveBeenCalled()
      expect(prismaMock.slotHold.deleteMany).toHaveBeenCalledWith({ where: { id: holdId, venueId: VENUE_ID } })
      expect(prismaMock.reservation.create.mock.invocationCallOrder[0]).toBeLessThan(
        prismaMock.slotHold.deleteMany.mock.invocationCallOrder[0],
      )
      expect(prismaMock.reservationModifier.createMany.mock.invocationCallOrder[0]).toBeLessThan(
        prismaMock.slotHold.deleteMany.mock.invocationCallOrder[0],
      )
      expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.slotHold.deleteMany.mock.invocationCallOrder[0])
    })

    it('revalidates the exact held staff without allocator or global occupancy', async () => {
      const { resolveStaff: allocator, occupancy } = await arrangeStaffAwareAppointment({
        pacingMaxPerSlot: 1,
        showStaffPicker: true,
      })
      const eligible = jest.spyOn(appointmentStaffAssignmentService, 'assertStaffEligible').mockResolvedValue()
      prismaMock.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'hold-staff',
            venueId: VENUE_ID,
            startsAt: appointmentInput.startsAt,
            endsAt: appointmentInput.endsAt,
            productIds: ['prod-1'],
            classSessionId: null,
            staffId: 'staff-held',
            heldForReservationId: null,
            windowSemantics: 'base',
            expiresAt: new Date('2099-03-01T13:00:00.000Z'),
          },
        ] as any)
        .mockResolvedValue([])

      const created = await createReservation(VENUE_ID, appointmentInput, {
        writeOrigin: 'PUBLIC',
        windowSemantics: 'base',
        appointmentHoldId: 'hold-staff',
      })

      expect(eligible).toHaveBeenCalledWith(prismaMock, expect.objectContaining({ staffId: 'staff-held', excludeHoldId: 'hold-staff' }))
      expect(allocator).not.toHaveBeenCalled()
      expect(occupancy).not.toHaveBeenCalled()
      expect(created.assignedStaffId).toBe('staff-held')
    })

    it('repeats the locked hold and exact staff/external authority after a serialization retry', async () => {
      const {
        lock,
        resolveStaff: allocator,
        occupancy,
      } = await arrangeStaffAwareAppointment({
        pacingMaxPerSlot: 1,
        showStaffPicker: true,
      })
      const settingsSpy = jest.mocked(reservationSettingsService.getReservationSettings)
      const eligible = jest.spyOn(appointmentStaffAssignmentService, 'assertStaffEligible').mockResolvedValue()
      const holdRow = {
        id: 'hold-retry',
        venueId: VENUE_ID,
        startsAt: appointmentInput.startsAt,
        endsAt: appointmentInput.endsAt,
        productIds: ['prod-1'],
        classSessionId: null,
        staffId: 'staff-held',
        heldForReservationId: null,
        windowSemantics: 'base',
        expiresAt: new Date('2099-03-01T13:00:00.000Z'),
      }
      prismaMock.$queryRaw
        .mockResolvedValueOnce([holdRow] as any)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([holdRow] as any)
        .mockResolvedValueOnce([])
      prismaMock.reservation.create
        .mockRejectedValueOnce(Object.assign(new Error('retry'), { code: 'P2034' }))
        .mockImplementationOnce(async ({ data }: any) => createMockReservation(data))

      const created = await createReservation(VENUE_ID, appointmentInput, {
        writeOrigin: 'PUBLIC',
        windowSemantics: 'base',
        appointmentHoldId: 'hold-retry',
      })

      expect(settingsSpy).toHaveBeenCalledTimes(2)
      expect(lock).toHaveBeenCalledTimes(2)
      expect(eligible).toHaveBeenCalledTimes(2)
      expect(prismaMock.externalBusyBlock.findFirst).toHaveBeenCalledTimes(2)
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(4)
      expect(allocator).not.toHaveBeenCalled()
      expect(occupancy).not.toHaveBeenCalled()
      expect(prismaMock.slotHold.deleteMany).toHaveBeenCalledTimes(1)
      expect(created.assignedStaffId).toBe('staff-held')
    })

    it.each(['P2034', '55P03'])('repeats settings, lock, clock, and assignment after a %s retry', async code => {
      const settingsSpy = jest.spyOn(reservationSettingsService, 'getReservationSettings')
      const { lock, resolveStaff } = await arrangeStaffAwareAppointment({ pacingMaxPerSlot: 2 })
      const retryable = Object.assign(new Error('retryable create'), { code })
      prismaMock.reservation.create
        .mockRejectedValueOnce(retryable)
        .mockImplementationOnce(async ({ data }: any) => createMockReservation(data))

      await createReservation(VENUE_ID, appointmentInput, { writeOrigin: 'MCP', windowSemantics: 'base' })

      expect(settingsSpy).toHaveBeenCalledTimes(2)
      expect(lock).toHaveBeenCalledTimes(2)
      expect(resolveStaff).toHaveBeenCalledTimes(2)
      expect(resolveStaff.mock.calls[0][1].checkedAt).not.toBe(resolveStaff.mock.calls[1][1].checkedAt)
    })

    it('uses the resolved Staff.id for persistence, calendar targets, response, and the post-commit log', async () => {
      const { resolveStaff } = await arrangeStaffAwareAppointment({ resolvedStaffId: 'staff-effective', pacingMaxPerSlot: 2 })
      const targets = jest.spyOn(calendarOutboxService, 'resolveReservationPushTargets').mockResolvedValue([])
      const info = jest.spyOn(logger, 'info').mockImplementation(() => logger)

      const created = await createReservation(VENUE_ID, appointmentInput, { writeOrigin: 'MCP', windowSemantics: 'base' })

      expect(resolveStaff).toHaveBeenCalled()
      expect(prismaMock.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ assignedStaffId: 'staff-effective' }) }),
      )
      expect(targets).toHaveBeenCalledWith(prismaMock, { venueId: VENUE_ID, assignedStaffId: 'staff-effective' })
      expect(created.assignedStaffId).toBe('staff-effective')
      expect(info).toHaveBeenCalledWith(expect.stringContaining('staff=staff-effective'))
    })

    it('keeps legacy dashboard appointment creates ungated and ignores consent', async () => {
      jest
        .spyOn(reservationSettingsService, 'getReservationSettings')
        .mockResolvedValue(makeReservationSettings({ capacityMode: 'pacing', pacingMaxPerSlot: 1 }))
      prismaMock.product.findFirst.mockResolvedValue({
        id: 'prod-1',
        price: new Prisma.Decimal(100),
        eventCapacity: null,
        type: 'APPOINTMENTS_SERVICE',
      } as any)
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))
      const occupancy = jest.spyOn(reservationAvailabilityService, 'countAppointmentOccupancy')

      const result = await createReservation(
        VENUE_ID,
        { ...appointmentInput, productIds: undefined },
        { writeOrigin: 'DASHBOARD', allowOverCapacity: true },
      )

      expect(occupancy).not.toHaveBeenCalled()
      expect(result).not.toHaveProperty('overCapacity')
    })

    it.each(['PUBLIC', 'CONSUMER', 'MCP'] as const)(
      'floors legacy null pacing to one and runs a hard non-confirmable occupancy gate for %s',
      async writeOrigin => {
        jest
          .spyOn(reservationSettingsService, 'getReservationSettings')
          .mockResolvedValue(makeReservationSettings({ capacityMode: 'pacing', pacingMaxPerSlot: null }))
        prismaMock.product.findFirst.mockResolvedValue({
          id: 'prod-1',
          price: new Prisma.Decimal(100),
          eventCapacity: null,
          type: 'APPOINTMENTS_SERVICE',
        } as any)
        prismaMock.reservation.findUnique.mockResolvedValue(null)
        prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))
        const occupancy = jest
          .spyOn(reservationAvailabilityService, 'countAppointmentOccupancy')
          .mockResolvedValue({ reservations: 1, holds: 0 })

        const error = await createReservation(VENUE_ID, { ...appointmentInput, productIds: undefined }, { writeOrigin }).catch(
          reason => reason,
        )

        expect(error).toMatchObject({ statusCode: 409, code: undefined, details: undefined })
        expect(error.message).toMatch(/horario/i)
        expect(occupancy).toHaveBeenCalled()
        expect(prismaMock.reservation.create).not.toHaveBeenCalled()
      },
    )

    it('treats staff-aware null pacing as unlimited without combining it with the resource gate', async () => {
      const { occupancy } = await arrangeStaffAwareAppointment({ pacingMaxPerSlot: null, resolvedStaffId: 'staff-b' })

      const result = await createReservation(VENUE_ID, appointmentInput, { writeOrigin: 'PUBLIC', windowSemantics: 'base' })

      expect(result.assignedStaffId).toBe('staff-b')
      expect(occupancy).not.toHaveBeenCalled()
      expect(result).not.toHaveProperty('overCapacity')
    })

    it('allows A-busy/B-free assignment at pacing two and keeps resource and global capacity independent', async () => {
      const { occupancy } = await arrangeStaffAwareAppointment({
        pacingMaxPerSlot: 2,
        resolvedStaffId: 'staff-b',
        occupancy: { reservations: 1, holds: 0 },
      })

      const result = await createReservation(VENUE_ID, appointmentInput, { writeOrigin: 'PUBLIC', windowSemantics: 'base' })

      expect(occupancy).toHaveBeenCalled()
      expect(result.assignedStaffId).toBe('staff-b')
    })

    it('rejects busy requested staff before the confirmable global gate even with dashboard consent', async () => {
      const { resolveStaff, occupancy } = await arrangeStaffAwareAppointment({
        pacingMaxPerSlot: 1,
        occupancy: { reservations: 1, holds: 0 },
      })
      resolveStaff.mockRejectedValue(new ConflictError('El profesionista no está disponible en ese horario'))

      await expect(
        createReservation(
          VENUE_ID,
          { ...appointmentInput, assignedStaffId: 'staff-busy' },
          { writeOrigin: 'DASHBOARD', windowSemantics: 'base', allowOverCapacity: true },
        ),
      ).rejects.toThrow(/profesionista/i)

      expect(occupancy).not.toHaveBeenCalled()
      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    })

    it('returns the exact dashboard confirmation conflict before writes when staff-aware global pacing is full', async () => {
      await arrangeStaffAwareAppointment({ pacingMaxPerSlot: 2, occupancy: { reservations: 1, holds: 1 } })

      const error = await createReservation(VENUE_ID, appointmentInput, {
        writeOrigin: 'DASHBOARD',
        windowSemantics: 'base',
      }).catch(reason => reason)

      expect(error).toMatchObject({
        statusCode: 409,
        message: 'El horario está lleno. Confirma si deseas sobre-agendar.',
        code: 'OVER_CAPACITY_CONFIRMATION_REQUIRED',
        details: {
          preview: {
            startsAt: appointmentInput.startsAt,
            endsAt: appointmentInput.endsAt,
            occupancy: 2,
            limit: 2,
          },
        },
      })
      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
      expect(prismaMock.reservationModifier.createMany).not.toHaveBeenCalled()
      expect(prismaMock.calendarSyncOutbox.create).not.toHaveBeenCalled()
    })

    it('returns overCapacity only when a staff-aware dashboard explicitly consents to an actually full global slot', async () => {
      await arrangeStaffAwareAppointment({ pacingMaxPerSlot: 1, occupancy: { reservations: 1, holds: 0 } })

      const result = await createReservation(VENUE_ID, appointmentInput, {
        writeOrigin: 'DASHBOARD',
        windowSemantics: 'base',
        allowOverCapacity: true,
      })

      expect(result).toMatchObject({ assignedStaffId: 'staff-resolved', overCapacity: true })
    })

    it.each(['PUBLIC', 'CONSUMER', 'MCP'] as const)(
      'returns a hard non-confirmable staff-aware 409 for full %s creates',
      async writeOrigin => {
        await arrangeStaffAwareAppointment({ pacingMaxPerSlot: 1, occupancy: { reservations: 1, holds: 0 } })

        const error = await createReservation(VENUE_ID, appointmentInput, {
          writeOrigin,
          windowSemantics: 'base',
        }).catch(reason => reason)

        expect(error).toMatchObject({ statusCode: 409, code: undefined, details: undefined })
        expect(prismaMock.reservation.create).not.toHaveBeenCalled()
      },
    )

    it('keeps WALK_IN subject to staff and global capacity despite its notice exemption', async () => {
      await arrangeStaffAwareAppointment({ pacingMaxPerSlot: 1, occupancy: { reservations: 1, holds: 0 } })

      await expect(
        createReservation(VENUE_ID, { ...appointmentInput, channel: 'WALK_IN' }, { writeOrigin: 'DASHBOARD', windowSemantics: 'base' }),
      ).rejects.toMatchObject({ code: 'OVER_CAPACITY_CONFIRMATION_REQUIRED' })
      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    })

    it.each(['PUBLIC', 'CONSUMER'] as const)('rejects %s staff selection when the authoritative picker is off', async writeOrigin => {
      jest
        .spyOn(reservationSettingsService, 'getReservationSettings')
        .mockResolvedValue(makeReservationSettings({ capacityMode: 'per_staff', showStaffPicker: false }))
      prismaMock.product.findFirst.mockResolvedValue({
        id: 'prod-1',
        price: new Prisma.Decimal(100),
        eventCapacity: null,
        type: 'APPOINTMENTS_SERVICE',
      } as any)
      prismaMock.product.findMany.mockResolvedValue([{ id: 'prod-1', duration: 60, durationMinutes: null }] as any)
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))

      await expect(
        createReservation(VENUE_ID, { ...appointmentInput, productIds: undefined, assignedStaffId: 'staff-requested' }, { writeOrigin }),
      ).rejects.toMatchObject({ statusCode: 400 })
      expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    })

    it.each([
      ['DASHBOARD', 0],
      ['MCP', 1],
    ] as const)(
      'keeps legacy %s staff selection but applies the organization-wide personal gate',
      async (writeOrigin, expectedOccupancyCalls) => {
        jest
          .spyOn(reservationSettingsService, 'getReservationSettings')
          .mockResolvedValue(makeReservationSettings({ capacityMode: 'pacing', showStaffPicker: false }))
        prismaMock.product.findFirst.mockResolvedValue({
          id: 'prod-1',
          price: new Prisma.Decimal(100),
          eventCapacity: null,
          type: 'APPOINTMENTS_SERVICE',
        } as any)
        prismaMock.staffVenue.findFirst.mockResolvedValue({
          id: 'sv-1',
          staffId: 'staff-operated',
          venue: { organizationId: 'org-1' },
        } as any)
        prismaMock.reservation.findUnique.mockResolvedValue(null)
        prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))
        const organizationGate = jest.spyOn(appointmentStaffAssignmentService, 'assertOrganizationStaffAvailability').mockResolvedValue()
        const assignment = jest.spyOn(appointmentStaffAssignmentService, 'resolveStaffAssignment')
        const occupancy = jest
          .spyOn(reservationAvailabilityService, 'countAppointmentOccupancy')
          .mockResolvedValue({ reservations: 0, holds: 0 })

        await createReservation(
          VENUE_ID,
          { ...appointmentInput, productIds: undefined, assignedStaffId: 'staff-operated' },
          { writeOrigin },
        )

        expect(organizationGate).toHaveBeenCalledWith(
          prismaMock,
          expect.objectContaining({ organizationId: 'org-1', staffId: 'staff-operated' }),
        )
        expect(occupancy).toHaveBeenCalledTimes(expectedOccupancyCalls)
        expect(assignment).not.toHaveBeenCalled()
        expect(prismaMock.productStaff.findMany).not.toHaveBeenCalled()
        expect(prismaMock.staffSchedule.findFirst).not.toHaveBeenCalled()
      },
    )

    it('gives assigned non-appointments only the legacy membership and organization-wide personal gate', async () => {
      jest
        .spyOn(reservationSettingsService, 'getReservationSettings')
        .mockResolvedValue(makeReservationSettings({ capacityMode: 'per_staff', pacingMaxPerSlot: 1 }))
      prismaMock.staffVenue.findFirst.mockResolvedValue({
        id: 'sv-1',
        staffId: 'staff-table',
        venue: { organizationId: 'org-1' },
      } as any)
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create.mockImplementation(async ({ data }: any) => createMockReservation(data))
      const organizationGate = jest.spyOn(appointmentStaffAssignmentService, 'assertOrganizationStaffAvailability').mockResolvedValue()
      const lock = jest.spyOn(appointmentStaffAssignmentService, 'lockAppointmentVenue')
      const assignment = jest.spyOn(appointmentStaffAssignmentService, 'resolveStaffAssignment')
      const occupancy = jest.spyOn(reservationAvailabilityService, 'countAppointmentOccupancy')

      await createReservation(
        VENUE_ID,
        {
          startsAt: appointmentInput.startsAt,
          endsAt: appointmentInput.endsAt,
          duration: 60,
          tableId: 'table-1',
          assignedStaffId: 'staff-table',
        },
        DASHBOARD_WRITE,
      )

      expect(organizationGate).toHaveBeenCalledWith(
        prismaMock,
        expect.objectContaining({
          organizationId: 'org-1',
          staffId: 'staff-table',
          startsAt: appointmentInput.startsAt,
          endsAt: appointmentInput.endsAt,
        }),
      )
      expect(lock).not.toHaveBeenCalled()
      expect(assignment).not.toHaveBeenCalled()
      expect(occupancy).not.toHaveBeenCalled()
    })

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
        DASHBOARD_WRITE,
        STAFF_ID,
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
      jest.spyOn(reservationSettingsService, 'getReservationSettings').mockResolvedValue(makeReservationSettings({ autoConfirm: false }))

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
        DASHBOARD_WRITE,
        STAFF_ID,
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
          DASHBOARD_WRITE,
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
          DASHBOARD_WRITE,
          STAFF_ID,
        ),
      ).rejects.toThrow(ConflictError)
    })

    it('should throw ConflictError when product capacity is full', async () => {
      jest
        .spyOn(reservationSettingsService, 'getReservationSettings')
        .mockResolvedValue(makeReservationSettings({ onlineCapacityPercent: 100 }))
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
          DASHBOARD_WRITE,
          STAFF_ID,
        ),
      ).rejects.toThrow(ConflictError)
    })

    // ============================================================
    // ExternalBusyBlock integration (Phase 1 — Task 24)
    // ============================================================

    it('should throw ConflictError when ExternalBusyBlock overlaps (venue-master)', async () => {
      prismaMock.externalBusyBlock.findFirst.mockResolvedValue({
        id: 'block-1',
        venueId: VENUE_ID,
        staffId: null,
        startsAt: new Date('2026-03-01T14:00:00Z'),
        endsAt: new Date('2026-03-01T15:00:00Z'),
      })

      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt: new Date('2026-03-01T15:00:00Z'),
            duration: 60,
            tableId: 'table-1',
          },
          DASHBOARD_WRITE,
          STAFF_ID,
        ),
      ).rejects.toThrow(ConflictError)
      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt: new Date('2026-03-01T15:00:00Z'),
            duration: 60,
            tableId: 'table-1',
          },
          DASHBOARD_WRITE,
          STAFF_ID,
        ),
      ).rejects.toThrow(/calendario externo/)
    })

    it('should throw ConflictError when ExternalBusyBlock overlaps (staff-personal)', async () => {
      prismaMock.externalBusyBlock.findFirst.mockResolvedValueOnce({
        id: 'block-2',
        venueId: null,
        staffId: 'staff-1',
        startsAt: new Date('2026-03-01T14:00:00Z'),
        endsAt: new Date('2026-03-01T15:00:00Z'),
      })

      await expect(
        createReservation(
          VENUE_ID,
          {
            startsAt: new Date('2026-03-01T14:00:00Z'),
            endsAt: new Date('2026-03-01T15:00:00Z'),
            duration: 60,
            assignedStaffId: 'staff-1',
          },
          DASHBOARD_WRITE,
          STAFF_ID,
        ),
      ).rejects.toThrow(ConflictError)
    })

    it('REGRESSION: succeeds when no ExternalBusyBlock matches', async () => {
      prismaMock.externalBusyBlock.findFirst.mockResolvedValueOnce(null)
      const mockCreated = createMockReservation()
      prismaMock.reservation.create.mockResolvedValue(mockCreated)
      prismaMock.reservation.findUnique.mockResolvedValue(null) // unique code

      const result = await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
          tableId: 'table-1',
        },
        DASHBOARD_WRITE,
        STAFF_ID,
      )

      expect(result).toBeDefined()
      expect(prismaMock.reservation.create).toHaveBeenCalled()
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
      jest.spyOn(reservationSettingsService, 'getReservationSettings').mockResolvedValue(
        makeReservationSettings({
          deposits: {
            enabled: true,
            mode: 'deposit',
            fixedAmount: 200,
            percentageOfTotal: null,
            requiredForPartySizeGte: 5,
          },
        }),
      )

      await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
          partySize: 6,
        },
        DASHBOARD_WRITE,
        STAFF_ID,
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
      jest.spyOn(reservationSettingsService, 'getReservationSettings').mockResolvedValue(
        makeReservationSettings({
          deposits: {
            enabled: true,
            mode: 'deposit',
            fixedAmount: 200,
            percentageOfTotal: null,
            requiredForPartySizeGte: 5,
          },
        }),
      )

      await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
          partySize: 2,
        },
        DASHBOARD_WRITE,
        STAFF_ID,
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
      const serializationError = Object.assign(new Error('Serialization conflict'), { code: 'P2034' })
      const settingsSpy = jest
        .spyOn(reservationSettingsService, 'getReservationSettings')
        .mockResolvedValueOnce(makeReservationSettings({ autoConfirm: true }))
        .mockResolvedValueOnce(makeReservationSettings({ autoConfirm: false }))
      prismaMock.$queryRaw.mockResolvedValue([])
      prismaMock.reservation.findUnique.mockResolvedValue(null)
      prismaMock.reservation.create
        .mockRejectedValueOnce(serializationError)
        .mockImplementationOnce(async ({ data }: any) => createMockReservation(data))

      const result = await createReservation(
        VENUE_ID,
        {
          startsAt: new Date('2026-03-01T14:00:00Z'),
          endsAt: new Date('2026-03-01T15:00:00Z'),
          duration: 60,
        },
        DASHBOARD_WRITE,
        STAFF_ID,
      )

      expect(result).toBeDefined()
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
      expect(settingsSpy).toHaveBeenCalledTimes(2)
      expect(prismaMock.reservation.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }),
      )
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

    // Regression — multi-service appointments store the lead service in
    // productId and the full ordered list in productIds[] (scalar text[], not a
    // relation). Before `attachServices`, only the lead `product` was returned
    // so the 2nd service silently disappeared from the dashboard detail.
    it('resolves the full ordered service list from productIds (multi-service)', async () => {
      const mockRes = createMockReservation({
        productId: 'p-baby',
        productIds: ['p-baby', 'p-manipedi'],
        product: { id: 'p-baby', name: 'Baby Boomer', price: new Prisma.Decimal(150) },
      })
      prismaMock.reservation.findFirst.mockResolvedValue(mockRes)
      // findMany returns unordered — attachServices must re-order to productIds
      prismaMock.product.findMany.mockResolvedValue([
        { id: 'p-manipedi', name: 'Manicure + Pedicure + Spa', price: new Prisma.Decimal(800), duration: 70 },
        { id: 'p-baby', name: 'Baby Boomer', price: new Prisma.Decimal(150), duration: 25 },
      ] as any)

      const result = await getReservationById(VENUE_ID, 'res-1')

      expect(result.services.map(s => s.name)).toEqual(['Baby Boomer', 'Manicure + Pedicure + Spa'])
      expect(result.services.map(s => s.duration)).toEqual([25, 70])
      expect(prismaMock.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['p-baby', 'p-manipedi'] } } }))
    })

    it('falls back to the single productId when productIds is empty (legacy single-service)', async () => {
      const mockRes = createMockReservation({
        productId: 'p-legacy',
        product: { id: 'p-legacy', name: 'Corte', price: new Prisma.Decimal(200) },
      })
      prismaMock.reservation.findFirst.mockResolvedValue(mockRes)
      prismaMock.product.findMany.mockResolvedValue([
        { id: 'p-legacy', name: 'Corte', price: new Prisma.Decimal(200), duration: 30 },
      ] as any)

      const result = await getReservationById(VENUE_ID, 'res-1')

      expect(result.services.map(s => s.name)).toEqual(['Corte'])
      expect(prismaMock.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['p-legacy'] } } }))
    })

    it('returns an empty service list for table-only reservations (no product lookup)', async () => {
      const mockRes = createMockReservation() // productId null, no productIds
      prismaMock.reservation.findFirst.mockResolvedValue(mockRes)

      const result = await getReservationById(VENUE_ID, 'res-1')

      expect(result.services).toEqual([])
      expect(prismaMock.product.findMany).not.toHaveBeenCalled()
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
        prismaMock.reservation.findUniqueOrThrow.mockResolvedValue(mockConfirmed)

        const result = await confirmReservation(VENUE_ID, 'res-1', STAFF_ID)

        expect(result.status).toBe('CONFIRMED')
        expect(prismaMock.reservation.updateMany).toHaveBeenCalledWith(
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
        prismaMock.reservation.findUniqueOrThrow.mockResolvedValue(createMockReservation({ status: 'CHECKED_IN' }))

        const result = await checkInReservation(VENUE_ID, 'res-1', STAFF_ID)

        expect(result.status).toBe('CHECKED_IN')
        expect(prismaMock.reservation.updateMany).toHaveBeenCalledWith(
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

      // Additive contract — the check-in response must carry the full booked
      // services[] (not just the lead `product`) so the POS can print one
      // comanda per service, without losing anything it already returned.
      it('includes services[] for ALL booked productIds on check-in (multi-service)', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(
          createMockReservation({ status: 'CONFIRMED', productId: 'p-baby', productIds: ['p-baby', 'p-manipedi'] }),
        )
        prismaMock.reservation.update.mockResolvedValue(
          createMockReservation({ status: 'CHECKED_IN', productId: 'p-baby', productIds: ['p-baby', 'p-manipedi'] }),
        )
        prismaMock.reservation.findUniqueOrThrow.mockResolvedValue(
          createMockReservation({ status: 'CHECKED_IN', productId: 'p-baby', productIds: ['p-baby', 'p-manipedi'] }),
        )
        prismaMock.product.findMany.mockResolvedValue([
          { id: 'p-manipedi', name: 'Manicure + Pedicure + Spa', price: new Prisma.Decimal(800), duration: 70 },
          { id: 'p-baby', name: 'Baby Boomer', price: new Prisma.Decimal(150), duration: 25 },
        ] as any)

        const result = await checkInReservation(VENUE_ID, 'res-1', STAFF_ID)

        expect(result.services.map((s: any) => s.name)).toEqual(['Baby Boomer', 'Manicure + Pedicure + Spa'])
        expect(prismaMock.product.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: { in: ['p-baby', 'p-manipedi'] } } }),
        )
      })

      // Regression guard — the additive change must not drop orderId or any
      // pre-existing field the dashboard already consumes from this response.
      it('still returns orderId and pre-existing fields alongside the new services[]', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'CONFIRMED' }))
        prismaMock.reservation.update.mockResolvedValue(createMockReservation({ status: 'CHECKED_IN' }))
        prismaMock.reservation.findUniqueOrThrow.mockResolvedValue(createMockReservation({ status: 'CHECKED_IN' }))

        const result = await checkInReservation(VENUE_ID, 'res-1', STAFF_ID)

        expect(result.status).toBe('CHECKED_IN')
        expect(result.confirmationCode).toBe('RES-ABC123')
        expect(result).toHaveProperty('orderId')
        expect(result.services).toEqual([]) // table-only reservation, no productId/productIds
      })
    })

    describe('completeReservation', () => {
      it('should transition CHECKED_IN -> COMPLETED', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'CHECKED_IN' }))
        prismaMock.reservation.update.mockResolvedValue(createMockReservation({ status: 'COMPLETED' }))
        prismaMock.reservation.findUniqueOrThrow.mockResolvedValue(createMockReservation({ status: 'COMPLETED' }))

        const result = await completeReservation(VENUE_ID, 'res-1')

        expect(result.status).toBe('COMPLETED')
        expect(prismaMock.reservation.updateMany).toHaveBeenCalledWith(
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
        prismaMock.reservation.findUniqueOrThrow.mockResolvedValue(createMockReservation({ status: 'NO_SHOW' }))

        const result = await markNoShow(VENUE_ID, 'res-1', STAFF_ID)

        expect(result.status).toBe('NO_SHOW')
        expect(prismaMock.reservation.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: 'NO_SHOW',
              noShowAt: expect.any(Date),
            }),
          }),
        )
      })

      // PENDING -> NO_SHOW is intentionally allowed so the auto-no-show worker
      // can mark unconfirmed reservations whose customer never arrived (e.g.
      // autoConfirm=false venues, or unpaid-deposit reservations past startsAt).
      it('should transition PENDING -> NO_SHOW (unconfirmed customer never arrived)', async () => {
        prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'PENDING' }))
        prismaMock.reservation.update.mockResolvedValue(createMockReservation({ status: 'NO_SHOW' }))
        prismaMock.reservation.findUniqueOrThrow.mockResolvedValue(createMockReservation({ status: 'NO_SHOW' }))

        const result = await markNoShow(VENUE_ID, 'res-1', STAFF_ID)

        expect(result.status).toBe('NO_SHOW')
        expect(prismaMock.reservation.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: 'NO_SHOW',
              noShowAt: expect.any(Date),
            }),
          }),
        )
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
        prismaMock.reservation.findUniqueOrThrow.mockResolvedValue(
          createMockReservation({
            status: 'CANCELLED',
            cancelledBy: 'CUSTOMER',
            cancellationReason: 'Changed plans',
          }),
        )

        const result = await cancelReservation(VENUE_ID, 'res-1', 'CUSTOMER', 'Changed plans')

        expect(result.status).toBe('CANCELLED')
        expect(prismaMock.reservation.updateMany).toHaveBeenCalledWith(
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
        prismaMock.reservation.findUniqueOrThrow.mockResolvedValue(createMockReservation({ status: 'CANCELLED' }))

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
    beforeEach(() => {
      jest.spyOn(appointmentSlotHoldService, 'lockReservationForReschedule').mockResolvedValue({
        id: 'res-1',
        venueId: VENUE_ID,
        startsAt: new Date('2026-03-01T14:00:00Z'),
        endsAt: new Date('2026-03-01T15:00:00Z'),
        duration: 60,
        productId: null,
        productIds: [],
        tableId: null,
        assignedStaffId: null,
        partySize: 2,
        classSessionId: null,
        status: 'CONFIRMED',
      })
      jest.spyOn(calendarOutboxService, 'resolveReservationPushTargets').mockResolvedValue([])
    })

    it.each([
      ['startsAt', { startsAt: new Date('2026-03-01T13:30:00Z') }],
      ['endsAt', { endsAt: new Date('2026-03-01T15:30:00Z') }],
      ['duration', { duration: 61 }],
      ['productId', { productId: 'prod-1' }],
      ['assignedStaffId', { assignedStaffId: 'staff-2' }],
    ])('invalidates tagged reschedule holds atomically when effective %s changes', async (_field, input) => {
      const existing = createMockReservation()
      prismaMock.reservation.findFirst.mockResolvedValue(existing)
      prismaMock.reservation.update.mockResolvedValue({ ...existing, ...input } as any)

      await updateReservation(VENUE_ID, 'res-1', input, DASHBOARD_WRITE, STAFF_ID)

      const venueLock = appointmentStaffAssignmentService.lockAppointmentVenue as jest.Mock
      const reservationLock = appointmentSlotHoldService.lockReservationForReschedule as jest.Mock
      const siblingCallIndex = prismaMock.$queryRaw.mock.calls.findIndex((call: unknown[]) =>
        (call[0] as TemplateStringsArray).join('?').match(/FROM "SlotHold"[\s\S]*heldForReservationId[\s\S]*ORDER BY id[\s\S]*FOR UPDATE/i),
      )
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
      expect(siblingCallIndex).toBeGreaterThanOrEqual(0)
      expect(prismaMock.$queryRaw.mock.calls[siblingCallIndex].slice(1)).toEqual([VENUE_ID, 'res-1'])
      expect(prismaMock.slotHold.deleteMany).toHaveBeenCalledWith({
        where: { venueId: VENUE_ID, heldForReservationId: 'res-1' },
      })
      expect(venueLock.mock.invocationCallOrder[0]).toBeLessThan(reservationLock.mock.invocationCallOrder[0])
      expect(reservationLock.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.$queryRaw.mock.invocationCallOrder[siblingCallIndex])
      expect(prismaMock.$queryRaw.mock.invocationCallOrder[siblingCallIndex]).toBeLessThan(
        prismaMock.slotHold.deleteMany.mock.invocationCallOrder[0],
      )
      expect(prismaMock.slotHold.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        prismaMock.reservation.update.mock.invocationCallOrder[0],
      )
    })

    it('keeps tagged holds when supplied identity fields have the same effective values', async () => {
      const existing = createMockReservation()
      prismaMock.reservation.findFirst.mockResolvedValue(existing)
      prismaMock.reservation.update.mockResolvedValue(existing)

      await updateReservation(
        VENUE_ID,
        'res-1',
        {
          startsAt: existing.startsAt,
          endsAt: existing.endsAt,
          duration: existing.duration,
          productId: existing.productId,
          assignedStaffId: existing.assignedStaffId,
        },
        DASHBOARD_WRITE,
        STAFF_ID,
      )

      expect(appointmentStaffAssignmentService.lockAppointmentVenue).toHaveBeenCalledTimes(1)
      expect(appointmentSlotHoldService.lockReservationForReschedule).toHaveBeenCalledTimes(1)
      expect(
        prismaMock.$queryRaw.mock.calls.some((call: unknown[]) =>
          (call[0] as TemplateStringsArray).join('?').match(/FROM "SlotHold"[\s\S]*heldForReservationId/i),
        ),
      ).toBe(false)
      expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
    })

    it.each([
      ['metadata', { guestName: 'Nombre actualizado' }],
      ['party size', { partySize: 3 }],
    ])('preserves tagged holds for a %s-only update', async (_label, input) => {
      const existing = createMockReservation()
      prismaMock.reservation.findFirst.mockResolvedValue(existing)
      prismaMock.reservation.update.mockResolvedValue({ ...existing, ...input } as any)

      await updateReservation(VENUE_ID, 'res-1', input, DASHBOARD_WRITE, STAFF_ID)

      expect(appointmentStaffAssignmentService.lockAppointmentVenue).not.toHaveBeenCalled()
      expect(appointmentSlotHoldService.lockReservationForReschedule).not.toHaveBeenCalled()
      expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
    })

    it('re-reads settings after a retry before applying the successful event-capacity policy', async () => {
      const settingsSpy = jest
        .spyOn(reservationSettingsService, 'getReservationSettings')
        .mockResolvedValueOnce(makeReservationSettings({ onlineCapacityPercent: 25 }))
        .mockResolvedValueOnce(makeReservationSettings({ onlineCapacityPercent: 100 }))
      const serializationError = Object.assign(new Error('serialization conflict'), { code: 'P2034' })
      const existing = createMockReservation({ status: 'CONFIRMED', tableId: null, productId: 'prod-1', partySize: 20 })
      prismaMock.reservation.findFirst.mockResolvedValue(existing)
      prismaMock.product.findFirst.mockResolvedValue({
        id: 'prod-1',
        price: new Prisma.Decimal(100),
        eventCapacity: 100,
      })
      prismaMock.externalBusyBlock.findFirst.mockRejectedValueOnce(serializationError).mockResolvedValueOnce(null)
      prismaMock.$queryRaw.mockResolvedValue([{ partySize: 35 }])
      prismaMock.reservation.update.mockResolvedValue(existing)

      await expect(updateReservation(VENUE_ID, 'res-1', { guestName: 'Updated' }, DASHBOARD_WRITE, STAFF_ID)).resolves.toBeDefined()

      expect(settingsSpy).toHaveBeenCalledTimes(2)
      expect(prismaMock.reservation.update).toHaveBeenCalledTimes(1)
    })

    it('emits the successful update log once when a completed transaction attempt is retried', async () => {
      const settingsSpy = jest
        .spyOn(reservationSettingsService, 'getReservationSettings')
        .mockResolvedValueOnce(makeReservationSettings({ onlineCapacityPercent: 75 }))
        .mockResolvedValueOnce(makeReservationSettings({ onlineCapacityPercent: 100 }))
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger)
      const serializationError = Object.assign(new Error('serialization conflict'), { code: 'P2034' })
      const existing = createMockReservation({ status: 'CONFIRMED', tableId: null, productId: null, assignedStaffId: null })
      let attempts = 0
      prismaMock.$transaction.mockImplementation(async (fn: any) => {
        const result = await fn(prismaMock)
        attempts += 1
        if (attempts === 1) throw serializationError
        return result
      })
      prismaMock.reservation.findFirst.mockResolvedValue(existing)
      prismaMock.reservation.update.mockResolvedValue(existing)

      await updateReservation(VENUE_ID, 'res-1', { guestName: 'Updated' }, DASHBOARD_WRITE, STAFF_ID)

      expect(settingsSpy).toHaveBeenCalledTimes(2)
      expect(prismaMock.reservation.update).toHaveBeenCalledTimes(2)
      expect(infoSpy.mock.calls.filter(([message]) => String(message).includes('[RESERVATION] Updated'))).toHaveLength(1)
    })

    it('should update allowed fields on CONFIRMED reservation', async () => {
      const existing = createMockReservation({ status: 'CONFIRMED' })
      const updated = createMockReservation({ status: 'CONFIRMED', guestName: 'Updated Name', partySize: 4 })

      prismaMock.reservation.findFirst.mockResolvedValueOnce(existing)
      prismaMock.reservation.update.mockResolvedValue(updated)
      prismaMock.reservation.findUniqueOrThrow.mockResolvedValue(updated)

      const result = await updateReservation(VENUE_ID, 'res-1', { guestName: 'Updated Name', partySize: 4 }, DASHBOARD_WRITE, STAFF_ID)

      expect(result.guestName).toBe('Updated Name')
      expect(result.partySize).toBe(4)
    })

    it('should reject updates on CHECKED_IN reservation', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'CHECKED_IN' }))

      await expect(updateReservation(VENUE_ID, 'res-1', { guestName: 'New' }, DASHBOARD_WRITE, STAFF_ID)).rejects.toThrow(BadRequestError)
    })

    it('should reject updates on COMPLETED reservation', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'COMPLETED' }))

      await expect(updateReservation(VENUE_ID, 'res-1', { guestName: 'New' }, DASHBOARD_WRITE, STAFF_ID)).rejects.toThrow(BadRequestError)
    })

    it('should reject updates on CANCELLED reservation', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(createMockReservation({ status: 'CANCELLED' }))

      await expect(updateReservation(VENUE_ID, 'res-1', { guestName: 'New' }, DASHBOARD_WRITE, STAFF_ID)).rejects.toThrow(BadRequestError)
    })

    it('should check table conflicts when changing table', async () => {
      const existing = createMockReservation({ status: 'CONFIRMED', tableId: 'table-1' })

      prismaMock.reservation.findFirst.mockResolvedValueOnce(existing)
      prismaMock.$queryRaw.mockResolvedValueOnce([{ id: 'other-res', confirmationCode: 'RES-OTHER' }])

      await expect(updateReservation(VENUE_ID, 'res-1', { tableId: 'table-2' }, DASHBOARD_WRITE, STAFF_ID)).rejects.toThrow(ConflictError)
    })

    it('should check staff conflicts when changing staff', async () => {
      const existing = createMockReservation({ status: 'CONFIRMED', assignedStaffId: null })

      prismaMock.reservation.findFirst.mockResolvedValueOnce(existing)
      prismaMock.$queryRaw
        .mockResolvedValueOnce([]) // table conflict check
        .mockResolvedValueOnce([{ id: 'other-res', confirmationCode: 'RES-OTHER' }]) // staff conflict check

      await expect(updateReservation(VENUE_ID, 'res-1', { assignedStaffId: 'staff-2' }, DASHBOARD_WRITE, STAFF_ID)).rejects.toThrow(
        ConflictError,
      )
    })

    it('should throw NotFoundError for nonexistent reservation', async () => {
      prismaMock.reservation.findFirst.mockResolvedValue(null)

      await expect(updateReservation(VENUE_ID, 'nonexistent', { guestName: 'New' }, DASHBOARD_WRITE, STAFF_ID)).rejects.toThrow(
        NotFoundError,
      )
    })

    // ============================================================
    // ExternalBusyBlock integration (Phase 1 — Task 25)
    // ============================================================

    it('should throw ConflictError when reschedule lands on an ExternalBusyBlock', async () => {
      const existing = createMockReservation({ status: 'CONFIRMED' })
      prismaMock.reservation.findFirst.mockResolvedValueOnce(existing)
      prismaMock.externalBusyBlock.findFirst.mockResolvedValueOnce({
        id: 'block-3',
        venueId: VENUE_ID,
        staffId: null,
        startsAt: new Date('2026-03-01T16:00:00Z'),
        endsAt: new Date('2026-03-01T17:00:00Z'),
      })

      await expect(
        updateReservation(
          VENUE_ID,
          'res-1',
          {
            startsAt: new Date('2026-03-01T16:00:00Z'),
            endsAt: new Date('2026-03-01T17:00:00Z'),
            duration: 60,
          },
          DASHBOARD_WRITE,
          STAFF_ID,
        ),
      ).rejects.toThrow(ConflictError)
    })

    it('REGRESSION: succeeds when no ExternalBusyBlock matches the new time', async () => {
      const existing = createMockReservation({ status: 'CONFIRMED' })
      const updated = createMockReservation({
        status: 'CONFIRMED',
        startsAt: new Date('2026-03-01T16:00:00Z'),
        endsAt: new Date('2026-03-01T17:00:00Z'),
      })

      prismaMock.reservation.findFirst.mockResolvedValueOnce(existing)
      prismaMock.externalBusyBlock.findFirst.mockResolvedValueOnce(null)
      prismaMock.reservation.update.mockResolvedValue(updated)
      prismaMock.reservation.findUniqueOrThrow.mockResolvedValue(updated)

      const result = await updateReservation(
        VENUE_ID,
        'res-1',
        {
          startsAt: new Date('2026-03-01T16:00:00Z'),
          endsAt: new Date('2026-03-01T17:00:00Z'),
          duration: 60,
        },
        DASHBOARD_WRITE,
        STAFF_ID,
      )

      expect(result).toBeDefined()
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
      jest.spyOn(appointmentSlotHoldService, 'lockReservationForReschedule').mockResolvedValue({
        id: existing.id,
        venueId: existing.venueId,
        startsAt: existing.startsAt,
        endsAt: existing.endsAt,
        duration: existing.duration,
        productId: existing.productId,
        productIds: existing.productIds,
        tableId: existing.tableId,
        assignedStaffId: existing.assignedStaffId,
        partySize: existing.partySize,
        classSessionId: null,
        status: existing.status,
      })

      prismaMock.reservation.findFirst
        .mockResolvedValueOnce(existing) // 1st: pre-update snapshot in rescheduleReservation
        .mockResolvedValueOnce(existing) // 2nd: lookup inside updateReservation transaction
      prismaMock.$queryRaw.mockResolvedValueOnce([]) // table conflict check
      prismaMock.reservation.update.mockResolvedValue(rescheduled)
      prismaMock.reservation.findUniqueOrThrow.mockResolvedValue(rescheduled)

      await rescheduleReservation(
        VENUE_ID,
        'res-1',
        {
          startsAt: new Date('2026-03-02T16:00:00Z'),
          endsAt: new Date('2026-03-02T17:30:00Z'),
        },
        DASHBOARD_WRITE,
        STAFF_ID,
      )

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
  // RESCHEDULE CLASS RESERVATION (public-facing)
  // ==========================================

  describe('rescheduleClassReservation', () => {
    const futureBase = Date.now() + 24 * 3_600_000 // tomorrow, well outside any window
    const oldStart = new Date(futureBase)
    const oldEnd = new Date(futureBase + 60 * 60_000)
    const newStart = new Date(futureBase + 4 * 3_600_000)
    const newEnd = new Date(futureBase + 5 * 3_600_000)

    function makeClassReservation(overrides: Record<string, any> = {}) {
      return createMockReservation({
        id: 'res-class-1',
        classSessionId: 'old-session',
        productId: 'prod-class',
        partySize: 2,
        spotIds: ['1', '2'],
        startsAt: oldStart,
        endsAt: oldEnd,
        ...overrides,
      })
    }

    function mockNewSession(overrides: Record<string, any> = {}) {
      return [
        {
          id: 'new-session',
          productId: 'prod-class',
          startsAt: newStart,
          endsAt: newEnd,
          duration: 60,
          capacity: 10,
          status: 'SCHEDULED',
          ...overrides,
        },
      ]
    }

    it('moves the reservation to the new session and never touches credit transactions', async () => {
      const reservationService = await import('@/services/dashboard/reservation.dashboard.service')
      prismaMock.reservation.findFirst.mockResolvedValueOnce(makeClassReservation())
      prismaMock.$queryRaw
        .mockResolvedValueOnce(mockNewSession()) // FOR UPDATE on new session
        .mockResolvedValueOnce([{ total: 0n }]) // enrolled count
      prismaMock.reservation.findMany.mockResolvedValue([]) // no spot collisions
      prismaMock.reservation.findUniqueOrThrow.mockResolvedValue(
        makeClassReservation({ classSessionId: 'new-session', startsAt: newStart, endsAt: newEnd }),
      )

      const result = await reservationService.rescheduleClassReservation({
        venueId: VENUE_ID,
        reservationId: 'res-class-1',
        newClassSessionId: 'new-session',
        rescheduledBy: 'CUSTOMER',
      })

      expect(result.classSessionId).toBe('new-session')
      // Critical: a reschedule MUST NOT create credit transactions (same product = same N credits)
      expect(prismaMock.creditTransaction.create).not.toHaveBeenCalled()
      // The atomic guard is enforced via updateMany with the previous status + classSessionId
      expect(prismaMock.reservation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'res-class-1',
            status: 'CONFIRMED',
            classSessionId: 'old-session',
          }),
          data: expect.objectContaining({
            classSessionId: 'new-session',
            startsAt: newStart,
            endsAt: newEnd,
          }),
        }),
      )
    })

    it('rejects swap to a different product with a clear message', async () => {
      const reservationService = await import('@/services/dashboard/reservation.dashboard.service')
      prismaMock.reservation.findFirst.mockResolvedValueOnce(makeClassReservation())
      prismaMock.$queryRaw.mockResolvedValueOnce(mockNewSession({ productId: 'OTHER-PRODUCT' }))

      await expect(
        reservationService.rescheduleClassReservation({
          venueId: VENUE_ID,
          reservationId: 'res-class-1',
          newClassSessionId: 'new-session',
          rescheduledBy: 'CUSTOMER',
        }),
      ).rejects.toThrow(/misma clase/i)
      expect(prismaMock.reservation.updateMany).not.toHaveBeenCalled()
    })

    it('rejects when the new session is full', async () => {
      const reservationService = await import('@/services/dashboard/reservation.dashboard.service')
      prismaMock.reservation.findFirst.mockResolvedValueOnce(makeClassReservation({ partySize: 3 }))
      prismaMock.$queryRaw.mockResolvedValueOnce(mockNewSession({ capacity: 5 })).mockResolvedValueOnce([{ total: 4n }]) // already 4 enrolled, +3 = 7 > 5
      prismaMock.reservation.findMany.mockResolvedValue([])

      await expect(
        reservationService.rescheduleClassReservation({
          venueId: VENUE_ID,
          reservationId: 'res-class-1',
          newClassSessionId: 'new-session',
          rescheduledBy: 'CUSTOMER',
        }),
      ).rejects.toThrow(ConflictError)
    })

    it('returns the same reservation untouched when target session equals current', async () => {
      const reservationService = await import('@/services/dashboard/reservation.dashboard.service')
      prismaMock.reservation.findFirst.mockResolvedValueOnce(makeClassReservation({ classSessionId: 'old-session' }))
      prismaMock.reservation.findUniqueOrThrow.mockResolvedValue(makeClassReservation({ classSessionId: 'old-session' }))

      await reservationService.rescheduleClassReservation({
        venueId: VENUE_ID,
        reservationId: 'res-class-1',
        newClassSessionId: 'old-session', // same as current
        rescheduledBy: 'CUSTOMER',
      })

      // No DB writes — pure read
      expect(prismaMock.reservation.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    })

    it('rejects when the race-guard updateMany returns 0 rows', async () => {
      const reservationService = await import('@/services/dashboard/reservation.dashboard.service')
      prismaMock.reservation.findFirst.mockResolvedValueOnce(makeClassReservation())
      prismaMock.$queryRaw.mockResolvedValueOnce(mockNewSession()).mockResolvedValueOnce([{ total: 0n }])
      prismaMock.reservation.findMany.mockResolvedValue([])
      prismaMock.reservation.updateMany.mockResolvedValueOnce({ count: 0 } as any) // race lost

      await expect(
        reservationService.rescheduleClassReservation({
          venueId: VENUE_ID,
          reservationId: 'res-class-1',
          newClassSessionId: 'new-session',
          rescheduledBy: 'CUSTOMER',
        }),
      ).rejects.toThrow(/otro proceso/i)
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

    // Regression — the calendar must resolve the FULL service list per booking
    // (multi-service appointments) in ONE batched product query, order preserved.
    it('attaches per-reservation services with a single batched product query', async () => {
      prismaMock.reservation.findMany.mockResolvedValue([
        createMockReservation({ id: 'res-multi', productId: 'p-baby', productIds: ['p-baby', 'p-manipedi'] }),
        createMockReservation({ id: 'res-single', productId: 'p-corte', productIds: [] }),
      ])
      prismaMock.product.findMany.mockResolvedValue([
        { id: 'p-corte', name: 'Corte', price: new Prisma.Decimal(200), duration: 30 },
        { id: 'p-manipedi', name: 'Manicure + Pedicure + Spa', price: new Prisma.Decimal(800), duration: 70 },
        { id: 'p-baby', name: 'Baby Boomer', price: new Prisma.Decimal(150), duration: 25 },
      ] as any)

      const result = await getReservationsCalendar(VENUE_ID, new Date('2026-03-01'), new Date('2026-03-02'))

      // ONE query for the whole page, not one per reservation
      expect(prismaMock.product.findMany).toHaveBeenCalledTimes(1)
      const [multi, single] = result.reservations as any[]
      expect(multi.services.map((s: any) => s.name)).toEqual(['Baby Boomer', 'Manicure + Pedicure + Spa'])
      expect(single.services.map((s: any) => s.name)).toEqual(['Corte'])
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
          DASHBOARD_WRITE,
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
          DASHBOARD_WRITE,
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

describe('handleNoShowDepositForfeit (Escenario A — no-show keeps the deposit)', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.resetAllMocks()
  })

  it('forfeits a PAID deposit when the venue has forfeitDeposit enabled', async () => {
    prismaMock.reservation.findFirst.mockResolvedValue({ id: 'res-1', confirmationCode: 'RES-ABC', depositStatus: 'PAID' })
    // getReservationSettings reads reservationSettings.findUnique; a row with
    // forfeitDeposit:true maps to cancellation.forfeitDeposit = true.
    prismaMock.reservationSettings.findUnique.mockResolvedValue({ venueId: VENUE_ID, forfeitDeposit: true } as any)

    await handleNoShowDepositForfeit('res-1', VENUE_ID)

    expect(prismaMock.reservation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'res-1' }, data: { depositStatus: 'FORFEITED' } }),
    )
  })

  it('does NOT touch the deposit when forfeitDeposit is off (no auto-refund on no-show)', async () => {
    prismaMock.reservation.findFirst.mockResolvedValue({ id: 'res-1', confirmationCode: 'RES-ABC', depositStatus: 'PAID' })
    // null settings → getReservationSettings returns defaults (forfeitDeposit:false).
    prismaMock.reservationSettings.findUnique.mockResolvedValue(null as any)

    await handleNoShowDepositForfeit('res-1', VENUE_ID)

    expect(prismaMock.reservation.update).not.toHaveBeenCalled()
  })

  it('does nothing when there is no PAID deposit', async () => {
    prismaMock.reservation.findFirst.mockResolvedValue({ id: 'res-1', confirmationCode: 'RES-ABC', depositStatus: null })

    await handleNoShowDepositForfeit('res-1', VENUE_ID)

    expect(prismaMock.reservation.update).not.toHaveBeenCalled()
    // Should not even need to load settings when there's no paid deposit.
    expect(prismaMock.reservationSettings.findUnique).not.toHaveBeenCalled()
  })
})

// ==========================================
// RESCHEDULE APPOINTMENT RESERVATION (public-facing + ops/MCP)
// ==========================================

describe('rescheduleAppointmentReservation', () => {
  const VENUE = 'venue-123'
  const oldStart = new Date('2026-09-01T15:00:00.000Z')
  const oldEnd = new Date('2026-09-01T16:00:00.000Z')
  const newStart = new Date('2026-09-02T15:00:00.000Z')
  const newEnd = new Date('2026-09-02T16:00:00.000Z')

  function makeAppt(overrides: Record<string, any> = {}) {
    return {
      id: 'res-appt-1',
      venueId: VENUE,
      confirmationCode: 'RES-APPT1',
      status: 'CONFIRMED',
      classSessionId: null,
      productId: 'product-1',
      productIds: ['product-1', 'product-2'],
      tableId: null,
      assignedStaffId: 'staff-1',
      duration: 60,
      partySize: 2,
      startsAt: oldStart,
      endsAt: oldEnd,
      guestName: 'Ana',
      guestPhone: null,
      guestEmail: null,
      customer: { firstName: 'Ana', lastName: 'Paz', phone: null, email: null },
      product: { name: 'Servicio' },
      venue: { name: 'Amaena', timezone: 'America/Mexico_City' },
      ...overrides,
    }
  }

  function lockedIdentity(overrides: Record<string, any> = {}) {
    const reservation = makeAppt(overrides)
    return {
      id: reservation.id,
      venueId: reservation.venueId,
      startsAt: reservation.startsAt,
      endsAt: reservation.endsAt,
      duration: reservation.duration,
      productId: reservation.productId,
      productIds: reservation.productIds,
      tableId: reservation.tableId,
      assignedStaffId: reservation.assignedStaffId,
      partySize: reservation.partySize,
      classSessionId: reservation.classSessionId,
      status: reservation.status,
    }
  }

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.resetAllMocks()
    prismaMock.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prismaMock) : arg))
    jest.spyOn(basePlanService, 'venueHasFeatureAccess').mockResolvedValue(true)
    jest
      .spyOn(reservationSettingsService, 'getReservationSettings')
      .mockResolvedValue(makeReservationSettings({ capacityMode: 'per_staff', showStaffPicker: true }))
    jest.spyOn(appointmentStaffAssignmentService, 'lockAppointmentVenue').mockResolvedValue()
    jest.spyOn(appointmentStaffAssignmentService, 'assertStaffEligibleForPersistedProducts').mockResolvedValue()
    jest.spyOn(appointmentSlotHoldService, 'lockReservationForReschedule').mockResolvedValue(lockedIdentity())
    jest.spyOn(appointmentSlotHoldService, 'lockAndValidateRescheduleAppointmentHold').mockResolvedValue({
      id: 'h1',
      checkedAt: new Date('2026-08-01T10:00:00.000Z'),
      endsAt: newEnd,
      productIds: ['product-1', 'product-2'],
      staffId: 'staff-1',
      releaseAGrace: false,
    })
    prismaMock.reservation.findUnique.mockResolvedValue(makeAppt() as any)
    prismaMock.reservation.update.mockResolvedValue(makeAppt({ startsAt: newStart, endsAt: newEnd }) as any)
    prismaMock.slotHold.deleteMany.mockResolvedValue({ count: 1 } as any)
    jest.spyOn(calendarOutboxService, 'resolveReservationPushTargets').mockResolvedValue([{ id: 'connection-1' }] as any)
    jest.spyOn(calendarOutboxService, 'enqueuePush').mockResolvedValue(['outbox-1'])
    jest.spyOn(rabbitCalendarPublisher, 'publishPushNotification').mockResolvedValue(undefined as never)
    jest.spyOn(whatsappService, 'sendReservationRescheduleWhatsApp').mockResolvedValue(undefined as never)
    jest.spyOn(emailService, 'sendReservationRescheduledEmail').mockResolvedValue(undefined as never)
  })

  it('checks Feature before one transaction and consumes R+H atomically in venue→R→hold order without pacing', async () => {
    const settingsSpy = jest.spyOn(reservationSettingsService, 'getReservationSettings')
    const venueLock = jest.spyOn(appointmentStaffAssignmentService, 'lockAppointmentVenue')
    const reservationLock = jest.spyOn(appointmentSlotHoldService, 'lockReservationForReschedule')
    const holdLock = jest.spyOn(appointmentSlotHoldService, 'lockAndValidateRescheduleAppointmentHold')
    const staffGate = jest.spyOn(appointmentStaffAssignmentService, 'assertStaffEligibleForPersistedProducts')
    const capacity = jest.spyOn(reservationAvailabilityService, 'countAppointmentOccupancy')

    const result = await rescheduleAppointmentReservation({
      venueId: VENUE,
      reservationId: 'res-appt-1',
      newStartsAt: newStart,
      holdId: 'h1',
      rescheduledBy: 'CUSTOMER',
      writeOrigin: 'PUBLIC',
    })

    expect(basePlanService.venueHasFeatureAccess).toHaveBeenCalledWith(VENUE, 'RESERVATIONS')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(settingsSpy.mock.invocationCallOrder[0]).toBeLessThan(venueLock.mock.invocationCallOrder[0])
    expect(venueLock.mock.invocationCallOrder[0]).toBeLessThan(reservationLock.mock.invocationCallOrder[0])
    expect(reservationLock.mock.invocationCallOrder[0]).toBeLessThan(holdLock.mock.invocationCallOrder[0])
    expect(holdLock).toHaveBeenCalledWith(prismaMock, {
      venueId: VENUE,
      holdId: 'h1',
      reservation: lockedIdentity(),
      requestedStartsAt: newStart,
      settings: makeReservationSettings({ capacityMode: 'per_staff', showStaffPicker: true }),
    })
    expect(staffGate).toHaveBeenCalledWith(
      prismaMock,
      expect.objectContaining({
        venueId: VENUE,
        staffId: 'staff-1',
        productIds: ['product-1', 'product-2'],
        startsAt: newStart,
        endsAt: newEnd,
        excludeReservationId: 'res-appt-1',
        excludeHoldId: 'h1',
      }),
    )
    expect(capacity).not.toHaveBeenCalled()
    expect(prismaMock.reservation.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.reservation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ startsAt: newStart, endsAt: newEnd, duration: 60 }) }),
    )
    expect(calendarOutboxService.enqueuePush).toHaveBeenCalled()
    expect(prismaMock.slotHold.deleteMany).toHaveBeenCalledWith({
      where: {
        venueId: VENUE,
        OR: [{ id: 'h1' }, { heldForReservationId: 'res-appt-1' }],
      },
    })
    expect(result.confirmationCode).toBe('RES-APPT1')
  })

  it.each([
    ['class reservation', { classSessionId: 'class-1' }],
    ['non-reschedulable status', { status: 'CANCELLED' }],
  ])('keeps the locked %s rejection inside the transaction and preserves H', async (_label, reservationOverride) => {
    jest.spyOn(appointmentSlotHoldService, 'lockReservationForReschedule').mockResolvedValue(lockedIdentity(reservationOverride))
    jest
      .spyOn(appointmentSlotHoldService, 'lockAndValidateRescheduleAppointmentHold')
      .mockRejectedValue(new ConflictError('Tu reserva temporal ya no es válida. Selecciona el horario de nuevo.'))

    await expect(
      rescheduleAppointmentReservation({
        venueId: VENUE,
        reservationId: 'res-appt-1',
        newStartsAt: newStart,
        holdId: 'h1',
        rescheduledBy: 'CUSTOMER',
        writeOrigin: 'PUBLIC',
      }),
    ).rejects.toMatchObject({ statusCode: 409 })

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.reservation.update).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
  })

  it('rejects Feature downgrade before the transaction and leaves R/H untouched for later reactivation', async () => {
    jest.spyOn(basePlanService, 'venueHasFeatureAccess').mockResolvedValue(false)

    await expect(
      rescheduleAppointmentReservation({
        venueId: VENUE,
        reservationId: 'res-appt-1',
        newStartsAt: newStart,
        holdId: 'h1',
        rescheduledBy: 'CUSTOMER',
        writeOrigin: 'PUBLIC',
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PLAN_REQUIRED', message: expect.stringMatching(/reservaciones/i) })

    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.reservation.update).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
  })

  it('preserves the candidate on locked mismatch with zero move/outbox writes', async () => {
    jest
      .spyOn(appointmentSlotHoldService, 'lockAndValidateRescheduleAppointmentHold')
      .mockRejectedValue(new ConflictError('Tu reserva temporal ya no es válida. Selecciona el horario de nuevo.'))

    await expect(
      rescheduleAppointmentReservation({
        venueId: VENUE,
        reservationId: 'res-appt-1',
        newStartsAt: newStart,
        holdId: 'h1',
        rescheduledBy: 'CUSTOMER',
        writeOrigin: 'PUBLIC',
      }),
    ).rejects.toMatchObject({ statusCode: 409 })

    expect(prismaMock.reservation.update).not.toHaveBeenCalled()
    expect(calendarOutboxService.enqueuePush).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
  })

  it('rechecks venue-wide external busy blocks when a legacy hold has no staff, without recounting pacing', async () => {
    jest
      .spyOn(reservationSettingsService, 'getReservationSettings')
      .mockResolvedValue(makeReservationSettings({ capacityMode: 'pacing', showStaffPicker: false }))
    jest.spyOn(appointmentSlotHoldService, 'lockAndValidateRescheduleAppointmentHold').mockResolvedValue({
      id: 'legacy-null-staff',
      checkedAt: new Date('2026-08-01T10:00:00.000Z'),
      endsAt: newEnd,
      productIds: ['product-1', 'product-2'],
      staffId: null,
      releaseAGrace: true,
    })
    prismaMock.externalBusyBlock.findFirst.mockResolvedValue({ id: 'venue-master-block' } as any)
    const capacity = jest.spyOn(reservationAvailabilityService, 'countAppointmentOccupancy')

    await expect(
      rescheduleAppointmentReservation({
        venueId: VENUE,
        reservationId: 'res-appt-1',
        newStartsAt: newStart,
        holdId: 'legacy-null-staff',
        rescheduledBy: 'CUSTOMER',
        writeOrigin: 'PUBLIC',
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Este horario fue bloqueado por un evento de calendario externo',
    })

    expect(prismaMock.externalBusyBlock.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [{ venueId: VENUE }],
        startsAt: { lt: newEnd },
        endsAt: { gt: newStart },
      },
    })
    expect(appointmentStaffAssignmentService.assertStaffEligibleForPersistedProducts).not.toHaveBeenCalled()
    expect(capacity).not.toHaveBeenCalled()
    expect(prismaMock.reservation.update).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
  })

  it('revalidates the exact table of a hybrid appointment inside the locked consume transaction', async () => {
    jest.spyOn(appointmentSlotHoldService, 'lockReservationForReschedule').mockResolvedValue(lockedIdentity({ tableId: 'table-1' }))
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'other-reservation', confirmationCode: 'RES-OTHER' }])

    await expect(
      rescheduleAppointmentReservation({
        venueId: VENUE,
        reservationId: 'res-appt-1',
        newStartsAt: newStart,
        holdId: 'h1',
        rescheduledBy: 'CUSTOMER',
        writeOrigin: 'PUBLIC',
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: 'Mesa tiene conflicto con reservacion RES-OTHER' })

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    expect((prismaMock.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?')).toMatch(
      /FROM "Reservation"[\s\S]*"venueId" = \?[\s\S]*"tableId" = \?[\s\S]*id <> \?[\s\S]*"startsAt" < \?[\s\S]*"endsAt" > \?[\s\S]*FOR UPDATE NOWAIT/i,
    )
    expect(prismaMock.$queryRaw.mock.calls[0].slice(1)).toEqual([VENUE, 'table-1', 'res-appt-1', newEnd, newStart])
    expect(prismaMock.reservation.update).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
  })

  it('emits the exact Release A grace metric and all external side effects once after a serialization retry', async () => {
    jest.spyOn(appointmentSlotHoldService, 'lockAndValidateRescheduleAppointmentHold').mockResolvedValue({
      id: 'legacy-hold',
      checkedAt: new Date('2026-08-01T10:00:00.000Z'),
      endsAt: newEnd,
      productIds: ['product-1', 'product-2'],
      staffId: 'staff-1',
      releaseAGrace: true,
    })
    prismaMock.reservation.findUnique.mockResolvedValue(
      makeAppt({ customer: { firstName: 'Ana', lastName: 'Paz', phone: '+5215512345678', email: 'ana@example.com' } }) as any,
    )
    prismaMock.reservation.update.mockRejectedValueOnce(Object.assign(new Error('serialization'), { code: 'P2034' })).mockResolvedValueOnce(
      makeAppt({
        startsAt: newStart,
        endsAt: newEnd,
        customer: { firstName: 'Ana', lastName: 'Paz', phone: '+5215512345678', email: 'ana@example.com' },
      }) as any,
    )

    await rescheduleAppointmentReservation({
      venueId: VENUE,
      reservationId: 'res-appt-1',
      newStartsAt: newStart,
      holdId: 'legacy-hold',
      rescheduledBy: 'CUSTOMER',
      writeOrigin: 'PUBLIC',
    })

    expect(reservationSettingsService.getReservationSettings).toHaveBeenCalledTimes(2)
    expect(appointmentStaffAssignmentService.lockAppointmentVenue).toHaveBeenCalledTimes(2)
    expect(appointmentSlotHoldService.lockReservationForReschedule).toHaveBeenCalledTimes(2)
    expect(appointmentSlotHoldService.lockAndValidateRescheduleAppointmentHold).toHaveBeenCalledTimes(2)
    expect(prismaMock.reservation.update).toHaveBeenCalledTimes(2)
    const metricCalls = (logger.warn as jest.Mock).mock.calls.filter(
      ([message]) => message === '[slot-hold] Release A legacy reschedule hold consumed',
    )
    expect(metricCalls).toEqual([
      [
        '[slot-hold] Release A legacy reschedule hold consumed',
        {
          metric: 'reservation_reschedule_hold_release_a_grace',
          venueId: VENUE,
          reservationId: 'res-appt-1',
          holdId: 'legacy-hold',
        },
      ],
    ])
    expect(rabbitCalendarPublisher.publishPushNotification).toHaveBeenCalledTimes(1)
    expect(whatsappService.sendReservationRescheduleWhatsApp).toHaveBeenCalledTimes(1)
    expect(emailService.sendReservationRescheduledEmail).toHaveBeenCalledTimes(1)
    expect(activityLogService.logAction).toHaveBeenCalledTimes(1)
  })
})

describe('countAppointmentOccupancy — reschedule self-exclusion', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.resetAllMocks()
    prismaMock.reservation.count.mockResolvedValue(0)
    prismaMock.slotHold.findMany.mockResolvedValue([])
  })

  it('excludes the moving reservation from the active-reservation count', async () => {
    await countAppointmentOccupancy(prismaMock, {
      venueId: 'v1',
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 60_000),
      excludeReservationId: 'res-self',
    })
    expect(prismaMock.reservation.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { not: 'res-self' } }) }),
    )
  })

  it('adds no id filter when no exclusion is passed (booking path unchanged)', async () => {
    await countAppointmentOccupancy(prismaMock, {
      venueId: 'v1',
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 60_000),
    })
    const where = prismaMock.reservation.count.mock.calls[0][0].where
    expect(where.id).toBeUndefined()
  })

  it('counts only active appointment-service reservations with conservative overlap predicates', async () => {
    prismaMock.reservation.count.mockResolvedValue(2)
    const startsAt = new Date('2026-07-21T15:00:00.000Z')
    const endsAt = new Date('2026-07-21T16:00:00.000Z')

    await expect(countAppointmentOccupancy(prismaMock, { venueId: 'v1', startsAt, endsAt })).resolves.toEqual({
      reservations: 2,
      holds: 0,
    })

    expect(prismaMock.reservation.count).toHaveBeenCalledWith({
      where: {
        venueId: 'v1',
        status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
        classSessionId: null,
        product: { is: { type: 'APPOINTMENTS_SERVICE' } },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
    })
  })

  it('classifies normal and reschedule holds with one captured checkedAt', async () => {
    const checkedAt = new Date('2026-07-21T14:00:00.000Z')
    prismaMock.slotHold.findMany.mockResolvedValue([
      {
        id: 'normal-live',
        expiresAt: new Date('2026-07-21T14:10:00.000Z'),
        heldForReservationId: null,
        heldForReservation: null,
      },
      {
        id: 'pending-live',
        expiresAt: new Date('2026-07-21T14:10:00.000Z'),
        heldForReservationId: 'pending',
        heldForReservation: { status: 'PENDING' },
      },
      {
        id: 'confirmed-live',
        expiresAt: new Date('2026-07-21T14:10:00.000Z'),
        heldForReservationId: 'confirmed',
        heldForReservation: { status: 'CONFIRMED' },
      },
      {
        id: 'cancelled-parent',
        expiresAt: new Date('2026-07-21T14:10:00.000Z'),
        heldForReservationId: 'cancelled',
        heldForReservation: { status: 'CANCELLED' },
      },
      {
        id: 'expired',
        expiresAt: checkedAt,
        heldForReservationId: null,
        heldForReservation: null,
      },
    ])

    await expect(
      countAppointmentOccupancy(prismaMock, {
        venueId: 'v1',
        startsAt: new Date('2026-07-21T15:00:00.000Z'),
        endsAt: new Date('2026-07-21T16:00:00.000Z'),
        checkedAt,
      }),
    ).resolves.toEqual({ reservations: 0, holds: 3 })
  })

  it('retains hold exclusion and requests only the parent fields needed for liveness', async () => {
    const startsAt = new Date('2026-07-21T15:00:00.000Z')
    const endsAt = new Date('2026-07-21T16:00:00.000Z')
    const checkedAt = new Date('2026-07-21T14:00:00.000Z')

    await countAppointmentOccupancy(prismaMock, {
      venueId: 'v1',
      startsAt,
      endsAt,
      checkedAt,
      excludeHoldId: 'hold-self',
    })

    expect(prismaMock.slotHold.findMany).toHaveBeenCalledWith({
      where: {
        venueId: 'v1',
        classSessionId: null,
        expiresAt: { gt: checkedAt },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
        id: { not: 'hold-self' },
      },
      select: {
        expiresAt: true,
        heldForReservationId: true,
        heldForReservation: { select: { status: true } },
      },
    })
  })
})
