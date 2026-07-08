/**
 * updateReservationSettings — online-charging guard (2026-07-07).
 *
 * A venue can't turn ON any cobro (depositMode != 'none' or an upfront default
 * other than 'at_venue') unless it has a chargeable e-commerce rail
 * (canVenueChargeOnline → an active Stripe Connect merchant). Turning cobro OFF,
 * or changing non-cobro fields, is always allowed and does not even run the check.
 */
import { prismaMock } from '../../../__helpers__/setup'
import { updateReservationSettings } from '../../../../src/services/dashboard/reservationSettings.service'
import { BadRequestError } from '../../../../src/errors/AppError'

const VENUE = 'v-guard-1'
const chargeableMerchant = { id: 'ecm-1', provider: { code: 'STRIPE_CONNECT' } }

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
})
