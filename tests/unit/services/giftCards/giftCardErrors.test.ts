jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import AppError from '@/errors/AppError'
import logger from '@/config/logger'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import { recordGiftCardAnomaly } from '@/services/giftCards/giftCardAnomaly'
import { prismaMock } from '../../../__helpers__/setup'

describe('GiftCardError', () => {
  it('es un AppError operacional: status, code estable y el extra en details (el manejador lo serializa)', () => {
    const e = new GiftCardError('GIFT_CARD_INSUFFICIENT_BALANCE', 'Quedan $400.00 en la tarjeta de regalo.', 409, { saldoDisponible: 400 })
    expect(e).toBeInstanceOf(AppError)
    expect(e).toBeInstanceOf(GiftCardError)
    expect(e.statusCode).toBe(409)
    expect(e.code).toBe('GIFT_CARD_INSUFFICIENT_BALANCE')
    expect(e.details).toEqual({ saldoDisponible: 400 })
    expect(e.isOperational).toBe(true)
    expect(e.message).toBe('Quedan $400.00 en la tarjeta de regalo.')
  })

  it('sin extra no inventa details', () => {
    const e = new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa tarjeta de regalo en este negocio.', 404)
    expect(e.details).toBeUndefined()
  })
})

describe('recordGiftCardAnomaly', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.venue.findUnique.mockResolvedValue({ name: 'IQ Collection' })
    prismaMock.moneyAnomaly.createMany.mockResolvedValue({ count: 1 })
  })

  it('escribe UNA anomalía deduplicable (llave giftcard:<check>:<id>, skipDuplicates) y grita con el nombre del negocio', async () => {
    await recordGiftCardAnomaly(prismaMock, {
      check: 'ACTIVATION_AMOUNT_MISMATCH',
      id: 'order-1',
      venueId: 'venue-1',
      detail: { cobrado: '400.00', esperado: '500.00' },
    })

    expect(prismaMock.moneyAnomaly.createMany).toHaveBeenCalledWith({
      data: [
        {
          category: 'GIFT_CARD_ACTIVATION_AMOUNT_MISMATCH',
          stripeEventId: 'giftcard:ACTIVATION_AMOUNT_MISMATCH:order-1',
          expectedState: { venueId: 'venue-1', id: 'order-1', check: 'ACTIVATION_AMOUNT_MISMATCH' },
          observedState: { cobrado: '400.00', esperado: '500.00' },
        },
      ],
      skipDuplicates: true,
    })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Anomalía'),
      expect.objectContaining({ check: 'ACTIVATION_AMOUNT_MISMATCH', id: 'order-1', venueId: 'venue-1', venueName: 'IQ Collection' }),
    )
  })

  it('una segunda corrida con la misma llave no truena (dentro de una transacción de dinero no puede abortarla)', async () => {
    prismaMock.moneyAnomaly.createMany.mockResolvedValue({ count: 0 })
    await expect(
      recordGiftCardAnomaly(prismaMock, { check: 'PAID_WITH_PENDING', id: 'order-2', venueId: 'venue-1', detail: {} }),
    ).resolves.toBeUndefined()
    expect(prismaMock.moneyAnomaly.create).not.toHaveBeenCalled()
  })
})
