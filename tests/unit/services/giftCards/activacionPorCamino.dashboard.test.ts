/**
 * R8 · camino 5 (Review Focus 3): «Liquidar» desde el dashboard (`settleOrder`) activa los sobres de una cuenta de
 * tarjetas en la misma transacción que la marca PAGADA. Andamiaje de `settle.cashDrawer.test.ts`.
 */
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-1' }),
  applySalePosting: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn() }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  postCashSaleToDrawer: jest.fn().mockResolvedValue('POSTED'),
  cashSaleDrawerLocalId: (id: string) => `pay:${id}`,
}))
const activarSobresMock = jest.fn()
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  activarSobresDeCuentaPagadaEnTx: (...a: unknown[]) => activarSobresMock(...a),
}))

import { settleOrder } from '@/services/dashboard/order.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const RENGLONES = [{ id: 'oi-1', giftCardId: 'gc-1', productId: null, modifiers: [] }]

/**
 * A6 r1: la transacción recibe un cliente DISTINGUIBLE del global (delega en él por prototipo, así que ve los mismos dobles):
 * si la activación se llamara con `prisma` en vez de con `tx`, la identidad no cuadraría.
 */
function armarOrden(casGana = true) {
  ;(prismaMock as any).order = {
    findFirst: jest.fn().mockResolvedValue({
      id: 'order-1',
      venueId: VENUE,
      orderNumber: 'A-1',
      total: 500,
      paidAmount: 0,
      remainingBalance: 500,
      paymentStatus: 'PENDING',
      version: 1,
    }),
    updateMany: jest.fn().mockResolvedValue({ count: casGana ? 1 : 0 }),
  }
  ;(prismaMock as any).payment = {
    aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0, tipAmount: 0 } }),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockImplementation(async (args: any) => ({ id: 'pay-1', ...args.data })),
  }
  ;(prismaMock as any).orderItem = { findMany: jest.fn().mockResolvedValue(RENGLONES) }
  const txDoble = Object.create(prismaMock)
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(txDoble))
  return txDoble
}

beforeEach(() => {
  jest.clearAllMocks()
  activarSobresMock.mockResolvedValue({ activated: ['gc-1'] })
})

describe('R8 · liquidar desde el dashboard', () => {
  it('🔴 la liquidación que gana el CAS activa los sobres con la MISMA tx, después de crear el Payment', async () => {
    const tx = armarOrden()
    await settleOrder(VENUE, 'order-1', 'Pagó en efectivo', 'owner-1')
    expect(activarSobresMock).toHaveBeenCalledTimes(1)
    expect(activarSobresMock.mock.calls[0][0]).toBe(tx)
    expect(activarSobresMock.mock.calls[0][1]).toEqual({ venueId: VENUE, orderId: 'order-1', staffId: 'owner-1', items: RENGLONES })
    const ordenDeLlamadas = [(prismaMock as any).payment.create.mock.invocationCallOrder[0], activarSobresMock.mock.invocationCallOrder[0]]
    expect(ordenDeLlamadas[0]).toBeLessThan(ordenDeLlamadas[1])
  })

  it('sin saldo pendiente (pierde el CAS) no crea pago ni activa', async () => {
    armarOrden(false)
    await settleOrder(VENUE, 'order-1')
    expect(activarSobresMock).not.toHaveBeenCalled()
  })
})
