/**
 * R4 / Review Focus 2: una app (vieja o alterada) manda a mano el tender «Tarjeta de regalo» al cobro manual del POS
 * (`POST …/orders/:id/pay`) o por la cola sin red (`PAY_CASH`, que reproduce `payCashOrder` con `isOfflineReplay`).
 * El servidor lo rechaza en los dos casos y no nace ningún Payment.
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
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/dashboard/autoReorder.service', () => ({ runAutoReorderForVenue: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({ postCashSaleToDrawer: jest.fn().mockResolvedValue({ posted: true }) }))

import { Decimal } from '@prisma/client/runtime/library'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { postCashSaleToDrawer } from '@/services/shared/cashDrawerPosting'
import { prismaMock } from '../../../__helpers__/setup'

function seedOrder() {
  prismaMock.$queryRaw.mockResolvedValue([{ accountingAt: new Date() }])
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.order.findUnique.mockResolvedValue({
    id: 'order-1',
    orderNumber: 'ORD-1',
    paymentStatus: 'PENDING',
    status: 'CONFIRMED',
    subtotal: new Decimal(90),
    discountAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    taxAmount: new Decimal(0),
    contratoDePrecio: 'IVA_INCLUIDO',
    total: new Decimal(90),
    remainingBalance: new Decimal(90),
    version: 1,
    venueId: 'venue-1',
    tableId: null,
    areaTicketCheckoutSession: null,
    customerId: null,
    customer: null,
    originSystem: 'AVOQADO',
  })
  prismaMock.payment.findUnique.mockReset()
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.payment.create.mockResolvedValue({ id: 'payment-1', receipts: [] })
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.venueTenderType.findFirst.mockResolvedValue({
    id: 'tt-gift',
    baseMethod: 'OTHER',
    active: true,
    revision: 1,
    name: 'Tarjeta de regalo',
    systemKind: 'GIFT_CARD',
  })
}

describe('payCashOrder — el tender «Tarjeta de regalo» no se cobra a mano', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    seedOrder()
  })

  it('en vivo: GIFT_CARD_TENDER_NOT_ALLOWED y ningún Payment', async () => {
    await expect(
      payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1', tenderTypeId: 'tt-gift', tenderRevision: 1 }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_TENDER_NOT_ALLOWED', statusCode: 400 })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
  })

  it('PAY_CASH reproducido (cola sin red): también se rechaza — el reducer lo pone en cuarentena, no lo reintenta', async () => {
    await expect(
      payCashOrder('venue-1', 'order-1', {
        amount: 9000,
        tip: 0,
        staffId: 'staff-1',
        idempotencyKey: 'intent-gift-1',
        tenderTypeId: 'tt-gift',
        tenderRevision: 1,
        isOfflineReplay: true,
      }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_TENDER_NOT_ALLOWED' })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('regresión: el mismo cobro en efectivo SIN tender sigue registrándose', async () => {
    const r = await payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })
    expect(r.status).toBe('COMPLETED')
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })
})

/**
 * ⭐ (A7 menor 2) El puente del holder (`tenderState.resolved = paymentResult.tenderResuelto`, order.mobile.service): el núcleo
 * resuelve el tender y el cajón lo lee de ahí. Sin el puente, un vale (method OTHER, no entra al cajón) mandado por el cobro manual
 * registraría un movimiento de cajón CASH y la respuesta diría CASH.
 */
describe('payCashOrder — un tender del catálogo llega al cajón con SU método', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    seedOrder()
    prismaMock.venueTenderType.findFirst.mockResolvedValue({
      id: 'tt-vale',
      baseMethod: 'OTHER',
      active: true,
      revision: 3,
      name: 'Vale de despensa',
      systemKind: null,
    })
    prismaMock.venueTenderTypeRevision.findFirst.mockResolvedValue({
      tenderTypeId: 'tt-vale',
      revision: 3,
      name: 'Vale de despensa',
      countsAsPhysicalCash: false,
      captureTip: false,
      satFormaPago: '08',
      commissionPercent: null,
    })
    prismaMock.cashDrawerSession.findFirst.mockResolvedValue({ id: 'caja-1' })
  })

  it('el vale (OTHER, fuera del cajón) se registra y se manda al cajón como OTHER, nunca como CASH', async () => {
    const r = await payCashOrder('venue-1', 'order-1', {
      amount: 9000,
      tip: 0,
      staffId: 'staff-1',
      tenderTypeId: 'tt-vale',
      tenderRevision: 3,
    })

    expect(r.method).toBe('OTHER')
    expect(postCashSaleToDrawer).toHaveBeenCalledTimes(1)
    expect(postCashSaleToDrawer).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'venue-1',
        paymentId: 'payment-1',
        targetSessionId: 'caja-1',
        method: 'OTHER',
        tenderCountsAsCash: false,
        fundsFlow: 'EXTERNAL_RECORDED',
        tenderTypeId: 'tt-vale',
        orderId: 'order-1',
      }),
    )
  })
})
