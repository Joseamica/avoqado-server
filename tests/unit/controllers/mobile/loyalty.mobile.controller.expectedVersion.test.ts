/**
 * D39 (Codex r2, prueba que faltaba): el controlador del canje pasa `expectedVersion` al servicio junto con lo que enseñó la caja, lo
 * valida en la frontera, y sin él (Mesas, apps viejas) todo queda como antes. La integración llama al servicio directamente.
 */
jest.mock('@/services/mobile/loyalty.mobile.service', () => ({
  redeemPointsToOrder: jest.fn(),
  redeemPointsToOrderInTransaction: jest.fn(),
  getCustomerLoyalty: jest.fn(),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { redeemPoints } from '@/controllers/mobile/loyalty.mobile.controller'
import { redeemPointsToOrder, redeemPointsToOrderInTransaction } from '@/services/mobile/loyalty.mobile.service'

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

/**
 * D39 r10 (de raíz, founder 25-nov): el canje de Pedidos viaja con su llave (`httpOperation`). La versión que enseñó la caja entra en el
 * manifiesto de la llave (el reenvío idéntico recibe el mismo recibo) y en lo esperado del canje (otra versión es el 409 del candado).
 */
describe('POST …/loyalty/redeem con llave — expectedVersion', () => {
  const httpOp = jest.requireActual('@/services/mobile/http-operation.mobile.service')
  const llave = { version: 1, id: '7f1f2a6e-3c1b-4f53-9c8a-1d2e3f4a5b6c', deviceId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }
  let manifiestos: any[]
  let esperados: any[]

  beforeEach(() => {
    manifiestos = []
    esperados = []
    jest.spyOn(httpOp, 'executeHttpOperation').mockImplementation(async (input: any, mutate: any) => {
      manifiestos.push(input.manifest)
      await mutate({})
      return { kind: 'RETRY', code: 'OPERATION_OUTCOME_PENDING' }
    })
    ;(redeemPointsToOrderInTransaction as jest.Mock).mockReset().mockImplementation(async (...args: any[]) => {
      esperados.push(args[7])
      return { pointsToBurn: 100, discountAmount: 10, newBalance: 0, totals: {}, row: { id: 'd1' }, transaction: { id: 't1' } }
    })
  })
  afterEach(() => jest.restoreAllMocks())

  it('la versión va en el manifiesto de la llave y en lo esperado del canje', async () => {
    await redeemPoints(
      peticion({ customerId: 'c1', points: 100, expectedDiscountAmount: 10, expectedVersion: 7, httpOperation: llave }),
      respuesta(),
      jest.fn(),
    )
    expect(manifiestos[0]).toMatchObject({ action: 'redeemLoyaltyPoints', payload: { points: 100, expectedDiscountAmount: 10, expectedVersion: 7 } })
    expect(esperados[0]).toEqual({ monto: 10, puntos: 100, deLaCabecera: true, version: 7 })
  })

  it('sin versión (Mesas, apps viejas): el manifiesto y lo esperado de siempre', async () => {
    await redeemPoints(peticion({ customerId: 'c1', points: 100, expectedDiscountAmount: 10, httpOperation: llave }), respuesta(), jest.fn())
    expect(manifiestos[0].payload).toEqual({ points: 100, expectedDiscountAmount: 10 })
    expect(esperados[0]).toEqual({ monto: 10, puntos: 100, deLaCabecera: true })
  })

  it('dos manifiestos que sólo difieren en la versión no son el mismo recibo', () => {
    const base = { action: 'redeemLoyaltyPoints', refs: { orderId: 'o1', customerId: 'c1' } }
    expect(httpOp.fingerprint({ ...base, payload: { points: 100, expectedDiscountAmount: 10, expectedVersion: 7 } })).not.toBe(
      httpOp.fingerprint({ ...base, payload: { points: 100, expectedDiscountAmount: 10, expectedVersion: 8 } }),
    )
  })
})
