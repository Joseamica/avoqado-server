/**
 * D39 (Codex r2, prueba que faltaba): el controlador del canje pasa `expectedVersion` al servicio junto con lo que enseñó la caja, lo
 * valida en la frontera, y sin él (Mesas, apps viejas) todo queda como antes. La integración llama al servicio directamente.
 */
jest.mock('@/services/mobile/loyalty.mobile.service', () => ({ redeemPointsToOrder: jest.fn(), getCustomerLoyalty: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { redeemPoints } from '@/controllers/mobile/loyalty.mobile.controller'
import { redeemPointsToOrder } from '@/services/mobile/loyalty.mobile.service'

function respuesta() {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}

const peticion = (body: Record<string, unknown>) =>
  ({ params: { venueId: 'v1', orderId: 'o1' }, body, authContext: { userId: 'staff-1' } }) as any

describe('POST …/loyalty/redeem — expectedVersion', () => {
  beforeEach(() => (redeemPointsToOrder as jest.Mock).mockReset().mockResolvedValue({ pointsRedeemed: 100, discountAmount: 10 }))

  it('con monto y versión: el servicio recibe los dos en lo esperado', async () => {
    const res = respuesta()
    await redeemPoints(peticion({ customerId: 'c1', points: 100, expectedDiscountAmount: 10, expectedVersion: 7 }), res, jest.fn())
    expect(redeemPointsToOrder).toHaveBeenCalledWith('v1', 'o1', 'c1', 100, 'staff-1', {
      monto: 10,
      puntos: 100,
      deLaCabecera: true,
      version: 7,
    })
  })

  it('con la versión en null (Kotlin la manda así desde Mesas) o sin ella: lo esperado de siempre, sin versión', async () => {
    for (const body of [
      { customerId: 'c1', points: 100, expectedDiscountAmount: 10, expectedVersion: null },
      { customerId: 'c1', points: 100, expectedDiscountAmount: 10 },
    ]) {
      ;(redeemPointsToOrder as jest.Mock).mockClear()
      await redeemPoints(peticion(body), respuesta(), jest.fn())
      expect(redeemPointsToOrder).toHaveBeenCalledWith('v1', 'o1', 'c1', 100, 'staff-1', { monto: 10, puntos: 100, deLaCabecera: true })
    }
  })

  it('una versión que no es entero no negativo: 400 y no se canjea', async () => {
    for (const expectedVersion of [-1, 1.5, '7']) {
      const res = respuesta()
      await redeemPoints(peticion({ customerId: 'c1', points: 100, expectedDiscountAmount: 10, expectedVersion }), res, jest.fn())
      expect(res.status).toHaveBeenCalledWith(400)
    }
    expect(redeemPointsToOrder).not.toHaveBeenCalled()
  })
})
