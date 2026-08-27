/**
 * 🔴 DINERO. Quitar de la cuenta el descuento que nació de una cartilla de sellos
 * tiene que DEVOLVER el premio.
 *
 * Sin esto el cliente pagó siete visitas por un descuento que ya no existe, y desde el
 * mostrador no hay forma de devolvérselo: el premio quedaría marcado como canjeado
 * para siempre. Es la misma regla que ya se respeta con los puntos de lealtad, y por
 * eso corre en la MISMA transacción — si se separan, un fallo a medias deja al cliente
 * sin descuento y sin premio.
 */
jest.mock('@/services/mobile/comp-item.mobile.service', () => ({
  recalculateOrderTotals: jest.fn().mockResolvedValue({ id: 'o1', total: 250 }),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { removeOrderDiscount } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

describe('removeOrderDiscount + premio de sellos', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.order.findFirst.mockResolvedValue({ id: 'o1', paymentStatus: 'PENDING', paidAmount: 0 } as any)
    // Un descuento SIN transacción de puntos: viene de una cartilla, no de puntos.
    prismaMock.orderDiscount.findFirst.mockResolvedValue({
      id: 'od1',
      name: 'Un café gratis',
      amount: 90,
      loyaltyTransactionId: null,
    } as any)
    prismaMock.orderDiscount.delete.mockResolvedValue({} as any)
    prismaMock.stampReward.findFirst.mockResolvedValue({ id: 'rw1', customerId: 'c1', rewardLabel: 'Un café gratis' } as any)
    prismaMock.stampReward.update.mockResolvedValue({} as any)
  })

  it('🔴 el premio vuelve a estar disponible al quitar su descuento', async () => {
    await removeOrderDiscount('v1', 'o1', 'od1')

    expect(prismaMock.stampReward.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rw1' },
        data: expect.objectContaining({ status: 'PENDING', redeemedAt: null, orderDiscountId: null }),
      }),
    )
  })

  it('un descuento normal se quita sin tocar ninguna cartilla', async () => {
    prismaMock.stampReward.findFirst.mockResolvedValue(null)

    await removeOrderDiscount('v1', 'o1', 'od1')

    expect(prismaMock.orderDiscount.delete).toHaveBeenCalled()
    expect(prismaMock.stampReward.update).not.toHaveBeenCalled()
  })
})
