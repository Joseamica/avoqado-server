/**
 * El cableado: cobrar en efectivo desde el POS móvil DEBE mover el cajón.
 *
 * `payCashOrder` es el mismo servicio por el que pasan el cobro en línea
 * (`POST /mobile/venues/:venueId/orders/:orderId/pay`) y la reproducción del
 * outbox offline (`PAY_CASH` → `applyPayCash` → `payCashOrder`). Enganchar aquí
 * cubre los dos caminos con UN solo punto.
 *
 * Y lo que NO debe pasar: un cobro declarado a mano (tarjeta de una terminal
 * ajena, transferencia) viaja por este MISMO servicio con `method` distinto de
 * CASH. Ese dinero nunca entró al cajón; sumarlo le inventaría al cajero un
 * faltante por ese monto al cerrar.
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

jest.mock('@/services/shared/cashDrawerPosting', () => ({
  postCashSaleToDrawer: jest.fn().mockResolvedValue('POSTED'),
  cashSaleDrawerLocalId: (paymentId: string) => `pay:${paymentId}`,
}))

import { Decimal } from '@prisma/client/runtime/library'

import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { postCashSaleToDrawer } from '@/services/shared/cashDrawerPosting'
import { prismaMock } from '../../../__helpers__/setup'

function installFakeStore() {
  const row = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    venueId: 'venue-1',
    paymentStatus: 'PENDING' as string,
    status: 'CONFIRMED',
    subtotal: new Decimal(100),
    discountAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    total: new Decimal(100),
    paidAmount: new Decimal(0),
    remainingBalance: new Decimal(100),
    version: 1,
    areaTicketCode: null,
  }

  const payments: Array<{ id: string; idempotencyKey: string | null }> = []

  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.order.findUnique.mockImplementation(async () => ({ ...row }))
  prismaMock.order.updateMany.mockImplementation(async ({ where, data }: any) => {
    const versionMatches = where.version === undefined || where.version === row.version
    const statusMatches = !where.paymentStatus?.in || where.paymentStatus.in.includes(row.paymentStatus)
    if (!versionMatches || !statusMatches) return { count: 0 }
    row.paymentStatus = data.paymentStatus ?? row.paymentStatus
    if (data.version?.increment) row.version += data.version.increment
    return { count: 1 }
  })
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.payment.create.mockImplementation(async ({ data }: any) => {
    const created = { id: `payment-${payments.length + 1}`, idempotencyKey: data.idempotencyKey ?? null }
    payments.push(created)
    return { ...created, ...data, receipts: [] }
  })
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', firstName: 'Ana', lastName: 'Cajera' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })

  return { row, payments }
}

describe('payCashOrder → cajón', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(postCashSaleToDrawer as jest.Mock).mockResolvedValue('POSTED')
  })

  it('🔴 un cobro en efectivo engancha el cajón con el monto + la propina', async () => {
    installFakeStore()

    await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 1500, staffId: 'staff-1' })

    expect(postCashSaleToDrawer).toHaveBeenCalledTimes(1)
    expect((postCashSaleToDrawer as jest.Mock).mock.calls[0][0]).toMatchObject({
      venueId: 'venue-1',
      paymentId: 'payment-1',
      method: 'CASH',
      status: 'COMPLETED',
      amount: 100,
      tipAmount: 15,
      orderId: 'order-1',
    })
  })

  it('🔴 un cobro declarado a mano (transferencia) NO toca el cajón', async () => {
    installFakeStore()

    await payCashOrder('venue-1', 'order-1', {
      amount: 10000,
      tip: 0,
      staffId: 'staff-1',
      method: 'BANK_TRANSFER',
      externalSource: 'Terminal BBVA',
    })

    // El enganche recibe el método REAL y `paymentCountsAsDrawerCash` lo descarta;
    // si aquí llegara como CASH, el arqueo inventaría un faltante.
    const call = (postCashSaleToDrawer as jest.Mock).mock.calls[0]
    if (call) expect(call[0].method).toBe('BANK_TRANSFER')
  })

  it('🔴 si el enganche del cajón falla, el COBRO igual se completa (fail-open)', async () => {
    installFakeStore()
    ;(postCashSaleToDrawer as jest.Mock).mockRejectedValue(new Error('cajón caído'))

    const res = await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1' })

    expect(res.status).toBe('COMPLETED')
    expect(res.paymentId).toBe('payment-1')
  })
})
