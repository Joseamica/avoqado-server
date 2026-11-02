/**
 * R8 · camino 1 y 2 (hechos A § 2.1): el cobro manual del POS móvil y la cola sin red `PAY_CASH` (que reproduce
 * `payCashOrder` con `isOfflineReplay`) activan los sobres al SALDAR, en la misma transacción, con los renglones leídos.
 * Spec § 5.1: un PAY_CASH de una app vieja sobre una cuenta de tarjetas se ACEPTA (es dinero real) y activa.
 * S0.3: el efectivo ya capturado sobre una venta CERRADA (S1) también pasa por la activación, en la misma tx: la anomalía de
 * una cuenta de tarjetas devuelta queda al momento, no hasta la revisión nocturna.
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
import { createSalePostingInTx } from '@/services/inventory/inventoryPosting.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const RENGLONES = [{ id: 'oi-1', giftCardId: 'gc-1', productId: null, modifiers: [] }]
const ORDEN = {
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
}
// A6 r1: la transacción recibe un cliente DISTINGUIBLE del global (delega en él por prototipo, así que ve los mismos
// dobles): si la activación se llamara con `prisma` en vez de con `tx`, la identidad no cuadraría.
let txDoble: typeof prismaMock

beforeEach(() => {
  jest.clearAllMocks()
  activarSobresMock.mockResolvedValue({ activated: ['gc-1'] })
  txDoble = Object.create(prismaMock)
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(txDoble))
  prismaMock.order.findUnique.mockResolvedValue(ORDEN)
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

describe('S0.3 · efectivo tardío sobre una venta CERRADA', () => {
  // Se cobró y se devolvió (S1: lo ya capturado se registra y la venta sigue cerrada, sin efectos de saldar).
  beforeEach(() => {
    prismaMock.order.findUnique.mockResolvedValue({
      ...ORDEN,
      paymentStatus: 'REFUNDED',
      status: 'COMPLETED',
      remainingBalance: new Decimal(0),
    })
    prismaMock.payment.findMany.mockResolvedValue([
      { amount: new Decimal(500), tipAmount: new Decimal(0), type: 'REGULAR' },
      { amount: new Decimal(-500), tipAmount: new Decimal(0), type: 'REFUND' },
    ])
    // El aviso de sobrepago de después del commit (venta cerrada que recibe dinero) escribe su bitácora.
    prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
    // El renglón de tarjeta de la cuenta (basta uno para saber si es cuenta de tarjetas).
    prismaMock.orderItem.findFirst.mockResolvedValue({ giftCardId: 'gc-1' })
  })
  const tardio = { amount: 50000, tip: 0, staffId: 'staff-1', idempotencyKey: 'tardio-0001', isOfflineReplay: true }

  it('efectivo tardío (isOfflineReplay) sobre una cuenta CERRADA llama la activación en la misma tx', async () => {
    await payCashOrder('venue-1', 'order-1', tardio)
    expect(activarSobresMock).toHaveBeenCalledTimes(1)
    expect(activarSobresMock).toHaveBeenCalledWith(
      txDoble,
      expect.objectContaining({ venueId: 'venue-1', orderId: 'order-1', staffId: 'staff-1', items: [{ giftCardId: 'gc-1' }] }),
    )
    // Sólo un renglón de tarjeta: basta uno para saber si es cuenta de tarjetas.
    expect(prismaMock.orderItem.findFirst).toHaveBeenCalledWith({
      where: { orderId: 'order-1', giftCardId: { not: null } },
      select: { giftCardId: true },
    })
    // La venta sigue cerrada: nada de lo de saldar (vale de inventario).
    expect(createSalePostingInTx).not.toHaveBeenCalled()
  })

  it('sobre una venta cerrada de mercancía, la llamada sale sin tocar sobres', async () => {
    const real = jest.requireActual<typeof import('@/services/giftCards/giftCardLedger')>('@/services/giftCards/giftCardLedger')
    activarSobresMock.mockImplementation(real.activarSobresDeCuentaPagadaEnTx)
    // Ningún renglón con `giftCardId`: la consulta filtrada no devuelve nada.
    prismaMock.orderItem.findFirst.mockResolvedValue(null)

    await payCashOrder('venue-1', 'order-1', tardio)

    expect(activarSobresMock).toHaveBeenCalledTimes(1)
    expect(activarSobresMock).toHaveBeenCalledWith(txDoble, expect.objectContaining({ items: [] }))
    await expect(activarSobresMock.mock.results[0].value).resolves.toEqual({ activated: [] })
    expect(prismaMock.giftCard.findMany).not.toHaveBeenCalled()
  })
})
