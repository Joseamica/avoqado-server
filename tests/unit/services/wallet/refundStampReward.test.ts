/**
 * 🔴 DINERO, en la dirección contraria. Si se quita de la cuenta el descuento que
 * nació de un premio, el premio tiene que VOLVER: si no, el cliente pagó su cartilla
 * completa por un descuento que ya no existe. Es el espejo exacto de lo que ya se
 * hace con los puntos de lealtad (`refundLoyaltyForOrderDiscount`).
 */
import { refundStampRewardForOrderDiscount } from '../../../../src/services/wallet/redeemStampReward.service'
import { prismaMock } from '../../../__helpers__/setup'

const PREMIO_CANJEADO = { id: 'rw1', venueId: 'v1', customerId: 'c1', rewardLabel: 'Un café gratis', status: 'REDEEMED' }

describe('refundStampRewardForOrderDiscount', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.stampReward.findFirst.mockResolvedValue(PREMIO_CANJEADO as any)
    prismaMock.stampReward.update.mockResolvedValue({} as any)
  })

  it('🔴 el premio vuelve a estar disponible', async () => {
    const r = await refundStampRewardForOrderDiscount(prismaMock as any, 'v1', { id: 'od1' })

    expect(r?.rewardId).toBe('rw1')
    // 🔴 Los tres campos juntos: dejar `redeemedAt` o el vínculo al descuento haría
    // que el premio se vea disponible pero arrastrando el rastro de un canje que ya
    // no ocurrió.
    expect(prismaMock.stampReward.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rw1' },
        data: expect.objectContaining({ status: 'PENDING', redeemedAt: null, orderDiscountId: null }),
      }),
    )
  })

  it('un descuento normal no toca ningún premio', async () => {
    // La inmensa mayoría de los descuentos no vienen de una cartilla. Este camino
    // corre en CADA quitada de descuento: tiene que ser un no-op silencioso.
    prismaMock.stampReward.findFirst.mockResolvedValue(null)

    const r = await refundStampRewardForOrderDiscount(prismaMock as any, 'v1', { id: 'od-normal' })

    expect(r).toBeNull()
    expect(prismaMock.stampReward.update).not.toHaveBeenCalled()
  })
})
