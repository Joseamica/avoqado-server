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
import { createSalePostingInTx } from '@/services/inventory/inventoryPosting.service'
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
    expect(activarSobresMock.mock.calls[0][0]).toBe(tx)
  })

  it('un abono parcial por terminal no activa nada', async () => {
    const tx = txDoble(200)
    await settleStandalonePaymentInTx(tx, 'venue-1', 'order-1', { id: 'pay-1', amount: D(200), tipAmount: D(0) }, 'staff-1')
    expect(activarSobresMock).not.toHaveBeenCalled()
  })

  // A6 r1 (revisión): el cobro sobre una cuenta que YA estaba saldada no es su primer saldado —`paid` no cuenta los REFUND, así
  // que tras devolver todo los cobros previos la siguen «cubriendo»—, pero la activación tiene que correr igual: es la que
  // avisa con PAID_WITH_DEACTIVATED si la venta de tarjetas se canceló y devolvió. Ni vale ni lealtad nuevos.
  it('🔴 r1: un cobro tardío sobre una cuenta YA saldada (no es el primer saldado) también pasa por la activación', async () => {
    const tx = txDoble(1000, 2)
    const r = await settleStandalonePaymentInTx(tx, 'venue-1', 'order-1', { id: 'pay-2', amount: D(500), tipAmount: D(0) }, 'staff-1')
    expect(r.firstSettlement).toBe(false)
    expect(activarSobresMock).toHaveBeenCalledTimes(1)
    expect(activarSobresMock.mock.calls[0][0]).toBe(tx)
    expect(activarSobresMock.mock.calls[0][1]).toEqual({ venueId: 'venue-1', orderId: 'order-1', staffId: 'staff-1', items: RENGLONES })
    // Lo demás del sitio no cambia: sin vale nuevo ni marca de lealtad.
    expect(createSalePostingInTx).not.toHaveBeenCalled()
    expect(tx.order.update.mock.calls[0][0].data).not.toHaveProperty('loyaltyEligibleAt')
  })

  it('la reasignación de un cobro (efectosDeCierre = false) guarda totales sin efectos de cierre: no activa', async () => {
    const tx = txDoble(500)
    await settleStandalonePaymentInTx(tx, 'venue-1', 'order-1', { id: 'pay-1', amount: D(500), tipAmount: D(0) }, 'staff-1', false, false)
    expect(activarSobresMock).not.toHaveBeenCalled()
  })
})
