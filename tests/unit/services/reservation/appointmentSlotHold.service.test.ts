import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import {
  assertReschedulePolicy,
  fastFailLiveHold,
  lockAndValidateNormalAppointmentHold,
  lockAndValidateRescheduleAppointmentHold,
  mintNormalAppointmentHold,
  mintRescheduleAppointmentHold,
  SLOT_HOLD_TTL_MS,
} from '@/services/reservation/appointmentSlotHold.service'
import * as settingsService from '@/services/dashboard/reservationSettings.service'
import * as assignmentService from '@/services/dashboard/appointmentStaffAssignment.service'
import * as availabilityService from '@/services/dashboard/reservationAvailability.service'
import * as windowService from '@/services/reservation/resolveAppointmentWindow'
import * as modifierService from '@/services/reservation/resolveModifierSelections'
import type { ReservationConfig } from '@/services/dashboard/reservationSettings.service'

const venueId = 'venue-1'
const productId = 'product-1'
const startsAt = new Date('2026-09-01T15:00:00.000Z')
const rawEndsAt = new Date('2026-09-01T16:00:00.000Z')
const finalEndsAt = new Date('2026-09-01T16:15:00.000Z')

function settings(overrides: { staffAware?: boolean; picker?: boolean; pacing?: number | null } = {}): ReservationConfig {
  const staffAware = overrides.staffAware ?? true
  return {
    scheduling: {
      slotIntervalMin: 15,
      defaultDurationMin: 60,
      autoConfirm: true,
      maxAdvanceDays: 365,
      minNoticeMin: 0,
      noShowGraceMin: 15,
      pacingMaxPerSlot: overrides.pacing ?? 2,
      onlineCapacityPercent: 100,
      capacityMode: staffAware ? 'per_staff' : 'pacing',
    },
    deposits: {
      enabled: false,
      mode: 'none',
      percentageOfTotal: null,
      fixedAmount: null,
      requiredForPartySizeGte: null,
      paymentWindowHrs: 24,
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
      showStaffPicker: overrides.picker ?? staffAware,
    },
    googleCalendar: {
      pushEnabled: false,
      dualWrite: false,
      eventDetailLevel: 'FULL',
      removeCancelled: false,
      classRosterInDescription: false,
    },
    operatingHours: settingsService.getDefaultOperatingHours(),
  }
}

function baseResolvedWindow() {
  return {
    startsAt,
    baseEndsAt: rawEndsAt,
    finalEndsAt,
    canonicalBaseDurationMin: 60,
    modifierDurationDelta: 15,
    finalDurationMin: 75,
    productIds: [productId],
    modifierRows: [],
    modifierPriceDelta: new Prisma.Decimal(0),
  }
}

describe('mintNormalAppointmentHold', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.resetAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue(settings())
    jest.spyOn(windowService, 'resolveAppointmentWindow').mockResolvedValue(baseResolvedWindow())
    jest.spyOn(windowService, 'resolveCanonicalAppointmentDuration').mockResolvedValue({
      productIds: [productId],
      canonicalBaseDurationMin: 60,
    })
    jest.spyOn(windowService, 'assertLegacyAppointmentDurationFloor').mockResolvedValue()
    jest.spyOn(modifierService, 'resolveModifierSelections').mockResolvedValue({
      persistRows: [],
      totalDelta: new Prisma.Decimal(0),
      totalDurationDelta: 15,
    })
    jest.spyOn(assignmentService, 'lockAppointmentVenue').mockResolvedValue()
    jest.spyOn(assignmentService, 'resolveStaffAssignment').mockResolvedValue('staff-1')
    jest.spyOn(availabilityService, 'countAppointmentOccupancy').mockResolvedValue({ reservations: 0, holds: 0 })
    prismaMock.externalBusyBlock.findFirst.mockResolvedValue(null)
    prismaMock.slotHold.create.mockImplementation(async ({ data }: any) => ({
      id: 'hold-1',
      expiresAt: data.expiresAt,
      staffId: data.staffId,
    }))
  })

  it('persists the base final interval, marker, effective staff, and post-lock ten-minute TTL', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T10:00:00.000Z'))
    try {
      const lock = jest.spyOn(assignmentService, 'lockAppointmentVenue').mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-08-01T10:00:03.000Z'))
      })
      const capacity = jest.spyOn(availabilityService, 'countAppointmentOccupancy')

      const hold = await mintNormalAppointmentHold({
        venueId,
        startsAt,
        endsAt: rawEndsAt,
        productIds: [productId],
        staffId: 'staff-1',
        windowSemantics: 'base',
        modifierSelections: [{ productId, modifierId: 'modifier-1' }],
      })

      expect(prismaMock.slotHold.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          startsAt,
          endsAt: finalEndsAt,
          productIds: [productId],
          classSessionId: null,
          staffId: 'staff-1',
          heldForReservationId: null,
          windowSemantics: 'base',
          expiresAt: new Date('2026-08-01T10:10:03.000Z'),
        }),
        select: { id: true, expiresAt: true, staffId: true },
      })
      expect(hold.expiresAt.getTime() - new Date('2026-08-01T10:00:03.000Z').getTime()).toBe(SLOT_HOLD_TTL_MS)
      expect(lock.mock.invocationCallOrder[0]).toBeLessThan(capacity.mock.invocationCallOrder[0])
      expect(capacity.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.slotHold.create.mock.invocationCallOrder[0])
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps a legacy raw interval and null marker after validating its duration floor and modifiers', async () => {
    const floor = jest.spyOn(windowService, 'assertLegacyAppointmentDurationFloor')
    const modifiers = jest.spyOn(modifierService, 'resolveModifierSelections')

    await mintNormalAppointmentHold({
      venueId,
      startsAt,
      endsAt: rawEndsAt,
      productIds: [productId],
      modifierSelections: [{ productId, modifierId: 'modifier-1' }],
    })

    expect(floor).toHaveBeenCalledWith(prismaMock, expect.objectContaining({ venueId, productIds: [productId], rawDurationMin: 60 }))
    expect(modifiers).toHaveBeenCalledTimes(1)
    expect(prismaMock.slotHold.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ endsAt: rawEndsAt, windowSemantics: null }),
      select: { id: true, expiresAt: true, staffId: true },
    })
  })

  it('does not lock or write when the legacy staff-aware duration floor fails', async () => {
    jest
      .spyOn(windowService, 'assertLegacyAppointmentDurationFloor')
      .mockRejectedValue(Object.assign(new Error('changed'), { statusCode: 409, code: 'APPOINTMENT_WINDOW_CHANGED' }))
    const lock = jest.spyOn(assignmentService, 'lockAppointmentVenue')

    await expect(mintNormalAppointmentHold({ venueId, startsAt, endsAt: rawEndsAt, productIds: [productId] })).rejects.toMatchObject({
      statusCode: 409,
      code: 'APPOINTMENT_WINDOW_CHANGED',
    })
    expect(lock).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.create).not.toHaveBeenCalled()
  })

  it('repeats settings, resolution, lock, capacity, and write on a serialization retry', async () => {
    prismaMock.slotHold.create
      .mockRejectedValueOnce(Object.assign(new Error('retry'), { code: 'P2034' }))
      .mockImplementationOnce(async ({ data }: any) => ({ id: 'hold-1', expiresAt: data.expiresAt, staffId: data.staffId }))

    await mintNormalAppointmentHold({
      venueId,
      startsAt,
      endsAt: rawEndsAt,
      productIds: [productId],
      windowSemantics: 'base',
    })

    expect(settingsService.getReservationSettings).toHaveBeenCalledTimes(2)
    expect(windowService.resolveAppointmentWindow).toHaveBeenCalledTimes(2)
    expect(assignmentService.lockAppointmentVenue).toHaveBeenCalledTimes(2)
    expect(assignmentService.resolveStaffAssignment).toHaveBeenCalledTimes(2)
    expect(prismaMock.externalBusyBlock.findFirst).toHaveBeenCalledTimes(2)
    expect(availabilityService.countAppointmentOccupancy).toHaveBeenCalledTimes(2)
    expect(prismaMock.slotHold.create).toHaveBeenCalledTimes(2)
  })
})

describe('mintRescheduleAppointmentHold', () => {
  const requestedStartsAt = new Date('2026-09-02T15:00:00.000Z')
  const sibling = {
    id: 'hold-old',
    venueId,
    startsAt,
    endsAt: rawEndsAt,
    productIds: [productId],
    classSessionId: null,
    staffId: 'staff-1',
    heldForReservationId: 'reservation-1',
    windowSemantics: null,
    partySize: 2,
    expiresAt: new Date('2026-08-01T10:09:00.000Z'),
  }

  function reservation(overrides: Record<string, unknown> = {}) {
    return {
      id: 'reservation-1',
      venueId,
      startsAt,
      endsAt: rawEndsAt,
      duration: 60,
      productId,
      productIds: [productId, 'product-2'],
      tableId: null,
      assignedStaffId: 'staff-1',
      partySize: 2,
      classSessionId: null,
      status: 'CONFIRMED',
      ...overrides,
    }
  }

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.resetAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue(settings({ staffAware: true, pacing: 1 }))
    jest.spyOn(assignmentService, 'lockAppointmentVenue').mockResolvedValue()
    jest.spyOn(assignmentService, 'assertStaffEligibleForPersistedProducts').mockResolvedValue()
    jest.spyOn(availabilityService, 'countAppointmentOccupancy').mockResolvedValue({ reservations: 0, holds: 0 })
    jest
      .spyOn(windowService, 'resolveCanonicalAppointmentDuration')
      .mockRejectedValue(new Error('reschedule must not read current Product duration'))
    jest.spyOn(windowService, 'resolveAppointmentWindow').mockRejectedValue(new Error('reschedule must not resolve a canonical window'))
    jest.spyOn(modifierService, 'resolveModifierSelections').mockRejectedValue(new Error('reschedule must not re-sum modifiers'))
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'UTC' } as any)
    prismaMock.externalBusyBlock.findFirst.mockResolvedValue(null)
    prismaMock.slotHold.deleteMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.slotHold.create.mockImplementation(async ({ data }: any) => ({
      id: 'hold-new',
      expiresAt: data.expiresAt,
      staffId: data.staffId,
    }))
  })

  it.each([
    ['Product changed 60→90', 60, 90],
    ['Product changed 90→60', 90, 60],
  ])(
    'keeps fixed historical R.duration when %s and never resolves current catalog/modifiers',
    async (_label, duration, currentDuration) => {
      prismaMock.$queryRaw.mockResolvedValueOnce([reservation({ duration })] as any).mockResolvedValueOnce([sibling] as any)
      const requestedEndsAt = new Date(requestedStartsAt.getTime() + duration * 60_000)
      jest.spyOn(windowService, 'resolveCanonicalAppointmentDuration').mockImplementation(async () => ({
        productIds: [productId, 'product-2'],
        canonicalBaseDurationMin: currentDuration,
      }))

      await mintRescheduleAppointmentHold({
        venueId,
        reservationId: 'reservation-1',
        requestedStartsAt,
        requestedEndsAt,
        clock: () => new Date('2026-08-01T10:00:00.000Z'),
      })

      expect(prismaMock.slotHold.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          startsAt: requestedStartsAt,
          endsAt: requestedEndsAt,
          productIds: [productId, 'product-2'],
          staffId: 'staff-1',
          heldForReservationId: 'reservation-1',
          windowSemantics: null,
          classSessionId: null,
          partySize: 2,
          fingerprint: null,
        }),
        select: { id: true, expiresAt: true, staffId: true },
      })
      expect(windowService.resolveCanonicalAppointmentDuration).not.toHaveBeenCalled()
      expect(windowService.resolveAppointmentWindow).not.toHaveBeenCalled()
      expect(modifierService.resolveModifierSelections).not.toHaveBeenCalled()
    },
  )

  it('locks settings → venue → R → stable siblings, captures TTL after locks, then replaces before pacing', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T10:00:00.000Z'))
    const order: string[] = []
    try {
      jest.spyOn(settingsService, 'getReservationSettings').mockImplementation(async () => {
        order.push('settings')
        return settings({ staffAware: true, pacing: 1 })
      })
      jest.spyOn(assignmentService, 'lockAppointmentVenue').mockImplementation(async () => {
        order.push('venue-lock')
      })
      prismaMock.$queryRaw
        .mockImplementationOnce(async () => {
          order.push('reservation-lock')
          return [reservation()]
        })
        .mockImplementationOnce(async () => {
          order.push('siblings-lock')
          jest.setSystemTime(new Date('2026-08-01T10:00:04.000Z'))
          return [sibling]
        })
      prismaMock.slotHold.deleteMany.mockImplementation(async () => {
        order.push('siblings-delete')
        return { count: 1 }
      })
      jest.spyOn(availabilityService, 'countAppointmentOccupancy').mockImplementation(async () => {
        order.push('capacity')
        return { reservations: 0, holds: 0 }
      })
      prismaMock.slotHold.create.mockImplementation(async ({ data }: any) => {
        order.push('insert')
        return { id: 'hold-new', expiresAt: data.expiresAt, staffId: data.staffId }
      })

      const hold = await mintRescheduleAppointmentHold({
        venueId,
        reservationId: 'reservation-1',
        requestedStartsAt,
      })

      expect(order).toEqual(['settings', 'venue-lock', 'reservation-lock', 'siblings-lock', 'siblings-delete', 'capacity', 'insert'])
      expect((prismaMock.$queryRaw.mock.calls[1][0] as TemplateStringsArray).join('?')).toMatch(
        /heldForReservationId[\s\S]*ORDER BY id[\s\S]*FOR UPDATE/i,
      )
      expect((prismaMock.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?')).toMatch(
        /FROM "Reservation"[\s\S]*WHERE id = \? AND "venueId" = \?[\s\S]*FOR UPDATE/i,
      )
      expect(prismaMock.$queryRaw.mock.calls[0].slice(1)).toEqual(['reservation-1', venueId])
      expect(availabilityService.countAppointmentOccupancy).toHaveBeenCalledWith(prismaMock, {
        venueId,
        startsAt: requestedStartsAt,
        endsAt: new Date(requestedStartsAt.getTime() + 60 * 60_000),
        checkedAt: new Date('2026-08-01T10:00:04.000Z'),
        excludeReservationId: 'reservation-1',
      })
      expect(hold.expiresAt).toEqual(new Date('2026-08-01T10:10:04.000Z'))
      expect(prismaMock.slotHold.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ expiresAt: new Date('2026-08-01T10:10:04.000Z') }) }),
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it('deletes H1 before checking an overlapping H2 and relies on rollback to preserve H1 when the target is full', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([reservation()] as any).mockResolvedValueOnce([sibling] as any)
    const capacity = jest.spyOn(availabilityService, 'countAppointmentOccupancy').mockResolvedValue({ reservations: 1, holds: 0 })

    await expect(mintRescheduleAppointmentHold({ venueId, reservationId: 'reservation-1', requestedStartsAt })).rejects.toMatchObject({
      statusCode: 409,
    })

    expect(prismaMock.slotHold.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(capacity.mock.invocationCallOrder[0])
    expect(prismaMock.slotHold.create).not.toHaveBeenCalled()
  })

  it.each([-60_000, 60_000])('accepts a legacy requested endsAt at the inclusive ±1 minute boundary (%i ms)', async delta => {
    prismaMock.$queryRaw.mockResolvedValueOnce([reservation()] as any).mockResolvedValueOnce([sibling] as any)
    const derivedEndsAt = new Date(requestedStartsAt.getTime() + 60 * 60_000)

    await expect(
      mintRescheduleAppointmentHold({
        venueId,
        reservationId: 'reservation-1',
        requestedStartsAt,
        requestedEndsAt: new Date(derivedEndsAt.getTime() + delta),
      }),
    ).resolves.toMatchObject({ id: 'hold-new' })
    expect(prismaMock.slotHold.create.mock.calls[0][0].data.endsAt).toEqual(derivedEndsAt)
  })

  it('rejects a legacy requested endsAt outside ±1 minute before deleting H1', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([reservation()] as any).mockResolvedValueOnce([sibling] as any)
    const derivedEndsAt = new Date(requestedStartsAt.getTime() + 60 * 60_000)

    await expect(
      mintRescheduleAppointmentHold({
        venueId,
        reservationId: 'reservation-1',
        requestedStartsAt,
        requestedEndsAt: new Date(derivedEndsAt.getTime() + 60_001),
      }),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.create).not.toHaveBeenCalled()
  })

  it('rejects a past target against the post-lock clock even when minNoticeMin is zero, before deleting H1', async () => {
    const order: string[] = []
    prismaMock.$queryRaw
      .mockImplementationOnce(async () => {
        order.push('reservation-lock')
        return [reservation()]
      })
      .mockImplementationOnce(async () => {
        order.push('siblings-lock')
        return [sibling]
      })

    await expect(
      mintRescheduleAppointmentHold({
        venueId,
        reservationId: 'reservation-1',
        requestedStartsAt,
        clock: () => {
          order.push('clock')
          return new Date('2026-09-02T15:00:01.000Z')
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: 'Ese horario ya pasó, elige otro.' })

    expect(order).toEqual(['reservation-lock', 'siblings-lock', 'clock'])
    expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.create).not.toHaveBeenCalled()
  })

  it.each([
    ['off-grid', new Date('2026-09-02T15:07:00.000Z')],
    ['outside venue operating hours', new Date('2026-09-02T08:00:00.000Z')],
  ])('rejects a %s target from the authoritative venue grid before deleting H1', async (_label, targetStartsAt) => {
    prismaMock.$queryRaw.mockResolvedValueOnce([reservation()] as any).mockResolvedValueOnce([sibling] as any)

    await expect(
      mintRescheduleAppointmentHold({
        venueId,
        reservationId: 'reservation-1',
        requestedStartsAt: targetStartsAt,
        clock: () => new Date('2026-08-01T10:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: 'Ese horario ya no está disponible, elige otro.' })

    expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.slotHold.create).not.toHaveBeenCalled()
  })

  it('rereads settings/R/siblings and repeats every lock and staff gate after a serialization retry', async () => {
    const first = reservation({ duration: 60 })
    const second = reservation({ duration: 90 })
    let rawCall = 0
    prismaMock.$queryRaw.mockImplementation(async () => {
      const call = rawCall++
      if (call === 0) return [first]
      if (call === 1) return [sibling]
      if (call === 2) return [second]
      return [sibling]
    })
    prismaMock.slotHold.create
      .mockRejectedValueOnce(Object.assign(new Error('retry'), { code: 'P2034' }))
      .mockImplementationOnce(async ({ data }: any) => ({ id: 'hold-new', expiresAt: data.expiresAt, staffId: data.staffId }))

    await mintRescheduleAppointmentHold({ venueId, reservationId: 'reservation-1', requestedStartsAt })

    expect(settingsService.getReservationSettings).toHaveBeenCalledTimes(2)
    expect(assignmentService.lockAppointmentVenue).toHaveBeenCalledTimes(2)
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(4)
    expect(prismaMock.slotHold.deleteMany).toHaveBeenCalledTimes(2)
    expect(assignmentService.assertStaffEligibleForPersistedProducts).toHaveBeenCalledTimes(2)
    expect(availabilityService.countAppointmentOccupancy).toHaveBeenCalledTimes(2)
    expect(prismaMock.slotHold.create).toHaveBeenCalledTimes(2)
    expect(prismaMock.slotHold.create.mock.calls[1][0].data.endsAt).toEqual(new Date(requestedStartsAt.getTime() + 90 * 60_000))
  })
})

describe('reschedule policy and locked hold identity', () => {
  const requestedStartsAt = new Date('2026-09-02T15:00:00.000Z')
  const checkedAt = new Date('2026-08-01T10:00:00.000Z')
  const reservation = {
    id: 'reservation-1',
    venueId,
    startsAt,
    endsAt: rawEndsAt,
    duration: 60,
    productId,
    productIds: [productId, 'product-2'],
    tableId: null,
    assignedStaffId: 'staff-1',
    partySize: 2,
    classSessionId: null,
    status: 'CONFIRMED',
  }
  const taggedHold = {
    id: 'hold-reschedule',
    venueId,
    startsAt: requestedStartsAt,
    endsAt: new Date(requestedStartsAt.getTime() + 60 * 60_000),
    productIds: [productId, 'product-2'],
    classSessionId: null,
    staffId: 'staff-1',
    heldForReservationId: 'reservation-1',
    windowSemantics: null,
    partySize: 2,
    expiresAt: new Date('2026-08-01T10:10:00.000Z'),
  }

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.resetAllMocks()
  })

  it('uses the supplied post-lock clock for status, toggle, and minimum-hours policy', () => {
    expect(() => assertReschedulePolicy(reservation, settings(), checkedAt)).not.toThrow()
    expect(() =>
      assertReschedulePolicy(
        reservation,
        {
          ...settings(),
          cancellation: { ...settings().cancellation, allowCustomerReschedule: false },
        },
        checkedAt,
      ),
    ).toThrow(/no permite/i)
    expect(() =>
      assertReschedulePolicy(
        { ...reservation, startsAt: new Date(checkedAt.getTime() + 30 * 60_000) },
        { ...settings(), cancellation: { ...settings().cancellation, minHoursBeforeStart: 1 } },
        checkedAt,
      ),
    ).toThrow(/menos de 1 horas/i)
  })

  it('captures checkedAt only after the tenant candidate row lock and accepts exact tagged identity', async () => {
    const order: string[] = []
    prismaMock.$queryRaw.mockImplementation(async () => {
      order.push('hold-lock')
      return [taggedHold]
    })

    const result = await lockAndValidateRescheduleAppointmentHold(prismaMock, {
      venueId,
      holdId: taggedHold.id,
      reservation,
      requestedStartsAt,
      settings: settings(),
      clock: () => {
        order.push('clock')
        return checkedAt
      },
    })

    expect(order).toEqual(['hold-lock', 'clock'])
    expect((prismaMock.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?')).toMatch(
      /FROM "SlotHold"[\s\S]*WHERE id = \? AND "venueId" = \?[\s\S]*FOR UPDATE/i,
    )
    expect(prismaMock.$queryRaw.mock.calls[0].slice(1)).toEqual([taggedHold.id, venueId])
    expect(result).toEqual({
      id: taggedHold.id,
      checkedAt,
      endsAt: taggedHold.endsAt,
      productIds: [productId, 'product-2'],
      staffId: 'staff-1',
    })
  })

  it.each([
    ['single legacy', { productIds: [], productId }, [productId]],
    ['multi reservation with old lead-only token', { productIds: [productId, 'product-2'], productId }, [productId]],
    ['canonical multi null token', { productIds: [productId, 'product-2'], productId }, [productId, 'product-2']],
  ])('Release B rejects %s null-token shape', async (_label, reservationProducts, holdProducts) => {
    prismaMock.$queryRaw.mockResolvedValue([{ ...taggedHold, heldForReservationId: null, staffId: null, productIds: holdProducts }] as any)
    const operation = lockAndValidateRescheduleAppointmentHold(prismaMock, {
      venueId,
      holdId: taggedHold.id,
      reservation: { ...reservation, ...reservationProducts },
      requestedStartsAt,
      settings: settings(),
      clock: () => checkedAt,
    })

    await expect(operation).rejects.toMatchObject({ statusCode: 409 })
    expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
  })

  it.each([
    ['R1 token against R2', { heldForReservationId: 'reservation-other' }, {}],
    ['expired after lock wait', { expiresAt: checkedAt }, {}],
    ['class token', { classSessionId: 'class-1' }, {}],
    ['window marker', { windowSemantics: 'base' }, {}],
    ['duration/window change', { endsAt: new Date(taggedHold.endsAt.getTime() + 60_000) }, {}],
    ['party change', { partySize: 3 }, {}],
    ['product change', { productIds: [productId] }, {}],
    ['staff change', { staffId: 'staff-2' }, {}],
    ['cancelled parent', {}, { status: 'CANCELLED' }],
  ])('rejects %s as Spanish 409 and never deletes the candidate', async (_label, holdOverride, reservationOverride) => {
    prismaMock.$queryRaw.mockResolvedValue([{ ...taggedHold, ...holdOverride }] as any)

    await expect(
      lockAndValidateRescheduleAppointmentHold(prismaMock, {
        venueId,
        holdId: taggedHold.id,
        reservation: { ...reservation, ...reservationOverride },
        requestedStartsAt,
        settings: settings(),
        clock: () => checkedAt,
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.any(String) })
    expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
  })
})

describe('normal appointment hold preflight and locked identity', () => {
  const liveRow = {
    id: 'hold-1',
    venueId,
    startsAt,
    endsAt: finalEndsAt,
    productIds: [productId, 'product-2'],
    classSessionId: null,
    staffId: 'staff-1',
    heldForReservationId: null,
    windowSemantics: 'base',
    expiresAt: new Date('2026-08-01T10:10:00.000Z'),
  }
  const validationArgs = {
    venueId,
    holdId: 'hold-1',
    startsAt,
    rawEndsAt,
    finalEndsAt,
    productIds: [productId, 'product-2'],
    requestedStaffWasProvided: false,
    windowSemantics: 'base' as const,
    clock: () => new Date('2026-08-01T10:00:00.000Z'),
  }

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.resetAllMocks()
  })

  it('fast-fails using only tenant existence and obvious JS expiry', async () => {
    prismaMock.slotHold.findFirst.mockResolvedValue({ id: 'hold-1', expiresAt: liveRow.expiresAt } as any)

    await expect(fastFailLiveHold({ venueId, holdId: 'hold-1', checkedAt: new Date('2026-08-01T10:00:00.000Z') })).resolves.toEqual({
      id: 'hold-1',
    })
    expect(prismaMock.slotHold.findFirst).toHaveBeenCalledWith({
      where: { id: 'hold-1', venueId },
      select: { id: true, expiresAt: true },
    })
  })

  it('captures the validation clock only after the tenant-scoped row-lock query and inherits held staff', async () => {
    const order: string[] = []
    prismaMock.$queryRaw.mockImplementation(async () => {
      order.push('row-lock')
      return [liveRow]
    })

    const result = await lockAndValidateNormalAppointmentHold(prismaMock, {
      ...validationArgs,
      clock: () => {
        order.push('clock')
        return new Date('2026-08-01T10:00:00.000Z')
      },
    })

    expect(order).toEqual(['row-lock', 'clock'])
    expect(result).toEqual({ id: 'hold-1', staffId: 'staff-1', checkedAt: new Date('2026-08-01T10:00:00.000Z') })
  })

  it.each([
    ['missing', null],
    ['expired', { expiresAt: new Date('2026-08-01T10:00:00.000Z') }],
    ['class', { classSessionId: 'class-1' }],
    ['new reschedule', { heldForReservationId: 'reservation-1' }],
    ['marker upgrade', { windowSemantics: null }],
    ['product order', { productIds: ['product-2', productId] }],
    ['explicit staff mismatch', { staffId: 'staff-2' }],
  ])('rejects %s with Spanish 409 and never deletes the existing hold', async (label, override) => {
    prismaMock.$queryRaw.mockResolvedValue(override === null ? [] : ([{ ...liveRow, ...override }] as any))

    await expect(
      lockAndValidateNormalAppointmentHold(prismaMock, {
        ...validationArgs,
        ...(label === 'explicit staff mismatch' ? { requestedStaffWasProvided: true, requestedStaffId: 'staff-1' } : {}),
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.any(String) })
    expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
  })

  it('rejects marker downgrade from a base hold to a legacy create and preserves the hold', async () => {
    prismaMock.$queryRaw.mockResolvedValue([liveRow] as any)

    await expect(
      lockAndValidateNormalAppointmentHold(prismaMock, {
        ...validationArgs,
        windowSemantics: undefined,
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.any(String) })
    expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
  })

  it('returns APPOINTMENT_WINDOW_CHANGED for a changed base final interval and preserves the hold', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ ...liveRow, endsAt: new Date(finalEndsAt.getTime() + 60_000) }] as any)

    await expect(lockAndValidateNormalAppointmentHold(prismaMock, validationArgs)).rejects.toMatchObject({
      statusCode: 409,
      code: 'APPOINTMENT_WINDOW_CHANGED',
    })
    expect(prismaMock.slotHold.deleteMany).not.toHaveBeenCalled()
  })
})
