/**
 * 🔴 DINERO, en la dirección contraria. Si se quita de la cuenta el descuento que
 * nació de un premio, el premio tiene que VOLVER: si no, el cliente pagó su cartilla
 * completa por un descuento que ya no existe. Es el espejo exacto de lo que ya se
 * hace con los puntos de lealtad (`refundLoyaltyForOrderDiscount`).
 */
import { refundStampRewardForOrderDiscount } from '../../../../src/services/wallet/redeemStampReward.service'
import { prismaMock } from '../../../__helpers__/setup'

const PREMIO_CANJEADO = {
  id: 'rw1',
  venueId: 'v1',
  customerId: 'c1',
  rewardLabel: 'Un café gratis',
  status: 'REDEEMED',
  stampCardId: 'sc1',
}

describe('refundStampRewardForOrderDiscount', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.stampReward.findFirst.mockResolvedValue(PREMIO_CANJEADO as any)
    prismaMock.stampReward.update.mockResolvedValue({} as any)
    prismaMock.stampCard.findUnique.mockResolvedValue({ id: 'sc1', stampsEarned: 7, stampsRequired: 7 } as any)
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'rw1' }] as any)
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

  // D3 (21-oct, «A, como Square»): mientras estuvo canjeado, una devolución le quitó un sello a su cartilla (lo cobrado no se
  // quita). Al quitar el descuento, el premio NO vuelve a estar por cobrar sin sus sellos: se cancela y la cartilla se reabre.
  it('🔴 D3: su cartilla ya no está llena: el premio NO vuelve por cobrar; se cancela y la cartilla se reabre', async () => {
    prismaMock.stampCard.findUnique.mockResolvedValue({ id: 'sc1', stampsEarned: 6, stampsRequired: 7 } as any)
    prismaMock.stampCard.update.mockResolvedValue({} as any)

    await refundStampRewardForOrderDiscount(prismaMock as any, 'v1', { id: 'od1' })

    // Decide con la FILA del PREMIO bloqueada (la que toma la reversa, Codex D3-r2 #1 / r3 / r4) y lee la cartilla DESPUÉS.
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled() // ya no el candado del cliente: cerraba un círculo
    expect((prismaMock.$queryRaw as jest.Mock).mock.calls[0][0].join('?')).toMatch(/FROM "StampReward" WHERE id = \? FOR UPDATE/)
    expect((prismaMock.$queryRaw as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (prismaMock.stampCard.findUnique as jest.Mock).mock.invocationCallOrder[0],
    )

    expect(prismaMock.stampReward.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED', redeemedAt: null, orderDiscountId: null }) }),
    )
    expect(prismaMock.stampCard.update).toHaveBeenCalledWith({ where: { id: 'sc1' }, data: { completedAt: null } })
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
