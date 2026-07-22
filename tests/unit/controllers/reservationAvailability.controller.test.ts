import * as dashboardController from '@/controllers/dashboard/reservation.dashboard.controller'
import * as publicController from '@/controllers/public/reservation.public.controller'
import * as availabilityService from '@/services/dashboard/reservationAvailability.service'
import * as reservationService from '@/services/dashboard/reservation.dashboard.service'
import * as settingsService from '@/services/dashboard/reservationSettings.service'
import * as appointmentStaffAssignmentService from '@/services/dashboard/appointmentStaffAssignment.service'
import * as appointmentWindowService from '@/services/reservation/resolveAppointmentWindow'
import * as appointmentSlotHoldService from '@/services/reservation/appointmentSlotHold.service'
import * as ecommerceCapability from '@/services/payments/ecommerceCapability'
import { prismaMock } from '@tests/__helpers__/setup'
import { Prisma } from '@prisma/client'

const date = '2026-08-21'
const startsAt = new Date('2026-08-21T15:00:00.000Z')
const endsAt = new Date('2026-08-21T16:00:00.000Z')
const ordinarySlot = { startsAt, endsAt, availableTables: [], availableStaff: [] }
const fullSlot = { ...ordinarySlot, available: false as const, reason: 'FULL' as const }

const settings = {
  scheduling: {
    slotIntervalMin: 15,
    defaultDurationMin: 60,
    autoConfirm: true,
    maxAdvanceDays: 60,
    minNoticeMin: 0,
    noShowGraceMin: 15,
    pacingMaxPerSlot: null,
    onlineCapacityPercent: 100,
    capacityMode: 'per_staff',
  },
  publicBooking: { enabled: true, requirePhone: false, requireEmail: false, requireAccount: false, showStaffPicker: true },
  cancellation: { allowCustomerReschedule: true, minHoursBeforeStart: null },
  operatingHours: {},
} as any

function responseMock() {
  const res: any = {
    json: jest.fn(),
    status: jest.fn(),
  }
  res.status.mockReturnValue(res)
  return res
}

describe('reservation availability controller boundaries', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.resetAllMocks()
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue(settings)
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'UTC' })
    prismaMock.venue.findFirst.mockResolvedValue({
      id: 'venue-1',
      name: 'Venue',
      slug: 'venue',
      logo: null,
      type: 'SERVICES',
      timezone: 'UTC',
    })
  })

  it('dashboard write entrypoints pass DASHBOARD context and keep the actor separate without settings preflight', async () => {
    const created = { id: 'reservation-created' } as any
    const updated = { id: 'reservation-updated' } as any
    const rescheduled = { id: 'reservation-rescheduled' } as any
    const createSpy = jest.spyOn(reservationService, 'createReservation').mockResolvedValue(created)
    const updateSpy = jest.spyOn(reservationService, 'updateReservation').mockResolvedValue(updated)
    const rescheduleSpy = jest.spyOn(reservationService, 'rescheduleReservation').mockResolvedValue(rescheduled)
    const settingsSpy = jest.spyOn(settingsService, 'getReservationSettings')
    const next = jest.fn()

    const createReq: any = {
      params: { venueId: 'venue-1' },
      body: { guestName: 'Ana' },
      authContext: { userId: 'staff-1' },
    }
    const updateReq: any = {
      params: { venueId: 'venue-1', id: 'reservation-1' },
      body: { guestName: 'Bea' },
      authContext: { userId: 'staff-1' },
    }
    const rescheduleReq: any = {
      params: { venueId: 'venue-1', id: 'reservation-1' },
      body: {
        startsAt: '2026-08-22T15:00:00.000Z',
        endsAt: '2026-08-22T16:00:00.000Z',
        notificationChannel: 'email',
        customMessage: 'Nos vemos pronto',
      },
      authContext: { userId: 'staff-1' },
    }

    await dashboardController.createReservation(createReq, responseMock(), next)
    await dashboardController.updateReservation(updateReq, responseMock(), next)
    await dashboardController.rescheduleReservation(rescheduleReq, responseMock(), next)

    expect(next).not.toHaveBeenCalled()
    expect(settingsSpy).not.toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalledWith('venue-1', createReq.body, { writeOrigin: 'DASHBOARD' }, 'staff-1')
    expect(updateSpy).toHaveBeenCalledWith('venue-1', 'reservation-1', updateReq.body, { writeOrigin: 'DASHBOARD' }, 'staff-1')
    expect(rescheduleSpy).toHaveBeenCalledWith(
      'venue-1',
      'reservation-1',
      {
        startsAt: new Date('2026-08-22T15:00:00.000Z'),
        endsAt: new Date('2026-08-22T16:00:00.000Z'),
        notificationChannel: 'email',
        customMessage: 'Nos vemos pronto',
      },
      { writeOrigin: 'DASHBOARD' },
      'staff-1',
    )
  })

  it('dashboard create maps base semantics and over-capacity consent only into trusted context', async () => {
    const created = { id: 'reservation-created', overCapacity: true } as any
    const createSpy = jest.spyOn(reservationService, 'createReservation').mockResolvedValue(created)
    const body = {
      startsAt,
      endsAt,
      duration: 60,
      productId: 'product-1',
      productIds: ['product-1'],
      windowSemantics: 'base',
      allowOverCapacity: true,
    }
    const req: any = { params: { venueId: 'venue-1' }, body, authContext: { userId: 'staff-1' } }
    const res = responseMock()
    const next = jest.fn()

    await dashboardController.createReservation(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith(created)
    expect(createSpy).toHaveBeenCalledWith(
      'venue-1',
      expect.not.objectContaining({ windowSemantics: expect.anything(), allowOverCapacity: expect.anything() }),
      { writeOrigin: 'DASHBOARD', windowSemantics: 'base', allowOverCapacity: true },
      'staff-1',
    )
  })

  it('public appointment reschedule declares PUBLIC origin', async () => {
    const reservation = {
      id: 'reservation-1',
      venueId: 'venue-1',
      status: 'CONFIRMED',
      startsAt: new Date(Date.now() + 48 * 60 * 60_000),
      classSessionId: null,
    } as any
    jest.spyOn(reservationService, 'getReservationByCancelSecret').mockResolvedValue(reservation)
    const rescheduleSpy = jest.spyOn(reservationService, 'rescheduleAppointmentReservation').mockResolvedValue({
      confirmationCode: 'RES-1',
      status: 'CONFIRMED',
      startsAt,
      endsAt,
    } as any)
    const req: any = {
      params: { venueSlug: 'venue', cancelSecret: 'secret' },
      body: { startsAt: startsAt.toISOString(), holdId: 'hold-1' },
    }
    const res = responseMock()
    const next = jest.fn()

    await publicController.rescheduleReservation(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(rescheduleSpy).toHaveBeenCalledWith({
      venueId: 'venue-1',
      reservationId: 'reservation-1',
      newStartsAt: startsAt,
      holdId: 'hold-1',
      rescheduledBy: 'CUSTOMER',
      writeOrigin: 'PUBLIC',
    })
  })

  it('delegates startsAt-only reschedule holds to the neutral transaction without an availability scan', async () => {
    const reservation = {
      id: 'reservation-1',
      venueId: 'venue-1',
      status: 'CONFIRMED',
      startsAt: new Date(Date.now() + 48 * 60 * 60_000),
      duration: 75,
      productId: 'product-1',
      productIds: ['product-1', 'product-2'],
      assignedStaffId: 'staff-1',
      partySize: 2,
      classSessionId: null,
    } as any
    jest.spyOn(reservationService, 'getReservationByCancelSecret').mockResolvedValue(reservation)
    const mint = jest.spyOn(appointmentSlotHoldService, 'mintRescheduleAppointmentHold').mockResolvedValue({
      id: 'hold-reschedule',
      expiresAt: new Date('2026-08-21T15:10:00.000Z'),
      staffId: 'staff-1',
    })
    const availability = jest.spyOn(availabilityService, 'getAvailableSlots')
    const req: any = {
      params: { venueSlug: 'venue', cancelSecret: 'secret' },
      body: { startsAt: startsAt.toISOString() },
    }
    const res = responseMock()
    const next = jest.fn()

    await publicController.createRescheduleHold(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(availability).not.toHaveBeenCalled()
    expect(mint).toHaveBeenCalledWith({
      venueId: 'venue-1',
      reservationId: 'reservation-1',
      requestedStartsAt: startsAt,
      requestedEndsAt: undefined,
    })
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith({
      holdId: 'hold-reschedule',
      expiresAt: new Date('2026-08-21T15:10:00.000Z'),
      ttlSeconds: 600,
      staffId: 'staff-1',
    })
  })

  it('forwards optional legacy reschedule endsAt but performs no authoritative pre-transaction slot scan', async () => {
    const reservation = {
      id: 'reservation-1',
      venueId: 'venue-1',
      status: 'CONFIRMED',
      startsAt: new Date(Date.now() + 48 * 60 * 60_000),
      classSessionId: null,
    } as any
    jest.spyOn(reservationService, 'getReservationByCancelSecret').mockResolvedValue(reservation)
    const mint = jest.spyOn(appointmentSlotHoldService, 'mintRescheduleAppointmentHold').mockResolvedValue({
      id: 'hold-reschedule',
      expiresAt: new Date('2026-08-21T15:10:00.000Z'),
      staffId: null,
    })
    const availability = jest.spyOn(availabilityService, 'getAvailableSlots')
    const req: any = {
      params: { venueSlug: 'venue', cancelSecret: 'secret' },
      body: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
    }
    const res = responseMock()
    const next = jest.fn()

    await publicController.createRescheduleHold(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(availability).not.toHaveBeenCalled()
    expect(mint).toHaveBeenCalledWith({
      venueId: 'venue-1',
      reservationId: 'reservation-1',
      requestedStartsAt: startsAt,
      requestedEndsAt: endsAt,
    })
    expect(res.json).toHaveBeenCalledWith(expect.not.objectContaining({ staffId: expect.anything() }))
  })

  it('public ordinary no-deposit preflight passes the exact persisted deposits snapshot', async () => {
    const deposits = {
      enabled: false,
      mode: 'none',
      fixedAmount: null,
      percentageOfTotal: null,
      requiredForPartySizeGte: null,
      paymentWindowHrs: 24,
    } as const
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue({
      ...settings,
      deposits,
      payments: { appointmentUpfrontDefault: 'at_venue', classUpfrontDefault: 'required' },
    } as any)
    const createSpy = jest.spyOn(reservationService, 'createReservation').mockResolvedValue({
      id: 'reservation-1',
      confirmationCode: 'RES-1',
      cancelSecret: 'secret',
      startsAt,
      endsAt,
      status: 'CONFIRMED',
      depositAmount: null,
      guestEmail: null,
      guestPhone: null,
      productId: null,
    } as any)
    const req: any = {
      params: { venueSlug: 'venue' },
      headers: {},
      body: { startsAt, endsAt, duration: 60, partySize: 1 },
    }
    const res = responseMock()
    const next = jest.fn()

    await publicController.createReservation(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalledWith('venue-1', expect.objectContaining({ channel: 'WEB' }), {
      writeOrigin: 'PUBLIC',
      paymentPolicyOverride: { deposits },
    })
  })

  it('does not collapse staff-aware null pacing to one in the public no-hold fast guard', async () => {
    const deposits = {
      enabled: false,
      mode: 'none',
      fixedAmount: null,
      percentageOfTotal: null,
      requiredForPartySizeGte: null,
      paymentWindowHrs: 24,
    } as const
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue({
      ...settings,
      scheduling: { ...settings.scheduling, capacityMode: 'per_staff', pacingMaxPerSlot: null },
      deposits,
      payments: { appointmentUpfrontDefault: 'at_venue', classUpfrontDefault: 'required' },
    } as any)
    prismaMock.product.findFirst.mockResolvedValue({
      type: 'APPOINTMENTS_SERVICE',
      price: new Prisma.Decimal(0),
      upfrontPolicy: 'at_venue',
    } as any)
    const occupancy = jest.spyOn(availabilityService, 'countAppointmentOccupancy').mockResolvedValue({ reservations: 10, holds: 10 })
    const createSpy = jest.spyOn(reservationService, 'createReservation').mockResolvedValue({
      id: 'reservation-1',
      confirmationCode: 'RES-1',
      cancelSecret: 'secret',
      startsAt,
      endsAt,
      status: 'CONFIRMED',
      depositAmount: null,
      guestEmail: null,
      guestPhone: null,
      productId: 'product-1',
    } as any)
    const req: any = {
      params: { venueSlug: 'venue' },
      headers: {},
      body: { startsAt, endsAt, duration: 60, partySize: 1, productId: 'product-1' },
    }
    const next = jest.fn()

    await publicController.createReservation(req, responseMock(), next)

    expect(next).not.toHaveBeenCalled()
    expect(occupancy).not.toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalledWith(
      'venue-1',
      expect.objectContaining({ channel: 'WEB', productId: 'product-1', productIds: undefined }),
      expect.any(Object),
    )
  })

  it('rejects public staff selection with Spanish 400 before the legacy occupancy fast-fail when the picker is off', async () => {
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue({
      ...settings,
      scheduling: { ...settings.scheduling, capacityMode: 'pacing', pacingMaxPerSlot: 1 },
      publicBooking: { ...settings.publicBooking, showStaffPicker: false },
    } as any)
    const occupancy = jest.spyOn(availabilityService, 'countAppointmentOccupancy').mockResolvedValue({ reservations: 1, holds: 0 })
    const createSpy = jest.spyOn(reservationService, 'createReservation').mockResolvedValue({
      id: 'reservation-should-not-exist',
      confirmationCode: 'RES-NO',
      cancelSecret: 'secret',
      startsAt,
      endsAt,
      status: 'CONFIRMED',
      depositAmount: null,
      guestEmail: null,
      guestPhone: null,
      productId: 'product-1',
    } as any)
    const req: any = {
      params: { venueSlug: 'venue' },
      headers: {},
      body: {
        startsAt,
        endsAt,
        duration: 60,
        partySize: 1,
        productId: 'product-1',
        staffId: 'staff-forbidden',
      },
    }
    const next = jest.fn()

    await publicController.createReservation(req, responseMock(), next)

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: 'La selección de profesionista no está habilitada para este negocio' }),
    )
    expect(occupancy).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('preserves the legacy require-account 401 before the picker-off staff rejection', async () => {
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue({
      ...settings,
      publicBooking: { ...settings.publicBooking, requireAccount: true, showStaffPicker: false },
    } as any)
    const occupancy = jest.spyOn(availabilityService, 'countAppointmentOccupancy')
    const createSpy = jest.spyOn(reservationService, 'createReservation')
    const req: any = {
      params: { venueSlug: 'venue' },
      headers: {},
      body: {
        startsAt,
        endsAt,
        duration: 60,
        partySize: 1,
        productId: 'product-1',
        staffId: 'staff-forbidden',
      },
    }
    const next = jest.fn()

    await publicController.createReservation(req, responseMock(), next)

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, message: 'Este negocio requiere iniciar sesion para reservar.' }),
    )
    expect(occupancy).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it.each(['missing', 'expired', 'foreign'])(
    'rejects an unavailable (%s) public hold through the scoped live lookup before core create',
    async label => {
      const holdId = `hold-${label}`
      prismaMock.slotHold.findFirst.mockResolvedValue(null)
      const createSpy = jest.spyOn(reservationService, 'createReservation')
      const req: any = {
        params: { venueSlug: 'venue' },
        headers: {},
        body: { startsAt, endsAt, duration: 60, partySize: 1, holdId },
      }
      const next = jest.fn()

      await publicController.createReservation(req, responseMock(), next)

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }))
      expect(prismaMock.slotHold.findFirst).toHaveBeenCalledWith({
        where: { id: holdId, venueId: 'venue-1', expiresAt: { gt: expect.any(Date) } },
        select: { id: true, startsAt: true, endsAt: true },
      })
      expect(createSpy).not.toHaveBeenCalled()
    },
  )

  it('rejects a public hold with a mismatched window before core create', async () => {
    prismaMock.slotHold.findFirst.mockResolvedValue({
      id: 'hold-mismatch',
      startsAt: new Date(startsAt.getTime() + 60_000),
      endsAt,
    } as any)
    const createSpy = jest.spyOn(reservationService, 'createReservation')
    const req: any = {
      params: { venueSlug: 'venue' },
      headers: {},
      body: { startsAt, endsAt, duration: 60, partySize: 1, holdId: 'hold-mismatch' },
    }
    const next = jest.fn()

    await publicController.createReservation(req, responseMock(), next)

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: 'La reserva temporal no corresponde al horario seleccionado' }),
    )
    expect(createSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['conflicting scalar/list', { productId: 'product-b', productIds: 'product-a,product-b' }],
    ['explicit empty list plus scalar', { productId: 'product-a', productIds: [] }],
    ['explicit empty CSV plus scalar', { productId: 'product-a', productIds: ' , ' }],
    ['more than twenty canonical products', { productIds: Array.from({ length: 21 }, (_, index) => `product-${index}`) }],
  ])('rejects public create product identity (%s) before catalog or core work', async (_label, products) => {
    const createSpy = jest.spyOn(reservationService, 'createReservation')
    const req: any = {
      params: { venueSlug: 'venue' },
      headers: {},
      body: { startsAt, endsAt, duration: 60, partySize: 1, ...products },
    }
    const next = jest.fn()

    await publicController.createReservation(req, responseMock(), next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: expect.stringMatching(/coincidir|20/i) }))
    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('lets a picker-off candidate token reach the core and leaves normal hold consumption to its transaction', async () => {
    const deposits = {
      enabled: false,
      mode: 'none',
      fixedAmount: null,
      percentageOfTotal: null,
      requiredForPartySizeGte: null,
      paymentWindowHrs: 24,
    } as const
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue({
      ...settings,
      publicBooking: { ...settings.publicBooking, showStaffPicker: false },
      deposits,
      payments: { appointmentUpfrontDefault: 'at_venue', classUpfrontDefault: 'required' },
    } as any)
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'product-2', type: 'APPOINTMENTS_SERVICE', duration: 30, durationMinutes: null },
      { id: 'product-1', type: 'APPOINTMENTS_SERVICE', duration: 30, durationMinutes: null },
    ] as any)
    prismaMock.product.findFirst.mockResolvedValue({
      type: 'APPOINTMENTS_SERVICE',
      price: new Prisma.Decimal(0),
      upfrontPolicy: 'at_venue',
    } as any)
    prismaMock.slotHold.findFirst.mockResolvedValue({
      id: 'hold-validated',
      expiresAt: new Date('2099-08-21T15:10:00.000Z'),
    } as any)
    const occupancySpy = jest.spyOn(availabilityService, 'countAppointmentOccupancy').mockResolvedValue({ reservations: 99, holds: 99 })
    const createSpy = jest.spyOn(reservationService, 'createReservation').mockResolvedValue({
      id: 'reservation-1',
      confirmationCode: 'RES-1',
      cancelSecret: 'secret',
      startsAt,
      endsAt,
      status: 'CONFIRMED',
      depositAmount: null,
      guestEmail: null,
      guestPhone: null,
      productId: 'product-1',
    } as any)
    const req: any = {
      params: { venueSlug: 'venue' },
      headers: {},
      body: {
        startsAt,
        endsAt,
        duration: 60,
        partySize: 1,
        productId: 'product-1',
        productIds: [' product-1, product-2 ', '', 'product-1'],
        windowSemantics: 'base',
        holdId: 'hold-untrusted',
        staffId: 'staff-public',
        validatedHoldId: 'forged-context-id',
      },
    }
    const res = responseMock()
    const next = jest.fn()

    await publicController.createReservation(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalledWith(
      'venue-1',
      expect.objectContaining({
        channel: 'WEB',
        productId: 'product-1',
        productIds: ['product-1', 'product-2'],
        assignedStaffId: 'staff-public',
      }),
      {
        writeOrigin: 'PUBLIC',
        paymentPolicyOverride: { deposits },
        windowSemantics: 'base',
        appointmentHoldId: 'hold-validated',
      },
    )
    expect(occupancySpy).not.toHaveBeenCalled()
    expect(prismaMock.reservation.update).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
  })

  it('preserves legacy class hold validation and post-commit cleanup', async () => {
    const classSession = {
      id: 'class-session-1',
      productId: 'class-product',
      startsAt,
      endsAt,
      duration: 60,
      capacity: 10,
      status: 'SCHEDULED',
    }
    prismaMock.slotHold.findFirst.mockResolvedValue({ id: 'class-hold', startsAt, endsAt } as any)
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.$queryRaw.mockResolvedValueOnce([classSession] as any).mockResolvedValueOnce([{ total: 0n }] as any)
    prismaMock.externalBusyBlock.findFirst.mockResolvedValue(null)
    prismaMock.product.findFirst.mockResolvedValue({
      type: 'CLASS',
      active: true,
      layoutConfig: null,
      requireCreditForBooking: false,
      price: new Prisma.Decimal(0),
      upfrontPolicy: 'at_venue',
      name: 'Clase',
    } as any)
    prismaMock.reservation.findUnique.mockResolvedValue(null)
    prismaMock.reservation.create.mockResolvedValue({
      id: 'class-reservation-1',
      confirmationCode: 'CLASS-1',
      cancelSecret: 'class-secret',
      productId: 'class-product',
      startsAt,
      endsAt,
      status: 'CONFIRMED',
      guestName: 'Ana',
      guestEmail: null,
      guestPhone: null,
    } as any)
    prismaMock.classSession.findUnique.mockResolvedValue(null)
    jest.spyOn(ecommerceCapability, 'resolveChargeableStripeMerchant').mockResolvedValue(null)
    const req: any = {
      params: { venueSlug: 'venue' },
      headers: {},
      body: {
        startsAt,
        endsAt,
        duration: 60,
        partySize: 1,
        productId: 'class-product',
        classSessionId: 'class-session-1',
        holdId: 'class-hold',
      },
    }
    const res = responseMock()
    const next = jest.fn()

    await publicController.createReservation(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.findFirst).toHaveBeenCalledWith({
      where: { id: 'class-hold', venueId: 'venue-1', expiresAt: { gt: expect.any(Date) } },
      select: { id: true, startsAt: true, endsAt: true },
    })
    expect(prismaMock.slotHold.deleteMany).toHaveBeenCalledWith({ where: { id: 'class-hold', venueId: 'venue-1' } })
    expect(prismaMock.reservation.create.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.slotHold.deleteMany.mock.invocationCallOrder[0],
    )
    expect(res.status).toHaveBeenCalledWith(201)
  })

  it('keeps a public booking confirmed when transactional deposits become required after a no-deposit rail preflight', async () => {
    const evaluatedDeposits = {
      enabled: false,
      mode: 'none',
      fixedAmount: null,
      percentageOfTotal: null,
      requiredForPartySizeGte: null,
      paymentWindowHrs: 24,
    } as const
    const transactionalDeposits = {
      enabled: true,
      mode: 'deposit',
      fixedAmount: 90,
      percentageOfTotal: null,
      requiredForPartySizeGte: null,
      paymentWindowHrs: 24,
    } as const
    const settingsSpy = jest
      .spyOn(settingsService, 'getReservationSettings')
      .mockResolvedValueOnce({
        ...settings,
        deposits: evaluatedDeposits,
        payments: { appointmentUpfrontDefault: 'at_venue', classUpfrontDefault: 'required' },
      } as any)
      .mockResolvedValueOnce({
        ...settings,
        deposits: transactionalDeposits,
        payments: { appointmentUpfrontDefault: 'at_venue', classUpfrontDefault: 'required' },
      } as any)
    const stripeSpy = jest.spyOn(ecommerceCapability, 'resolveChargeableStripeMerchant').mockResolvedValue(null)
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock))
    prismaMock.reservation.findUnique.mockResolvedValue(null)
    prismaMock.reservationSettings.findUnique.mockResolvedValue(null)
    prismaMock.reservation.create.mockImplementation(async ({ data }: any) => ({
      ...data,
      id: 'reservation-1',
      confirmationCode: data.confirmationCode,
      cancelSecret: 'secret',
      classSessionId: null,
      productIds: [],
      spotIds: [],
      creditRedeemed: false,
      creditsUsed: 0,
      customer: null,
      table: null,
      product: null,
      assignedStaff: null,
    }))
    const req: any = {
      params: { venueSlug: 'venue' },
      headers: {},
      body: { startsAt, endsAt, duration: 60, partySize: 1 },
    }
    const res = responseMock()
    const next = jest.fn()

    await publicController.createReservation(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(settingsSpy).toHaveBeenNthCalledWith(1, 'venue-1')
    expect(settingsSpy).toHaveBeenNthCalledWith(2, 'venue-1', prismaMock)
    expect(stripeSpy).not.toHaveBeenCalled()
    expect(prismaMock.reservation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CONFIRMED', depositAmount: null, depositStatus: null }),
      }),
    )
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'CONFIRMED', depositRequired: false, depositAmount: null, checkoutUrl: null }),
    )
  })

  it('public no-Stripe fallback passes only a deposits suppression override and preserves pay-at-venue stamping', async () => {
    const configured = {
      ...settings,
      deposits: {
        enabled: true,
        mode: 'deposit',
        fixedAmount: 80,
        percentageOfTotal: null,
        requiredForPartySizeGte: null,
        paymentWindowHrs: 24,
      },
      payments: { appointmentUpfrontDefault: 'at_venue', classUpfrontDefault: 'required' },
    } as any
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue(configured)
    jest.spyOn(ecommerceCapability, 'resolveChargeableStripeMerchant').mockResolvedValue(null)
    jest.spyOn(reservationService, 'calculateDepositAmount').mockReturnValue({ required: true, amount: new Prisma.Decimal(80) })
    const created = {
      id: 'reservation-1',
      confirmationCode: 'RES-1',
      cancelSecret: 'secret',
      startsAt,
      endsAt,
      status: 'CONFIRMED',
      specialRequests: null,
      depositAmount: null,
      guestEmail: null,
      guestPhone: null,
      productId: null,
    } as any
    const stamped = { ...created, depositAmount: new Prisma.Decimal(80), specialRequests: '[PAY-AT-VENUE]' }
    const createSpy = jest.spyOn(reservationService, 'createReservation').mockResolvedValue(created)
    prismaMock.reservation.update.mockResolvedValue(stamped as any)
    const req: any = {
      params: { venueSlug: 'venue' },
      headers: {},
      body: {
        startsAt,
        endsAt,
        duration: 60,
        partySize: 1,
        paymentPolicyOverride: { deposits: { enabled: true, fixedAmount: 1 } },
        scheduling: { autoConfirm: false },
      },
    }
    const res = responseMock()
    const next = jest.fn()

    await publicController.createReservation(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalledWith('venue-1', expect.objectContaining({ channel: 'WEB' }), {
      writeOrigin: 'PUBLIC',
      paymentPolicyOverride: {
        deposits: expect.objectContaining({ enabled: false, mode: 'none' }),
      },
    })
    expect(prismaMock.reservation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'reservation-1' },
        data: expect.objectContaining({
          depositAmount: new Prisma.Decimal(80),
          specialRequests: expect.stringContaining('[PAY-AT-VENUE]'),
        }),
      }),
    )
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'CONFIRMED', depositAmount: new Prisma.Decimal(80), owesAtVenue: true }),
    )
  })

  it('public required-upfront Stripe flow passes the synthesized prepaid deposit as trusted context', async () => {
    const configured = {
      ...settings,
      deposits: {
        enabled: false,
        mode: 'none',
        fixedAmount: null,
        percentageOfTotal: null,
        requiredForPartySizeGte: null,
        paymentWindowHrs: 24,
      },
      payments: { appointmentUpfrontDefault: 'at_venue', classUpfrontDefault: 'required' },
    } as any
    const stripeMerchant = { id: 'merchant-1', platformFeeBps: 500 } as any
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue(configured)
    jest.spyOn(ecommerceCapability, 'resolveChargeableStripeMerchant').mockResolvedValue(stripeMerchant)
    jest.spyOn(reservationService, 'calculateDepositAmount').mockReturnValue({ required: true, amount: new Prisma.Decimal(240) })
    prismaMock.product.findFirst
      .mockResolvedValueOnce({ type: 'SERVICE' } as any)
      .mockResolvedValueOnce({ type: 'SERVICE' } as any)
      .mockResolvedValueOnce({ type: 'SERVICE', price: new Prisma.Decimal(120), upfrontPolicy: 'required' } as any)
    const created = {
      id: 'reservation-1',
      confirmationCode: 'RES-1',
      cancelSecret: 'secret',
      startsAt,
      endsAt,
      status: 'PENDING',
      depositAmount: null,
      guestEmail: null,
      guestPhone: null,
      productId: 'product-1',
    } as any
    const createSpy = jest.spyOn(reservationService, 'createReservation').mockResolvedValue(created)
    const req: any = {
      params: { venueSlug: 'venue' },
      headers: {},
      body: {
        startsAt,
        endsAt,
        duration: 60,
        partySize: 2,
        productId: 'product-1',
        paymentPolicyOverride: { deposits: { fixedAmount: 1 } },
        scheduling: { autoConfirm: false },
      },
    }
    const res = responseMock()
    const next = jest.fn()

    await publicController.createReservation(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalledWith('venue-1', expect.objectContaining({ channel: 'WEB', productId: 'product-1' }), {
      writeOrigin: 'PUBLIC',
      paymentPolicyOverride: {
        deposits: {
          enabled: true,
          mode: 'prepaid',
          fixedAmount: 240,
          percentageOfTotal: null,
          requiredForPartySizeGte: null,
          paymentWindowHrs: 24,
        },
      },
    })
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'PENDING' }))
  })

  it('dashboard normalizes and forwards canonical products plus every new option', async () => {
    const availability = jest.spyOn(availabilityService, 'getAvailableSlots').mockResolvedValue([ordinarySlot])
    const req: any = {
      params: { venueId: 'venue-1' },
      query: {
        date,
        duration: 75,
        partySize: 2,
        tableId: 'table-1',
        staffId: 'staff-1',
        productId: 'product-1',
        productIds: ['product-1,product-2', 'product-1'],
        includeFull: false,
        windowSemantics: 'base',
      },
    }
    const res = responseMock()
    const next = jest.fn()

    await dashboardController.getAvailability(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(availability).toHaveBeenCalledWith(
      'venue-1',
      date,
      {
        duration: 75,
        partySize: 2,
        tableId: 'table-1',
        staffId: 'staff-1',
        productId: 'product-1',
        productIds: ['product-1', 'product-2'],
        includeFull: false,
        windowSemantics: 'base',
      },
      settings,
      'UTC',
    )
  })

  it('public appointment availability forwards canonical staff-aware options and serializes FULL explicitly', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ type: 'APPOINTMENTS_SERVICE' })
    const availability = jest.spyOn(availabilityService, 'getAvailableSlots').mockResolvedValue([ordinarySlot, fullSlot])
    const req: any = {
      params: { venueSlug: 'venue' },
      query: {
        date,
        duration: 5,
        partySize: 1,
        staffId: 'staff-1',
        productId: 'product-1',
        productIds: [' product-1,product-2 ', '', 'product-1'],
        includeFull: true,
        windowSemantics: 'base',
      },
    }
    const res = responseMock()
    const next = jest.fn()

    await publicController.getAvailability(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(availability).toHaveBeenCalledWith(
      'venue-1',
      date,
      {
        duration: 5,
        partySize: 1,
        staffId: 'staff-1',
        productId: 'product-1',
        productIds: ['product-1', 'product-2'],
        includeFull: true,
        windowSemantics: 'base',
      },
      settings,
      'UTC',
    )
    expect(res.json).toHaveBeenCalledWith({
      date,
      slots: [
        { startsAt, endsAt, available: true },
        { startsAt, endsAt, available: false, reason: 'FULL' },
      ],
    })
  })

  it.each([
    ['scalar only', { productId: 'product-1' }, ['product-1']],
    [
      'twenty canonical products',
      { productIds: Array.from({ length: 20 }, (_, index) => `product-${index}`) },
      Array.from({ length: 20 }, (_, index) => `product-${index}`),
    ],
    ['twenty-one duplicate raw products', { productIds: Array.from({ length: 21 }, () => 'product-1') }, ['product-1']],
  ])('public availability forwards canonical products for %s', async (_label, products, expectedProductIds) => {
    prismaMock.product.findFirst.mockResolvedValue({ type: 'APPOINTMENTS_SERVICE' })
    const availability = jest.spyOn(availabilityService, 'getAvailableSlots').mockResolvedValue([ordinarySlot])
    const req: any = { params: { venueSlug: 'venue' }, query: { date, ...products } }
    const next = jest.fn()

    await publicController.getAvailability(req, responseMock(), next)

    expect(next).not.toHaveBeenCalled()
    expect(availability).toHaveBeenCalledWith(
      'venue-1',
      date,
      expect.objectContaining({ productId: expectedProductIds[0], productIds: expectedProductIds }),
      settings,
      'UTC',
    )
  })

  it.each([
    ['conflicting scalar/list', { productId: 'product-b', productIds: 'product-a,product-b' }],
    ['explicit empty list plus scalar', { productId: 'product-a', productIds: [] }],
    ['explicit empty CSV plus scalar', { productId: 'product-a', productIds: ' , ' }],
    ['more than twenty canonical products', { productIds: Array.from({ length: 21 }, (_, index) => `product-${index}`) }],
  ])('rejects public availability product identity (%s) before catalog or availability work', async (_label, products) => {
    const availability = jest.spyOn(availabilityService, 'getAvailableSlots')
    const req: any = { params: { venueSlug: 'venue' }, query: { date, ...products } }
    const next = jest.fn()

    await publicController.getAvailability(req, responseMock(), next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: expect.stringMatching(/coincidir|20/i) }))
    expect(prismaMock.product.findFirst).not.toHaveBeenCalled()
    expect(availability).not.toHaveBeenCalled()
  })

  it.each([
    ['scalar only', { productId: 'product-a' }, ['product-a']],
    ['matching scalar/list', { productId: 'product-a', productIds: 'product-a,product-b' }, ['product-a', 'product-b']],
    ['CSV', { productIds: 'product-b,product-a,product-b' }, ['product-b', 'product-a']],
    [
      'repeated-array CSV with whitespace and empties',
      { productIds: [' product-b, product-a ', '', 'product-c', 'product-a'] },
      ['product-b', 'product-a', 'product-c'],
    ],
    [
      'twenty canonical products',
      { productIds: Array.from({ length: 20 }, (_, index) => `product-${index}`) },
      Array.from({ length: 20 }, (_, index) => `product-${index}`),
    ],
    ['twenty-one duplicate raw products', { productIds: Array.from({ length: 21 }, () => 'product-a') }, ['product-a']],
  ])('public appointment hold persists exact canonical products for %s', async (_label, products, expectedProductIds) => {
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue({
      ...settings,
      scheduling: { ...settings.scheduling, capacityMode: 'pacing', pacingMaxPerSlot: null },
      publicBooking: { ...settings.publicBooking, showStaffPicker: false },
    })
    prismaMock.product.findMany.mockResolvedValue(
      expectedProductIds.map(id => ({ id, type: 'APPOINTMENTS_SERVICE', duration: 60, durationMinutes: null })) as any,
    )
    prismaMock.productModifierGroup.findMany.mockResolvedValue([])
    prismaMock.externalBusyBlock.findFirst.mockResolvedValue(null)
    prismaMock.slotHold.create.mockResolvedValue({
      id: 'hold-1',
      expiresAt: new Date('2026-08-21T15:10:00.000Z'),
      staffId: null,
    } as any)
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    ;(prismaMock as any).$executeRaw = jest.fn().mockResolvedValue(1)
    jest.spyOn(appointmentStaffAssignmentService, 'lockAppointmentVenue').mockResolvedValue()
    jest.spyOn(availabilityService, 'countAppointmentOccupancy').mockResolvedValue({ reservations: 0, holds: 0 })
    const req: any = {
      params: { venueSlug: 'venue' },
      body: { startsAt, endsAt, partySize: 2, fingerprint: 'browser-1', ...products },
    }
    const res = responseMock()
    const next = jest.fn()

    await publicController.createHold(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.create).toHaveBeenCalledWith({
      data: {
        venueId: 'venue-1',
        startsAt,
        endsAt,
        productIds: expectedProductIds,
        classSessionId: null,
        staffId: null,
        heldForReservationId: null,
        windowSemantics: null,
        partySize: 2,
        expiresAt: expect.any(Date),
        fingerprint: 'browser-1',
      },
      select: { id: true, expiresAt: true, staffId: true },
    })
    expect(res.status).toHaveBeenCalledWith(201)
  })

  it('mints a base appointment hold with its server-resolved final window and assigned staff', async () => {
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue({
      ...settings,
      scheduling: { ...settings.scheduling, pacingMaxPerSlot: 2 },
      publicBooking: { ...settings.publicBooking, showStaffPicker: true },
    })
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    ;(prismaMock as any).$executeRaw = jest.fn().mockResolvedValue(1)
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'product-1', type: 'APPOINTMENTS_SERVICE', duration: 60, durationMinutes: null },
    ] as any)
    jest.spyOn(appointmentWindowService, 'resolveAppointmentWindow').mockResolvedValue({
      startsAt,
      baseEndsAt: endsAt,
      finalEndsAt: new Date(endsAt.getTime() + 15 * 60_000),
      canonicalBaseDurationMin: 60,
      modifierDurationDelta: 15,
      finalDurationMin: 75,
      productIds: ['product-1'],
      modifierRows: [],
      modifierPriceDelta: new Prisma.Decimal(0),
    })
    jest.spyOn(appointmentStaffAssignmentService, 'lockAppointmentVenue').mockResolvedValue()
    jest.spyOn(appointmentStaffAssignmentService, 'resolveStaffAssignment').mockResolvedValue('staff-1')
    jest.spyOn(availabilityService, 'countAppointmentOccupancy').mockResolvedValue({ reservations: 0, holds: 0 })
    prismaMock.externalBusyBlock.findFirst.mockResolvedValue(null)
    prismaMock.slotHold.create.mockResolvedValue({
      id: 'hold-base',
      expiresAt: new Date('2026-08-21T15:10:00.000Z'),
      staffId: 'staff-1',
    } as any)
    const req: any = {
      params: { venueSlug: 'venue' },
      body: {
        startsAt,
        endsAt,
        productIds: ['product-1'],
        partySize: 1,
        staffId: 'staff-1',
        windowSemantics: 'base',
        modifierSelections: [{ productId: 'product-1', modifierId: 'modifier-1' }],
      },
    }
    const res = responseMock()
    const next = jest.fn()

    await publicController.createHold(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        venueId: 'venue-1',
        startsAt,
        endsAt: new Date('2026-08-21T16:15:00.000Z'),
        productIds: ['product-1'],
        classSessionId: null,
        staffId: 'staff-1',
        heldForReservationId: null,
        windowSemantics: 'base',
      }),
      select: { id: true, expiresAt: true, staffId: true },
    })
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ holdId: 'hold-base', staffId: 'staff-1', ttlSeconds: 600 }))
  })

  it.each([
    ['conflicting scalar/list', { productId: 'product-b', productIds: 'product-a,product-b' }],
    ['explicit empty list plus scalar', { productId: 'product-a', productIds: [] }],
    ['explicit empty CSV plus scalar', { productId: 'product-a', productIds: ' , ' }],
    ['more than twenty canonical products', { productIds: Array.from({ length: 21 }, (_, index) => `product-${index}`) }],
  ])('rejects public hold product identity (%s) before catalog or hold writes', async (_label, products) => {
    const req: any = { params: { venueSlug: 'venue' }, body: { startsAt, endsAt, ...products } }
    const next = jest.fn()

    await publicController.createHold(req, responseMock(), next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: expect.stringMatching(/coincidir|20/i) }))
    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.create).not.toHaveBeenCalled()
  })

  it('keeps an explicitly empty generic hold valid and persists an empty product list', async () => {
    prismaMock.slotHold.create.mockResolvedValue({ id: 'generic-hold', expiresAt: new Date('2026-08-21T15:10:00.000Z') } as any)
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    const req: any = { params: { venueSlug: 'venue' }, body: { startsAt, endsAt, productIds: [] } }
    const next = jest.fn()

    await publicController.createHold(req, responseMock(), next)

    expect(next).not.toHaveBeenCalled()
    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ venueId: 'venue-1', productIds: [], classSessionId: null }),
      select: { id: true, expiresAt: true },
    })
  })

  it('keeps the legacy class hold when classSessionId accompanies a scalar class productId', async () => {
    prismaMock.product.findMany.mockResolvedValue([{ id: 'class-product', type: 'CLASS' }] as any)
    prismaMock.classSession.findFirst.mockResolvedValue({ id: 'class-session-1' } as any)
    prismaMock.slotHold.create.mockResolvedValue({ id: 'class-hold', expiresAt: new Date('2026-08-21T15:10:00.000Z') } as any)
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    const req: any = {
      params: { venueSlug: 'venue' },
      body: { startsAt, endsAt, productId: 'class-product', classSessionId: 'class-session-1', partySize: 3 },
    }
    const next = jest.fn()

    await publicController.createHold(req, responseMock(), next)

    expect(next).not.toHaveBeenCalled()
    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
    expect(prismaMock.classSession.findFirst).toHaveBeenCalledWith({
      where: { id: 'class-session-1', venueId: 'venue-1' },
      select: { id: true },
    })
    expect(prismaMock.slotHold.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ productIds: [], classSessionId: 'class-session-1', partySize: 3 }),
      select: { id: true, expiresAt: true },
    })
  })

  it('uses the canonical trimmed scalar throughout product-scoped CLASS availability', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ type: 'CLASS' })
    const appointmentAvailability = jest.spyOn(availabilityService, 'getAvailableSlots')
    const classAvailability = jest.spyOn(availabilityService, 'getClassSessionSlots').mockResolvedValue([
      {
        classSessionId: 'class-1',
        startsAt,
        endsAt,
        duration: 60,
        capacity: 10,
        enrolled: 3,
        remaining: 7,
        available: true,
        takenSpotIds: ['spot-1'],
        instructor: { firstName: 'Ana', lastName: 'Alfa' },
      },
    ])
    const req: any = { params: { venueSlug: 'venue' }, query: { date, productId: ' class-product ' } }
    const res = responseMock()
    const next = jest.fn()

    await publicController.getAvailability(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(prismaMock.product.findFirst).toHaveBeenCalledWith({
      where: { id: 'class-product', venueId: 'venue-1', active: true },
      select: { type: true },
    })
    expect(classAvailability).toHaveBeenCalledWith('venue-1', 'class-product', date, 100, 'UTC')
    expect(appointmentAvailability).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      date,
      slots: [
        {
          startsAt,
          endsAt,
          available: true,
          classSessionId: 'class-1',
          capacity: 10,
          enrolled: 3,
          remaining: 7,
          takenSpotIds: ['spot-1'],
          instructor: { firstName: 'Ana', lastName: 'Alfa' },
        },
      ],
    })
  })

  it('public reschedule preserves stored duration/current staff and canonical persisted products', async () => {
    const reservation = {
      id: 'reservation-1',
      venueId: 'venue-1',
      status: 'CONFIRMED',
      startsAt: new Date(Date.now() + 48 * 60 * 60_000),
      duration: 75,
      productId: 'product-1',
      productIds: ['product-1', 'product-2'],
      assignedStaffId: 'staff-1',
      classSessionId: null,
      venue: { timezone: 'UTC' },
    } as any
    jest.spyOn(reservationService, 'getReservationByCancelSecret').mockResolvedValue(reservation)
    const availability = jest.spyOn(availabilityService, 'getAvailableSlots').mockResolvedValue([ordinarySlot])
    const req: any = { params: { venueSlug: 'venue', cancelSecret: 'secret' }, query: { date, duration: 5, fixedDurationMin: 5 } }
    const res = responseMock()
    const next = jest.fn()

    await publicController.getRescheduleAvailability(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(availability).toHaveBeenCalledWith(
      'venue-1',
      date,
      {
        productId: 'product-1',
        productIds: ['product-1', 'product-2'],
        staffId: 'staff-1',
        excludeReservationId: 'reservation-1',
        fixedDurationMin: 75,
      },
      settings,
      'UTC',
    )
    expect(res.json).toHaveBeenCalledWith({ date, slots: [{ startsAt, endsAt, available: true }] })
  })
})
