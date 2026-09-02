/**
 * 🔴 El cobro en EFECTIVO desde Android/iOS también acredita lealtad (puntos y sellos).
 *
 * Defecto real (2026-09-01, Testarudo Cafe): el barista escaneaba —o elegía— al
 * cliente, cobraba el café en efectivo desde el Sunmi, y el sello de la tarjeta
 * digital no subía. El MISMO cobro hecho con tarjeta en la PAX sí sellaba. La
 * diferencia no era una decisión: `payCashOrder` nunca llamó a la regla de lealtad.
 *
 * Contrato: al quedar la orden PAGADA se invoca la regla compartida
 * (`awardLoyaltyForPaidOrder`) con la misma base que usa la PAX —el `Order.total`
 * que acaba de escribirse—, con quien cobró, y con el cliente heredado de la orden
 * como respaldo. Un abono PARCIAL no acredita nada: el sello es por cuenta saldada,
 * y un abono de $1 sobre un café de $90 no puede dar café gratis.
 */

jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

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

jest.mock('@/services/dashboard/autoReorder.service', () => ({
  runAutoReorderForVenue: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/referrals/referralQualification.service', () => ({
  onOrderPaid: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({
  awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined),
}))

import { Decimal } from '@prisma/client/runtime/library'

import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'
import { prismaMock } from '../../../__helpers__/setup'

const awardMock = awardLoyaltyForPaidOrder as jest.Mock

function seedOrder(overrides: Record<string, unknown> = {}) {
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
    customerId: 'cust-1',
    customer: { id: 'cust-1', firstName: 'Ana', lastName: 'Ruiz' },
    ...overrides,
  })
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.payment.create.mockResolvedValue({ id: 'payment-1', receipts: [] })
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
}

describe('payCashOrder — lealtad al quedar pagada (paridad con la PAX)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    awardMock.mockResolvedValue(undefined)
  })

  it('🔴 un cobro en efectivo que SALDA la cuenta acredita lealtad con la misma base que la PAX', async () => {
    seedOrder()

    const result = await payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })

    expect(result.paymentId).toBe('payment-1')
    expect(awardMock).toHaveBeenCalledTimes(1)
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ loyaltyEligibleAt: expect.any(Date) }) }),
    )
    expect(awardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'venue-1',
        orderId: 'order-1',
        // Lo que acaba de escribirse en Order.total: es la base que usa la PAX.
        orderTotal: 90,
        staffId: 'staff-1',
        legacyCustomer: { id: 'cust-1', firstName: 'Ana', lastName: 'Ruiz' },
      }),
    )
  })

  it('un abono PARCIAL no acredita nada: el sello es por cuenta saldada', async () => {
    seedOrder()

    await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1' })

    expect(awardMock).not.toHaveBeenCalled()
  })

  it('la lealtad corre DESPUÉS de commitear el cobro, y si truena el cobro ya está registrado', async () => {
    seedOrder()
    awardMock.mockRejectedValue(new Error('loyalty down'))

    const result = await payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })

    expect(result.paymentId).toBe('payment-1')
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })

  it('una orden sin cliente heredado igual pasa por la regla (los OrderCustomer los resuelve ella)', async () => {
    seedOrder({ customerId: null, customer: null })

    await payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })

    expect(awardMock).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order-1', legacyCustomer: null }))
  })
})
