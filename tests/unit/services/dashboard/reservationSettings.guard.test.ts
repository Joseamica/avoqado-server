/**
 * updateReservationSettings — online-charging guard (2026-07-07, fixed 2026-07-07).
 *
 * A venue can't TRANSITION any cobro field from off → on (depositMode
 * 'none'→other, an upfront default 'at_venue'→other) unless it has a chargeable
 * e-commerce rail (canVenueChargeOnline → an active Stripe Connect merchant).
 * Turning cobro OFF, or changing non-cobro fields, is always allowed and does
 * not even run the merchant check.
 *
 * The guard compares against the CURRENT DB row, not just the incoming payload
 * — /full-testing caught a bug where a venue with cobro already configured
 * before this gate existed (legacy data) got blocked from saving ANY unrelated
 * setting, because the dashboard form always resends the full deposits/payments
 * object. Resaving an already-charging value (even switching between two
 * charging modes) is allowed; only a genuine off→on transition is blocked.
 */
import { prismaMock } from '../../../__helpers__/setup'
import {
  getReservationSettings,
  isStaffAware,
  updateReservationSettings,
} from '../../../../src/services/dashboard/reservationSettings.service'
import { BadRequestError, ConflictError } from '../../../../src/errors/AppError'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'

const VENUE = 'v-guard-1'
const chargeableMerchant = { id: 'ecm-1', provider: { code: 'STRIPE_CONNECT' } }
const legacyChargingRow = {
  depositMode: 'deposit',
  appointmentUpfrontDefault: 'optional',
  classUpfrontDefault: 'required',
}

describe('updateReservationSettings — online-charging guard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.reservationSettings.upsert.mockResolvedValue({ id: 'rs1' } as never)
  })

  it('rejects enabling a deposit mode when the venue cannot charge online', async () => {
    prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(null) // no chargeable rail
    await expect(updateReservationSettings(VENUE, { depositMode: 'deposit' })).rejects.toThrow(BadRequestError)
    await expect(updateReservationSettings(VENUE, { depositMode: 'deposit' })).rejects.toThrow(/e-?commerce|Stripe|Mercado Pago/i)
    expect(prismaMock.reservationSettings.upsert).not.toHaveBeenCalled()
  })

  it('rejects an upfront default other than at_venue without a chargeable rail', async () => {
    prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(null)
    await expect(updateReservationSettings(VENUE, { classUpfrontDefault: 'required' })).rejects.toThrow(BadRequestError)
    await expect(updateReservationSettings(VENUE, { appointmentUpfrontDefault: 'optional' })).rejects.toThrow(BadRequestError)
    expect(prismaMock.reservationSettings.upsert).not.toHaveBeenCalled()
  })

  it('allows enabling cobro when the venue CAN charge', async () => {
    prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(chargeableMerchant as never)
    await updateReservationSettings(VENUE, { depositMode: 'deposit' })
    expect(prismaMock.reservationSettings.upsert).toHaveBeenCalledTimes(1)
  })

  it('allows turning cobro OFF (none / at_venue) without a rail — guard not even triggered', async () => {
    prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(null)
    await updateReservationSettings(VENUE, { depositMode: 'none', classUpfrontDefault: 'at_venue' })
    expect(prismaMock.reservationSettings.upsert).toHaveBeenCalledTimes(1)
    expect(prismaMock.ecommerceMerchant.findFirst).not.toHaveBeenCalled()
  })

  it('allows non-cobro changes without checking charging capability', async () => {
    await updateReservationSettings(VENUE, { slotIntervalMin: 15 })
    expect(prismaMock.ecommerceMerchant.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.reservationSettings.upsert).toHaveBeenCalledTimes(1)
  })

  // ── Regression: bug found live by /full-testing against avoqado-wellness ──
  describe('resaving an already-charging legacy venue (no merchant)', () => {
    it('allows resending the SAME already-saved charging value untouched (the exact bug reproduced)', async () => {
      prismaMock.reservationSettings.findUnique.mockResolvedValue(legacyChargingRow as never)
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(null) // still no rail
      // Mirrors the dashboard form: resends the full deposits/payments object
      // unchanged, while the operator only touched scheduling.
      await updateReservationSettings(VENUE, {
        slotIntervalMin: 35,
        depositMode: 'deposit',
        appointmentUpfrontDefault: 'optional',
        classUpfrontDefault: 'required',
      })
      expect(prismaMock.reservationSettings.upsert).toHaveBeenCalledTimes(1)
    })

    it('allows switching between two charging modes when already charging without a rail', async () => {
      prismaMock.reservationSettings.findUnique.mockResolvedValue(legacyChargingRow as never)
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(null)
      await updateReservationSettings(VENUE, { depositMode: 'card_hold' }) // deposit -> card_hold, still charging
      expect(prismaMock.reservationSettings.upsert).toHaveBeenCalledTimes(1)
    })

    it('still blocks turning a NON-charging field on for a venue only PARTIALLY charging', async () => {
      // Legacy row has deposits charging but appointments still at_venue —
      // activating appointments specifically is a genuine transition and must
      // still be blocked even though the venue already has some other cobro on.
      prismaMock.reservationSettings.findUnique.mockResolvedValue({ ...legacyChargingRow, appointmentUpfrontDefault: 'at_venue' } as never)
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(null)
      await expect(updateReservationSettings(VENUE, { appointmentUpfrontDefault: 'required' })).rejects.toThrow(BadRequestError)
      expect(prismaMock.reservationSettings.upsert).not.toHaveBeenCalled()
    })
  })

  // ── The protection this guard exists for must still hold for a clean/new venue ──
  describe('activating cobro for the first time (no existing row)', () => {
    it('still blocks depositMode on a brand-new venue (no row yet) without a rail', async () => {
      prismaMock.reservationSettings.findUnique.mockResolvedValue(null)
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(null)
      await expect(updateReservationSettings(VENUE, { depositMode: 'deposit' })).rejects.toThrow(BadRequestError)
      expect(prismaMock.reservationSettings.upsert).not.toHaveBeenCalled()
    })

    it('still blocks classUpfrontDefault=required on a brand-new venue — does NOT use the required business-default as a free pass', async () => {
      // classUpfrontDefault's getDefaultConfig() display-default is 'required' (a
      // product choice for fresh venues), which must NOT be mistaken by the guard
      // for "this venue already had cobro activated by a human".
      prismaMock.reservationSettings.findUnique.mockResolvedValue(null)
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(null)
      await expect(updateReservationSettings(VENUE, { classUpfrontDefault: 'required' })).rejects.toThrow(BadRequestError)
      expect(prismaMock.reservationSettings.upsert).not.toHaveBeenCalled()
    })

    it('allows activating cobro on a brand-new venue when it DOES have a chargeable rail', async () => {
      prismaMock.reservationSettings.findUnique.mockResolvedValue(null)
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(chargeableMerchant as never)
      await updateReservationSettings(VENUE, { classUpfrontDefault: 'required' })
      expect(prismaMock.reservationSettings.upsert).toHaveBeenCalledTimes(1)
    })
  })
})

describe('reservation staff-aware settings', () => {
  beforeEach(() => {
    prismaMock.reservationSettings.upsert.mockResolvedValue({ id: 'rs-staff-aware' } as never)
  })

  it('keeps legacy-safe defaults and accepts a transaction client', async () => {
    const client = {
      reservationSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    }

    const result = await getReservationSettings(VENUE, client as never)

    expect(result.scheduling.capacityMode).toBe('pacing')
    expect(result.publicBooking.showStaffPicker).toBe(false)
    expect(isStaffAware(result)).toBe(false)
    expect(client.reservationSettings.findUnique).toHaveBeenCalledWith({ where: { venueId: VENUE } })
  })

  it('maps only the supported per_staff value and exposes either opt-in as staff-aware', async () => {
    const storedSettings = {
      slotIntervalMin: 15,
      defaultDurationMin: 60,
      autoConfirm: true,
      maxAdvanceDays: 60,
      minNoticeMin: 60,
      noShowGraceMin: 15,
      pacingMaxPerSlot: null,
      onlineCapacityPercent: 100,
      capacityMode: 'per_staff',
      depositMode: 'none',
      depositPercentage: null,
      depositFixedAmount: null,
      depositPartySizeGte: null,
      depositPaymentWindow: null,
      appointmentUpfrontDefault: 'at_venue',
      classUpfrontDefault: 'required',
      allowCustomerCancel: true,
      minHoursBeforeCancel: 2,
      forfeitDeposit: false,
      noShowFeePercent: null,
      creditRefundMode: 'TIME_BASED',
      creditFreeRefundHoursBefore: 12,
      creditLateRefundPercent: 0,
      creditNoShowRefund: false,
      allowCustomerReschedule: true,
      waitlistEnabled: true,
      waitlistMaxSize: 50,
      waitlistPriorityMode: 'fifo',
      waitlistNotifyWindow: 30,
      remindersEnabled: true,
      reminderChannels: ['EMAIL'],
      reminderMinBefore: [120],
      publicBookingEnabled: true,
      requirePhone: true,
      requireEmail: false,
      requireAccount: false,
      showStaffPicker: false,
      googleCalendarPushEnabled: true,
      googleCalendarDualWrite: false,
      googleCalendarEventDetailLevel: 'FULL',
      googleCalendarRemoveCancelled: false,
      googleCalendarClassRosterInDescription: true,
      operatingHours: null,
    }
    prismaMock.reservationSettings.findUnique.mockResolvedValue(storedSettings as never)

    const result = await getReservationSettings(VENUE)
    expect(result.scheduling.capacityMode).toBe('per_staff')
    expect(isStaffAware(result)).toBe(true)

    prismaMock.reservationSettings.findUnique.mockResolvedValue({
      ...storedSettings,
      capacityMode: 'future_mode',
      showStaffPicker: true,
    } as never)
    const unknownMode = await getReservationSettings(VENUE)
    expect(unknownMode.scheduling.capacityMode).toBe('pacing')
    expect(isStaffAware(unknownMode)).toBe(true)
  })

  it('persists flat opt-ins, including false, using explicit undefined checks', async () => {
    await updateReservationSettings(VENUE, {
      capacityMode: 'per_staff',
      showStaffPicker: false,
    })

    expect(prismaMock.reservationSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ capacityMode: 'per_staff', showStaffPicker: false }),
      }),
    )
  })

  it('persists nested opt-ins, including false, using explicit undefined checks', async () => {
    await updateReservationSettings(VENUE, {
      scheduling: { capacityMode: 'pacing' },
      publicBooking: { showStaffPicker: false },
    })

    expect(prismaMock.reservationSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ capacityMode: 'pacing', showStaffPicker: false }),
      }),
    )
  })
})

describe('updateReservationSettings — transactional staff-aware activation gate', () => {
  const legacySettingsRow = {
    capacityMode: 'pacing',
    showStaffPicker: false,
    depositMode: 'none',
    appointmentUpfrontDefault: 'at_venue',
    classUpfrontDefault: 'at_venue',
  }

  beforeEach(() => {
    jest.useRealTimers()
    prismaMock.$executeRaw = jest.fn().mockResolvedValue(0)
    prismaMock.reservationSettings.findUnique.mockResolvedValue(legacySettingsRow as never)
    prismaMock.product.findMany.mockResolvedValue([])
    prismaMock.reservation.findMany.mockResolvedValue([])
    prismaMock.slotHold.findMany.mockResolvedValue([])
    prismaMock.reservationSettings.upsert.mockResolvedValue({ id: 'rs-activation' } as never)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it.each([
    ['capacity mode', { capacityMode: 'per_staff' }],
    ['staff picker', { showStaffPicker: true }],
  ])('rejects %s activation before locking when active appointment services are unmapped', async (_label, update) => {
    prismaMock.product.findMany.mockResolvedValue([{ id: 'service-z' }, { id: 'service-a' }] as never)

    await expect(updateReservationSettings(VENUE, update as never)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/service-a.*service-z/i),
    })

    expect(prismaMock.product.findMany).toHaveBeenCalledWith({
      where: {
        venueId: VENUE,
        type: 'APPOINTMENTS_SERVICE',
        active: true,
        deletedAt: null,
        productStaff: { none: { venueId: VENUE } },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    })
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    expect(prismaMock.reservationSettings.upsert).not.toHaveBeenCalled()
  })

  it('returns sorted confirmation codes when future active appointment reservations have no staff', async () => {
    prismaMock.reservation.findMany.mockResolvedValue([{ confirmationCode: 'RES-Z' }, { confirmationCode: 'RES-A' }] as never)

    let failure: unknown
    try {
      await updateReservationSettings(VENUE, { capacityMode: 'per_staff' })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(ConflictError)
    expect(failure).toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/citas.*sin profesionista/i),
      details: { confirmationCodes: ['RES-A', 'RES-Z'] },
    })
    expect(prismaMock.slotHold.findMany).not.toHaveBeenCalled()
    expect(prismaMock.reservationSettings.upsert).not.toHaveBeenCalled()
  })

  it('rejects a live null-staff appointment hold but ignores expired and cancelled-parent holds', async () => {
    const checkedAt = new Date('2032-01-02T12:00:00.000Z')
    jest.useFakeTimers().setSystemTime(checkedAt)
    prismaMock.slotHold.findMany.mockResolvedValue([
      {
        expiresAt: new Date('2032-01-02T12:05:00.000Z'),
        heldForReservationId: 'cancelled-parent',
        heldForReservation: { status: 'CANCELLED' },
      },
      {
        expiresAt: new Date('2032-01-02T11:59:59.000Z'),
        heldForReservationId: null,
        heldForReservation: null,
      },
      {
        expiresAt: new Date('2032-01-02T12:05:00.000Z'),
        heldForReservationId: null,
        heldForReservation: null,
      },
    ] as never)

    await expect(updateReservationSettings(VENUE, { showStaffPicker: true })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/clientes reservando.*minutos/i),
    })
    expect(prismaMock.reservationSettings.upsert).not.toHaveBeenCalled()
  })

  it('captures one UTC cutoff after the venue lock and uses it for both blocker queries', async () => {
    const beforeLock = new Date('2032-01-02T11:59:00.000Z')
    const afterLock = new Date('2032-01-02T12:00:00.000Z')
    jest.useFakeTimers().setSystemTime(beforeLock)
    let lockStatements = 0
    prismaMock.$executeRaw.mockImplementation(async () => {
      lockStatements += 1
      if (lockStatements === 2) jest.setSystemTime(afterLock)
      return 0
    })
    prismaMock.slotHold.findMany.mockResolvedValue([
      {
        expiresAt: new Date('2032-01-02T12:05:00.000Z'),
        heldForReservationId: 'cancelled-parent',
        heldForReservation: { status: 'CANCELLED' },
      },
    ] as never)

    await updateReservationSettings(VENUE, { capacityMode: 'per_staff' })

    const reservationCutoff = prismaMock.reservation.findMany.mock.calls[0][0].where.endsAt.gt
    const holdCutoff = prismaMock.slotHold.findMany.mock.calls[0][0].where.expiresAt.gt
    expect(reservationCutoff).toBe(holdCutoff)
    expect(reservationCutoff).toEqual(afterLock)
    expect(prismaMock.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(prismaMock.reservation.findMany.mock.invocationCallOrder[0])
    expect(prismaMock.reservationSettings.upsert).toHaveBeenCalledTimes(1)
  })

  it('skips the setup gate for resaves, mode switches while active, and transitions off', async () => {
    prismaMock.reservationSettings.findUnique.mockResolvedValue({
      ...legacySettingsRow,
      capacityMode: 'per_staff',
    } as never)
    prismaMock.product.findMany.mockResolvedValue([{ id: 'future-unmapped-service' }] as never)

    await updateReservationSettings(VENUE, {
      capacityMode: 'pacing',
      showStaffPicker: true,
    })
    await updateReservationSettings(VENUE, {
      capacityMode: 'pacing',
      showStaffPicker: false,
    })

    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    expect(prismaMock.reservationSettings.upsert).toHaveBeenCalledTimes(2)
  })

  it('normalizes once, gives nested settings precedence, and audits only after the transaction commits', async () => {
    let transactionCommitted = false
    prismaMock.$transaction.mockImplementationOnce(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
      const result = await callback(prismaMock)
      expect(logAction).not.toHaveBeenCalled()
      transactionCommitted = true
      return result
    })

    await updateReservationSettings(VENUE, {
      capacityMode: 'per_staff',
      showStaffPicker: true,
      scheduling: { capacityMode: 'pacing' },
      publicBooking: { showStaffPicker: false },
    })

    expect(transactionCommitted).toBe(true)
    expect(prismaMock.reservationSettings.upsert).toHaveBeenCalledWith({
      where: { venueId: VENUE },
      create: expect.objectContaining({ venueId: VENUE, capacityMode: 'pacing', showStaffPicker: false }),
      update: expect.objectContaining({ capacityMode: 'pacing', showStaffPicker: false }),
    })
    expect(logAction).toHaveBeenCalledTimes(1)
  })
})
