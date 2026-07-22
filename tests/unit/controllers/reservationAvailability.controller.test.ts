import * as dashboardController from '@/controllers/dashboard/reservation.dashboard.controller'
import * as publicController from '@/controllers/public/reservation.public.controller'
import * as availabilityService from '@/services/dashboard/reservationAvailability.service'
import * as reservationService from '@/services/dashboard/reservation.dashboard.service'
import * as settingsService from '@/services/dashboard/reservationSettings.service'
import { prismaMock } from '@tests/__helpers__/setup'

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
