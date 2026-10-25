/**
 * R8 · camino 1 y 2 (hechos A § 2.1): el cobro manual del POS móvil y la cola sin red `PAY_CASH` (que reproduce
 * `payCashOrder` con `isOfflineReplay`) activan los sobres al SALDAR, en la misma transacción, con los renglones leídos.
 * Spec § 5.1: un PAY_CASH de una app vieja sobre una cuenta de tarjetas se ACEPTA (es dinero real) y activa.
 */
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  generateAndStoreReceipt: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
}))
jest.mock('@/services/tpv/payment.tpv.service', () => ({
  mapDigitalReceiptResponse: jest.fn(() => null),
  resolveAutofacturaAvailable: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-1' }),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/dashboard/autoReorder.service', () => ({ runAutoReorderForVenue: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined) }))
const activarSobresMock = jest.fn()
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  activarSobresDeCuentaPagadaEnTx: (...a: unknown[]) => activarSobresMock(...a),
}))

import { Decimal } from '@prisma/client/runtime/library'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const RENGLONES = [{ id: 'oi-1', giftCardId: 'gc-1', productId: null, modifiers: [] }]
// A6 r1: la transacción recibe un cliente DISTINGUIBLE del global (delega en él por prototipo, así que ve los mismos
// dobles): si la activación se llamara con `prisma` en vez de con `tx`, la identidad no cuadraría.
let txDoble: typeof prismaMock

beforeEach(() => {
  jest.clearAllMocks()
  activarSobresMock.mockResolvedValue({ activated: ['gc-1'] })
  txDoble = Object.create(prismaMock)
  prismaMock.$queryRaw.mockResolvedValue([{ accountingAt: new Date() }])
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(txDoble))
  prismaMock.order.findUnique.mockResolvedValue({
    id: 'order-1',
    orderNumber: 'ORD-1',
    paymentStatus: 'PENDING',
    status: 'CONFIRMED',
    subtotal: new Decimal(500),
    discountAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    taxAmount: new Decimal(0),
    contratoDePrecio: 'IVA_INCLUIDO',
    total: new Decimal(500),
    remainingBalance: new Decimal(500),
    version: 1,
    venueId: 'venue-1',
    tableId: null,
    areaTicketCheckoutSession: null,
    customerId: null,
    customer: null,
    originSystem: 'AVOQADO',
    areaTicketCode: null,
  })
  prismaMock.payment.findUnique.mockReset()
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.orderItem.findMany.mockResolvedValue(RENGLONES)
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.payment.create.mockResolvedValue({ id: 'payment-1', receipts: [], createdAt: new Date() })
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
})

describe('R8 · efectivo del POS móvil', () => {
  it('cobro en vivo que salda la cuenta: activa los sobres con la MISMA tx y los renglones leídos', async () => {
    await payCashOrder('venue-1', 'order-1', { amount: 50000, tip: 0, staffId: 'staff-1', idempotencyKey: 'vivo-0001' })
    expect(activarSobresMock).toHaveBeenCalledTimes(1)
    expect(activarSobresMock.mock.calls[0][0]).toBe(txDoble)
    expect(activarSobresMock.mock.calls[0][1]).toEqual({
      venueId: 'venue-1',
      orderId: 'order-1',
      staffId: 'staff-1',
      items: RENGLONES,
    })
  })

  it('🔴 PAY_CASH reproducido (cola sin red de una app vieja): se acepta y activa igual', async () => {
    const r = await payCashOrder('venue-1', 'order-1', {
      amount: 50000,
      tip: 0,
      staffId: 'staff-1',
      idempotencyKey: 'intent-0001',
      isOfflineReplay: true,
    })
    expect(r.status).toBe('COMPLETED')
    expect(activarSobresMock).toHaveBeenCalledTimes(1)
    expect(activarSobresMock.mock.calls[0][0]).toBe(txDoble)
    expect(activarSobresMock.mock.calls[0][1]).toEqual(expect.objectContaining({ venueId: 'venue-1', orderId: 'order-1' }))
  })

  it('un abono parcial no activa nada (la cuenta no quedó pagada)', async () => {
    await payCashOrder('venue-1', 'order-1', { amount: 20000, tip: 0, staffId: 'staff-1', idempotencyKey: 'parcial-0001' })
    expect(activarSobresMock).not.toHaveBeenCalled()
  })
})
