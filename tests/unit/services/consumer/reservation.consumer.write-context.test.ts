import { createReservationForConsumer } from '@/services/consumer/reservation.consumer.service'
import * as reservationService from '@/services/dashboard/reservation.dashboard.service'
import * as settingsService from '@/services/dashboard/reservationSettings.service'
import * as ecommerceCapability from '@/services/payments/ecommerceCapability'
import { BadRequestError } from '@/errors/AppError'
import { prismaMock } from '@tests/__helpers__/setup'
import { Prisma } from '@prisma/client'

const startsAt = new Date('2026-08-21T15:00:00.000Z')
const endsAt = new Date('2026-08-21T16:00:00.000Z')

function makeSettings(depositEnabled = false) {
  return {
    publicBooking: { enabled: true, requirePhone: false, requireEmail: false },
    deposits: {
      enabled: depositEnabled,
      mode: depositEnabled ? 'deposit' : 'none',
      fixedAmount: depositEnabled ? 80 : null,
      percentageOfTotal: null,
      requiredForPartySizeGte: null,
      paymentWindowHrs: 24,
    },
  } as any
}

describe('consumer reservation write context', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.resetAllMocks()
    prismaMock.venue.findFirst.mockResolvedValue({ id: 'venue-1', slug: 'venue', name: 'Venue' } as any)
    prismaMock.consumer.findUnique.mockResolvedValue({
      id: 'consumer-1',
      email: 'ana@example.com',
      phone: '+525555555555',
      firstName: 'Ana',
      lastName: 'López',
      active: true,
    } as any)
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'customer-1' } as any)
  })

  it('declares CONSUMER origin without passing its preflight settings into the core', async () => {
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue(makeSettings())
    const createSpy = jest.spyOn(reservationService, 'createReservation').mockResolvedValue({
      id: 'reservation-1',
      confirmationCode: 'RES-1',
      cancelSecret: 'secret',
      startsAt,
      endsAt,
      status: 'CONFIRMED',
      depositAmount: null,
    } as any)

    await createReservationForConsumer('consumer-1', 'venue', { startsAt, endsAt, duration: 60, partySize: 1 })

    expect(createSpy).toHaveBeenCalledWith('venue-1', expect.objectContaining({ channel: 'APP', customerId: 'customer-1' }), {
      writeOrigin: 'CONSUMER',
    })
  })

  it('maps base window semantics into trusted context while remaining single-product', async () => {
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue(makeSettings())
    const createSpy = jest.spyOn(reservationService, 'createReservation').mockResolvedValue({
      id: 'reservation-1',
      confirmationCode: 'RES-1',
      cancelSecret: 'secret',
      startsAt,
      endsAt,
      status: 'CONFIRMED',
      depositAmount: null,
    } as any)

    await createReservationForConsumer('consumer-1', 'venue', {
      startsAt,
      endsAt,
      duration: 60,
      partySize: 1,
      productId: 'product-1',
      windowSemantics: 'base',
    } as any)

    expect(createSpy).toHaveBeenCalledWith('venue-1', expect.objectContaining({ productId: 'product-1' }), {
      writeOrigin: 'CONSUMER',
      windowSemantics: 'base',
    })
  })

  it('retains the hard rejection when a required deposit has no chargeable Stripe rail', async () => {
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue(makeSettings(true))
    jest.spyOn(reservationService, 'calculateDepositAmount').mockReturnValue({ required: true, amount: new Prisma.Decimal(80) })
    jest.spyOn(ecommerceCapability, 'resolveChargeableStripeMerchant').mockResolvedValue(null)
    const createSpy = jest.spyOn(reservationService, 'createReservation')

    await expect(createReservationForConsumer('consumer-1', 'venue', { startsAt, endsAt, duration: 60, partySize: 1 })).rejects.toThrow(
      BadRequestError,
    )

    expect(createSpy).not.toHaveBeenCalled()
  })
})
