/**
 * D5, Codex r1 #5: el canje del cupón va DESPUÉS del referido y, si falla, `onOrderPaid` lanza. Así el efecto durable `REFERRAL` del cobro
 * (`paymentEffects`) lo reintenta en vez de darlo por hecho; los dos pasos son idempotentes.
 */
jest.mock('@/services/shared/cuponDeLaVenta', () => ({ finalizeCouponsForOrder: jest.fn() }))

import { prismaMock } from '@tests/__helpers__/setup'
import { onOrderPaid } from '@/services/referrals/referralQualification.service'
import { finalizeCouponsForOrder } from '@/services/shared/cuponDeLaVenta'

beforeEach(() => {
  jest.clearAllMocks()
  // El referido no encuentra nada que calificar (la transacción devuelve null).
  prismaMock.$transaction.mockResolvedValue(null as any)
})

it('el referido corre primero y el canje después, con la venta de la llamada', async () => {
  const orden: string[] = []
  prismaMock.$transaction.mockImplementation((async () => {
    orden.push('referido')
    return null
  }) as any)
  ;(finalizeCouponsForOrder as jest.Mock).mockImplementation(async () => {
    orden.push('cupon')
  })
  await onOrderPaid({ orderId: 'o-1', venueId: 'v-1' })
  expect(orden).toEqual(['referido', 'cupon'])
  expect(finalizeCouponsForOrder).toHaveBeenCalledWith('v-1', 'o-1')
})

it('si el canje falla, lanza: el efecto durable lo reintenta', async () => {
  ;(finalizeCouponsForOrder as jest.Mock).mockRejectedValue(new Error('base caída'))
  await expect(onOrderPaid({ orderId: 'o-1', venueId: 'v-1' })).rejects.toThrow('base caída')
})
