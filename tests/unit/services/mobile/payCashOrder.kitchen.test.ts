/**
 * Etapa 3 del KDS (spec 2026-09-27 §2): el cobro desde Android/iOS (efectivo, transferencia, métodos propios; y el
 * PAY_CASH de la cola offline, que usa la misma función) arma la comanda de pantalla AL SALDAR. La marca durable
 * viaja en la MISMA escritura que salda la cuenta; un abono parcial no arma nada; sin pantalla, nada cambia.
 */
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

const debeMarcarCocinaMock = jest.fn()
jest.mock('@/services/kds/kitchenDisplayStations', () => ({ debeMarcarCocina: (...a: unknown[]) => debeMarcarCocinaMock(...a) }))
const armarMock = jest.fn()
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({ armarComandasTrasCommit: (...a: unknown[]) => armarMock(...a) }))

import { Decimal } from '@prisma/client/runtime/library'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

function seedOrder() {
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.order.findUnique.mockResolvedValue({
    id: 'order-1',
    orderNumber: 'ORD-1',
    paymentStatus: 'PENDING',
    subtotal: new Decimal(90),
    discountAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    total: new Decimal(90),
    remainingBalance: new Decimal(90),
    version: 1,
    venueId: 'venue-1',
    areaTicketCheckoutSession: null,
    customerId: null,
    customer: null,
  } as any)
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' } as any)
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true } as any)
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.payment.create.mockResolvedValue({ id: 'payment-1', receipts: [] } as any)
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' } as any)
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' } as any)
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
}

const escrituraConMarca = () =>
  (prismaMock.order.updateMany as jest.Mock).mock.calls.some(([a]) => a?.data?.kitchenPendingAt instanceof Date)

beforeEach(() => {
  jest.clearAllMocks()
  armarMock.mockResolvedValue(undefined)
})

describe('payCashOrder — comanda de pantalla al saldar', () => {
  it('venta saldada con pantalla: la marca va en la escritura que salda y la comanda se arma una vez', async () => {
    seedOrder()
    debeMarcarCocinaMock.mockResolvedValue(true)

    await payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })

    expect(prismaMock.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentStatus: 'PAID', kitchenPendingAt: expect.any(Date) }) }),
    )
    expect(armarMock).toHaveBeenCalledTimes(1)
    expect(armarMock).toHaveBeenCalledWith('venue-1', 'order-1', 'PAID')
  })

  it('abono PARCIAL: ni marca ni comanda (la comanda nace al saldar)', async () => {
    seedOrder()
    debeMarcarCocinaMock.mockResolvedValue(true)

    await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1' })

    expect(escrituraConMarca()).toBe(false)
    expect(armarMock).not.toHaveBeenCalled()
  })

  it('negocio sin pantalla: ni marca ni comanda', async () => {
    seedOrder()
    debeMarcarCocinaMock.mockResolvedValue(false)

    await payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })

    expect(escrituraConMarca()).toBe(false)
    expect(armarMock).not.toHaveBeenCalled()
  })
})
