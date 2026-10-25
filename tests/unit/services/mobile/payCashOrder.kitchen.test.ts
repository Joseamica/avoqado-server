/**
 * Etapa 3 del KDS (spec 2026-09-27 §2): el cobro desde Android/iOS (efectivo, transferencia, métodos propios; y el
 * PAY_CASH de la cola offline, que usa la misma función) arma la comanda de pantalla AL SALDAR. La marca durable
 * viaja en la MISMA escritura que salda la cuenta; un abono parcial no arma nada; sin pantalla, nada cambia.
 */
// FT-GRAVES S-EF: payCashOrder encola la comisión del cobro en su transacción, igual que la terminal. No es objeto de esta
// suite (su prueba es tests/integration/commission/efectivoPosMovil.integration.test.ts).
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
jest.mock('@/services/tpv/table.tpv.service', () => ({ releaseTableIfSettled: jest.fn() }))

const debeMarcarCocinaMock = jest.fn()
jest.mock('@/services/kds/kitchenDisplayStations', () => ({ debeMarcarCocina: (...a: unknown[]) => debeMarcarCocinaMock(...a) }))
const armarMock = jest.fn()
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({ armarComandasTrasCommit: (...a: unknown[]) => armarMock(...a) }))

import { Decimal } from '@prisma/client/runtime/library'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'
import { releaseTableIfSettled } from '@/services/tpv/table.tpv.service'

function seedOrder(tableId: string | null = null) {
  prismaMock.$queryRaw.mockResolvedValue([{ accountingAt: new Date() }])
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
    tableId,
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
  ;(releaseTableIfSettled as jest.Mock).mockReset().mockResolvedValue(true)
})

describe('payCashOrder — comanda de pantalla al saldar', () => {
  it('mesa saldada: libera la última cuenta después de registrar un solo pago', async () => {
    seedOrder('table-1')
    debeMarcarCocinaMock.mockResolvedValue(false)
    let committed = false
    let committedAtRelease = false
    prismaMock.$transaction.mockImplementation(async (cb: any) => {
      const result = await cb(prismaMock)
      committed = true
      return result
    })
    ;(releaseTableIfSettled as jest.Mock).mockImplementation(async () => {
      committedAtRelease = committed
      return true
    })

    const paid = await payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })

    expect(paid).toMatchObject({ paymentId: 'payment-1', status: 'COMPLETED', remainingBalanceCents: 0 })
    expect(releaseTableIfSettled).toHaveBeenCalledTimes(1)
    expect(releaseTableIfSettled).toHaveBeenCalledWith('venue-1', 'table-1')
    expect(committedAtRelease).toBe(true)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })

  it('mesa con abono parcial: conserva su ocupación', async () => {
    seedOrder('table-1')
    debeMarcarCocinaMock.mockResolvedValue(false)

    const paid = await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1' })

    expect(paid).toMatchObject({ orderPaymentStatus: 'PARTIAL', remainingBalanceCents: 5000 })
    expect(releaseTableIfSettled).not.toHaveBeenCalled()
  })

  it('fallo al liberar la mesa: conserva el pago aprobado y no vuelve a cobrar', async () => {
    seedOrder('table-1')
    debeMarcarCocinaMock.mockResolvedValue(false)
    ;(releaseTableIfSettled as jest.Mock).mockRejectedValue(new Error('Own table bookkeeping failure'))

    const paid = await payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })

    expect(paid).toMatchObject({ paymentId: 'payment-1', status: 'COMPLETED', amount: 9000 })
    expect(releaseTableIfSettled).toHaveBeenCalledTimes(1)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })

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
