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
import { BadRequestError } from '../../../../src/errors/AppError'

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
