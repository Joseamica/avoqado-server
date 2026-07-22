import * as dashboardController from '@/controllers/dashboard/reservation.dashboard.controller'
import * as publicController from '@/controllers/public/reservation.public.controller'
import * as availabilityService from '@/services/dashboard/reservationAvailability.service'
import * as reservationService from '@/services/dashboard/reservation.dashboard.service'
import * as settingsService from '@/services/dashboard/reservationSettings.service'
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
        productIds: 'product-1,product-2',
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

  it('leaves the product-scoped CLASS branch unchanged', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ type: 'CLASS' })
    const appointmentAvailability = jest.spyOn(availabilityService, 'getAvailableSlots')
    jest.spyOn(availabilityService, 'getClassSessionSlots').mockResolvedValue([
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
    const req: any = { params: { venueSlug: 'venue' }, query: { date, productId: 'class-product' } }
    const res = responseMock()
    const next = jest.fn()

    await publicController.getAvailability(req, res, next)

    expect(next).not.toHaveBeenCalled()
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
