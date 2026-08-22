jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import { redeemCreditsWithCompensation, CREDIT_REDEEM_FAILED_REASON } from '@/controllers/public/reservation.public.controller'
import logger from '@/config/logger'

/**
 * Auditoría 3 (P1): en CITAS la reserva se confirma en su propia transacción y el canje de
 * créditos corre en OTRA. Si el canje fallaba (saldo insuficiente, producto distinto, compra
 * expirada, error de DB) el cliente recibía el error… y la reserva quedaba VIVA ocupando el
 * lugar, sin créditos cobrados. Compensación: si el canje falla, la reserva se cancela
 * (SYSTEM, razón CREDIT_REDEEM_FAILED) y el error original se propaga.
 */
const args = {
  venueId: 'v1',
  reservationId: 'res-1',
  confirmationCode: 'RES-ABC',
  balanceIds: ['bal-1'],
  creditsPerBalance: 1,
  customerId: 'c1',
}

describe('redeemCreditsWithCompensation', () => {
  beforeEach(() => jest.clearAllMocks())

  it('canje exitoso → devuelve el resultado y NO cancela nada', async () => {
    const redeem = jest.fn(async () => ({ creditsUsed: 1, redeemed: true }))
    const cancel = jest.fn()

    const r = await redeemCreditsWithCompensation(args, { redeem, cancel })

    expect(r).toEqual({ creditsUsed: 1, redeemed: true })
    expect(cancel).not.toHaveBeenCalled()
  })

  it('🔴 el canje falla → cancela la reserva como SYSTEM con razón CREDIT_REDEEM_FAILED y propaga el error ORIGINAL', async () => {
    const boom = Object.assign(new Error('No tienes suficientes creditos'), { statusCode: 400 })
    const redeem = jest.fn(async () => {
      throw boom
    })
    const cancel = jest.fn(async () => ({}))

    await expect(redeemCreditsWithCompensation(args, { redeem, cancel })).rejects.toBe(boom)

    expect(cancel).toHaveBeenCalledWith('v1', 'res-1', 'SYSTEM', CREDIT_REDEEM_FAILED_REASON)
    expect((logger as any).error).toHaveBeenCalledWith(expect.stringContaining('[CREDIT REDEEM FAILED]'), expect.anything())
  })

  it('si la compensación también falla → se loguea "reserva viva" y el error ORIGINAL sigue siendo el que se propaga', async () => {
    const boom = new Error('producto distinto')
    const redeem = jest.fn(async () => {
      throw boom
    })
    const cancel = jest.fn(async () => {
      throw new Error('cancel boom')
    })

    await expect(redeemCreditsWithCompensation(args, { redeem, cancel })).rejects.toBe(boom)

    expect((logger as any).error).toHaveBeenCalledWith(
      expect.stringContaining('compensación'),
      expect.objectContaining({ reservationId: 'res-1' }),
    )
  })
})
