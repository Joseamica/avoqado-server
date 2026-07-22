import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import {
  fastFailLiveHold,
  lockAndValidateNormalAppointmentHold,
  mintNormalAppointmentHold,
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
