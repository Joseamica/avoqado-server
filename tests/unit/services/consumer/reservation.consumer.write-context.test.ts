import { createReservationForConsumer } from '@/services/consumer/reservation.consumer.service'
import * as reservationService from '@/services/dashboard/reservation.dashboard.service'
import * as settingsService from '@/services/dashboard/reservationSettings.service'
import * as ecommerceCapability from '@/services/payments/ecommerceCapability'
import * as appointmentSlotHoldService from '@/services/reservation/appointmentSlotHold.service'
import { BadRequestError, ConflictError } from '@/errors/AppError'
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
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue({
      ...makeSettings(),
      publicBooking: { ...makeSettings().publicBooking, showStaffPicker: true },
    })
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
      staffId: 'staff-public',
      windowSemantics: 'base',
    } as any)

    expect(createSpy).toHaveBeenCalledWith(
      'venue-1',
      expect.objectContaining({ productId: 'product-1', assignedStaffId: 'staff-public' }),
      {
        writeOrigin: 'CONSUMER',
        windowSemantics: 'base',
      },
    )
  })

  it('retains the hard rejection when a required deposit has no chargeable Stripe rail', async () => {
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue(makeSettings(true))
    jest.spyOn(reservationService, 'calculateDepositAmount').mockReturnValue({ required: true, amount: new Prisma.Decimal(80) })
    jest.spyOn(ecommerceCapability, 'resolveChargeableStripeMerchant').mockResolvedValue(null)
    const createSpy = jest.spyOn(reservationService, 'createReservation').mockResolvedValue({
      id: 'reservation-should-not-exist',
      confirmationCode: 'RES-NO',
      cancelSecret: 'secret',
      startsAt,
      endsAt,
      status: 'CONFIRMED',
      depositAmount: null,
    } as any)

    await expect(createReservationForConsumer('consumer-1', 'venue', { startsAt, endsAt, duration: 60, partySize: 1 })).rejects.toThrow(
      BadRequestError,
    )

    expect(createSpy).not.toHaveBeenCalled()
  })

  it('rejects appointment staff selection before customer lookup/link writes when the picker is off', async () => {
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue({
      ...makeSettings(),
      publicBooking: { ...makeSettings().publicBooking, showStaffPicker: false },
    })
    const createSpy = jest.spyOn(reservationService, 'createReservation').mockResolvedValue({
      id: 'reservation-should-not-exist',
      confirmationCode: 'RES-NO',
      cancelSecret: 'secret',
      startsAt,
      endsAt,
      status: 'CONFIRMED',
      depositAmount: null,
    } as any)

    await expect(
      createReservationForConsumer('consumer-1', 'venue', {
        startsAt,
        endsAt,
        duration: 60,
        productId: 'product-1',
        staffId: 'staff-forbidden',
      } as any),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'La selección de profesionista no está habilitada para este negocio',
    })

    expect(prismaMock.consumer.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.customer.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.customer.create).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('fast-fails a normal token, then forwards canonical products/modifiers and only its server-derived id', async () => {
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue({
      ...makeSettings(),
      publicBooking: { ...makeSettings().publicBooking, showStaffPicker: false },
    })
    const fastFail = jest.spyOn(appointmentSlotHoldService, 'fastFailLiveHold').mockResolvedValue({ id: 'hold-server' })
    const createSpy = jest.spyOn(reservationService, 'createReservation').mockResolvedValue({
      id: 'reservation-1',
      confirmationCode: 'RES-1',
      cancelSecret: 'secret',
      startsAt,
      endsAt,
      status: 'CONFIRMED',
      depositAmount: null,
    } as any)
    const modifierSelections = [{ productId: 'product-1', modifierId: 'modifier-1', quantity: 2 }]

    await createReservationForConsumer('consumer-1', 'venue', {
      startsAt,
      endsAt,
      duration: 60,
      productId: 'product-1',
      productIds: ['product-1'],
      staffId: 'staff-held',
      modifierSelections,
      holdId: 'hold-from-wire',
      windowSemantics: 'base',
      appointmentHoldId: 'forged',
    } as any)

    expect(fastFail).toHaveBeenCalledWith({ venueId: 'venue-1', holdId: 'hold-from-wire' })
    expect(createSpy).toHaveBeenCalledWith(
      'venue-1',
      expect.objectContaining({
        productId: 'product-1',
        productIds: ['product-1'],
        modifierSelections,
        assignedStaffId: 'staff-held',
      }),
      { writeOrigin: 'CONSUMER', windowSemantics: 'base', appointmentHoldId: 'hold-server' },
    )
  })

  it('uses the canonical productIds-only lead for percentage-deposit preflight', async () => {
    const percentageSettings = {
      ...makeSettings(true),
      deposits: {
        ...makeSettings(true).deposits,
        fixedAmount: null,
        percentageOfTotal: 50,
      },
    }
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue(percentageSettings)
    prismaMock.product.findFirst.mockResolvedValue({ price: new Prisma.Decimal(200) } as any)
    jest.spyOn(ecommerceCapability, 'resolveChargeableStripeMerchant').mockResolvedValue(null)
    const createSpy = jest.spyOn(reservationService, 'createReservation')

    await expect(
      createReservationForConsumer('consumer-1', 'venue', {
        startsAt,
        endsAt,
        duration: 60,
        partySize: 1,
        productIds: ['product-1'],
      }),
    ).rejects.toThrow(BadRequestError)

    expect(prismaMock.product.findFirst).toHaveBeenCalledWith({
      where: { id: 'product-1', venueId: 'venue-1', active: true },
      select: { price: true },
    })
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('rejects a valid candidate token on a class create before customer-link writes', async () => {
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue(makeSettings())
    jest.spyOn(appointmentSlotHoldService, 'fastFailLiveHold').mockResolvedValue({ id: 'hold-server' })
    const createSpy = jest.spyOn(reservationService, 'createReservation')

    await expect(
      createReservationForConsumer('consumer-1', 'venue', {
        classSessionId: 'class-1',
        holdId: 'hold-from-wire',
      } as any),
    ).rejects.toMatchObject({ statusCode: 400 })

    expect(prismaMock.consumer.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.customer.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.customer.create).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('rejects multi-service consumer input before customer-link or core writes', async () => {
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue(makeSettings())
    const createSpy = jest.spyOn(reservationService, 'createReservation')

    await expect(
      createReservationForConsumer('consumer-1', 'venue', {
        startsAt,
        endsAt,
        duration: 60,
        productId: 'product-1',
        productIds: ['product-1', 'product-2'],
      }),
    ).rejects.toMatchObject({ statusCode: 400 })

    expect(prismaMock.consumer.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.customer.findFirst).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('rejects an invalid token before any consumer lookup or customer-link write', async () => {
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue(makeSettings())
    jest.spyOn(appointmentSlotHoldService, 'fastFailLiveHold').mockRejectedValue(new ConflictError('Tu reserva temporal ya no es válida'))
    const createSpy = jest.spyOn(reservationService, 'createReservation')

    await expect(
      createReservationForConsumer('consumer-1', 'venue', {
        startsAt,
        endsAt,
        duration: 60,
        productId: 'product-1',
        holdId: 'hold-invalid',
      } as any),
    ).rejects.toMatchObject({ statusCode: 409 })

    expect(prismaMock.consumer.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.customer.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.customer.create).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })
})
