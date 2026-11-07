/**
 * S5b paso 9 · [repetirNoDuplica:reconcileDeliveryOrderFromProvider]: `cerradoEnProveedor` y `selloPorRevertir` nacen DENTRO de cada intento.
 * Intento 1 lee al proveedor (`providerClosed: true`) y se aborta con 40P01; intento 2 ve la venta cancelada y sale antes de leer.
 * El resultado público no hereda el `providerClosed` del intento abortado y no se quita ningún sello.
 */
import '@tests/__helpers__/setup'

const mockLock = jest.fn()
jest.mock('@/services/delivery-channels/core/deliveryOrderLock', () => ({
  __esModule: true,
  CANDADO_TX_TIMEOUT_MS: 15_000,
  withDeliveryOrderLockConReintento: (...a: unknown[]) => mockLock(...a),
}))
const mockContexto = jest.fn()
jest.mock('@/services/delivery-channels/core/respondToDeliveryOrder.service', () => ({
  __esModule: true,
  contexto: (...a: unknown[]) => mockContexto(...a),
}))
jest.mock('@/services/delivery-channels/core/money', () => ({ __esModule: true, assertDeliveryMoneyInvariants: jest.fn() }))
jest.mock('@/services/shared/paymentShiftClaim', () => ({
  __esModule: true,
  lockExistingOrderForPayment: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/wallet/stampLedger.service', () => ({ __esModule: true, reverseStampForOrder: jest.fn() }))
jest.mock('@/services/tpv/paymentEffects.service', () => ({ __esModule: true, enqueueLoyaltyPointsReversalInTx: jest.fn() }))

import { reconcileDeliveryOrderFromProvider } from '@/services/delivery-channels/core/deliveryReconciliation.service'
import { reverseStampForOrder } from '@/services/wallet/stampLedger.service'

describe('reconcileDeliveryOrderFromProvider · 40P01', () => {
  it('[repetirNoDuplica:reconcileDeliveryOrderFromProvider] el providerClosed del intento ABORTADO no llega al resultado del ganador', async () => {
    const tx = { order: { findUnique: jest.fn() }, $queryRaw: jest.fn() }
    tx.order.findUnique
      .mockResolvedValueOnce({ venueId: 'v1', deliveryReconcileBlocked: false, status: 'OPEN' }) // intento 1: sigue vigente
      .mockResolvedValueOnce({ venueId: 'v1', deliveryReconcileBlocked: false, status: 'CANCELLED' }) // intento 2: ya cancelada
    mockContexto.mockResolvedValue({
      externalOrderId: 'ext-1',
      order: { providerAcceptedAt: null },
      adapter: {
        fetchOrder: jest.fn().mockResolvedValue({}),
        normalizeOrder: () => ({ externalId: 'ext-1', providerClosed: true, payment: {}, items: [{ lineId: 'l1' }] }),
      },
    })
    let llamada = 0
    // Doble del reintento: intento 1 (cuerpo completo, luego 40P01 tras acumular) y luego intento 2, el que hace commit.
    mockLock.mockImplementation(async (_id: string, fn: (t: unknown, inicio: number) => Promise<unknown>) => {
      await fn(tx, Date.now())
      llamada++
      return fn(tx, Date.now())
    })

    const r = await reconcileDeliveryOrderFromProvider('o1', { trigger: 'JOB' })

    expect(tx.order.findUnique).toHaveBeenCalledTimes(2) // una lectura por intento
    expect(llamada).toBe(1)
    expect(r).toEqual({ outcome: 'ORDER_CANCELLED', providerClosed: false })
    expect(reverseStampForOrder).not.toHaveBeenCalled()
  })
})
