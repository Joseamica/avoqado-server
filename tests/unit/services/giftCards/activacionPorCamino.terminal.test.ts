/**
 * R8 · camino 3 (terminal PAX/Nexgo, POS→TPV, webhook AngelPay y el `/fast` que delega en `recordOrderPayment`):
 * `settleStandalonePaymentInTx` salda la cuenta con el candado del llamador y, en el primer saldado, activa los sobres
 * en esa misma transacción. La reasignación (`efectosDeCierre = false`) no activa nada.
 */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn() }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn() }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/payments/transactionCost.service', () => ({ createTransactionCost: jest.fn() }))
jest.mock('@/services/dashboard/autoReorder.service', () => ({ runAutoReorderForVenue: jest.fn() }))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-1' }),
  applySalePosting: jest.fn(),
}))
const activarSobresMock = jest.fn()
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  activarSobresDeCuentaPagadaEnTx: (...a: unknown[]) => activarSobresMock(...a),
}))

import { Decimal } from '@prisma/client/runtime/library'
import { settleStandalonePaymentInTx } from '@/services/tpv/payment.tpv.service'

const D = (v: number) => new Decimal(v)
const RENGLONES = [{ id: 'oi-1', giftCardId: 'gc-1', productId: null, modifiers: [] }]

function txDoble(pagado: number, conteo = 1) {
  return {
    order: {
      findFirstOrThrow: jest.fn().mockResolvedValue({
        id: 'order-1',
        venueId: 'venue-1',
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        originSystem: 'AVOQADO',
        subtotal: D(500),
        discountAmount: D(0),
        serviceChargeAmount: D(0),
        taxAmount: D(0),
        contratoDePrecio: 'IVA_INCLUIDO',
        completedAt: null,
        servedById: 'staff-1',
        createdById: 'staff-1',
        items: RENGLONES,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: D(pagado), tipAmount: D(0) }, _count: conteo }) },
    activityLog: { create: jest.fn() },
  } as any
}

beforeEach(() => {
  jest.clearAllMocks()
  activarSobresMock.mockResolvedValue({ activated: ['gc-1'] })
})

describe('R8 · terminal', () => {
  it('el primer saldado por terminal activa los sobres con la MISMA tx y los renglones de la cuenta', async () => {
    const tx = txDoble(500)
    const r = await settleStandalonePaymentInTx(tx, 'venue-1', 'order-1', { id: 'pay-1', amount: D(500), tipAmount: D(0) }, 'staff-1')
    expect(r.firstSettlement).toBe(true)
    expect(activarSobresMock).toHaveBeenCalledWith(tx, { venueId: 'venue-1', orderId: 'order-1', staffId: 'staff-1', items: RENGLONES })
  })

  it('un abono parcial por terminal no activa nada', async () => {
    const tx = txDoble(200)
    await settleStandalonePaymentInTx(tx, 'venue-1', 'order-1', { id: 'pay-1', amount: D(200), tipAmount: D(0) }, 'staff-1')
    expect(activarSobresMock).not.toHaveBeenCalled()
  })

  it('la reasignación de un cobro (efectosDeCierre = false) guarda totales sin efectos de cierre: no activa', async () => {
    const tx = txDoble(500)
    await settleStandalonePaymentInTx(tx, 'venue-1', 'order-1', { id: 'pay-1', amount: D(500), tipAmount: D(0) }, 'staff-1', false, false)
    expect(activarSobresMock).not.toHaveBeenCalled()
  })
})
