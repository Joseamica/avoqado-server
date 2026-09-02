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

import logger from '@/config/logger'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

/**
 * 🔴 Un cobro en efectivo MAYOR al saldo no es una venta mayor: es cambio.
 *
 * Medido el 2026-09-01 (/full-testing): `POST …/orders/:id/pay` con `amount: 3000`
 * sobre una cuenta de $25 registraba un `Payment` de $30.00 —y con
 * `999999999999`, uno de $9,999,999,999.99— e inflaba ventas y `VenueTransaction`.
 * La app manda siempre el total exacto y calcula el cambio en el aparato, así que
 * el hoyo sólo se abre por API cruda con sesión válida. El pago manual del
 * dashboard ya rechaza el exceso (400).
 *
 * Contrato: el servidor se comporta como una caja de verdad. Lo que se registra
 * como pago es como máximo lo que la cuenta DEBE (sin propina); lo que sobra
 * regresa en la respuesta como `changeCents`. La propina va aparte y no se toca.
 */
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

function pagoRegistrado() {
  return (prismaMock.payment.create as jest.Mock).mock.calls[0][0].data
}

describe('payCashOrder — un cobro mayor al saldo registra el saldo y devuelve cambio', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('P1 un cobro mayor al saldo registra SÓLO el saldo y devuelve el resto como cambio', async () => {
    seedOrder() // debe $90

    const result = await payCashOrder('venue-1', 'order-1', { amount: 15000, tip: 0, staffId: 'staff-1' })

    expect(pagoRegistrado().amount).toBe(90)
    expect(result.amount).toBe(9000)
    expect(result.changeCents).toBe(6000)
    expect(result.orderPaymentStatus).toBe('PAID')
    expect(result.totalPaidCents).toBe(9000)
  })

  it('un cobro exacto o parcial no tiene cambio', async () => {
    seedOrder()

    const parcial = await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1' })

    expect(pagoRegistrado().amount).toBe(40)
    expect(parcial.amount).toBe(4000)
    expect(parcial.changeCents).toBe(0)
    expect(parcial.orderPaymentStatus).toBe('PARTIAL')
  })

  it('la propina va aparte: no se recorta ni cuenta como cambio', async () => {
    seedOrder()

    const result = await payCashOrder('venue-1', 'order-1', { amount: 15000, tip: 500, staffId: 'staff-1' })

    expect(pagoRegistrado().amount).toBe(90)
    expect(pagoRegistrado().tipAmount).toBe(5)
    expect(result.tipAmount).toBe(500)
    expect(result.changeCents).toBe(6000)
  })

  it('con abonos previos, el saldo es lo que FALTA, no el total de la cuenta', async () => {
    seedOrder()
    prismaMock.payment.findMany.mockResolvedValue([{ amount: new Decimal(50), tipAmount: new Decimal(0), type: 'REGULAR' }])

    const result = await payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })

    expect(pagoRegistrado().amount).toBe(40)
    expect(result.amount).toBe(4000)
    expect(result.changeCents).toBe(5000)
    expect(result.orderPaymentStatus).toBe('PAID')
  })

  it('con devoluciones previas, lo DEVUELTO se puede volver a cobrar: el saldo no revive, el dinero sí se registra', async () => {
    // Diseño existente (payCashOrder.refund.test.ts): una devolución no reabre el
    // saldo, pero un cobro nuevo sobre esa cuenta se registra —el dinero es real—
    // y queda marcado para revisión. El recorte no puede dejarlo en cero.
    seedOrder({ subtotal: new Decimal(200), total: new Decimal(200), remainingBalance: new Decimal(0), paymentStatus: 'PARTIAL' })
    prismaMock.payment.findMany.mockResolvedValue([
      { amount: new Decimal(200), tipAmount: new Decimal(0), type: 'REGULAR' },
      { amount: new Decimal(-200), tipAmount: new Decimal(0), type: 'REFUND' },
    ])

    const result = await payCashOrder('venue-1', 'order-1', { amount: 20000, tip: 0, staffId: 'staff-1' })

    expect(pagoRegistrado().amount).toBe(200)
    expect(result.amount).toBe(20000)
    expect(result.changeCents).toBe(0)
  })

  it('con devoluciones previas, el tope es lo devuelto: más que eso también es cambio', async () => {
    seedOrder({ subtotal: new Decimal(200), total: new Decimal(200), remainingBalance: new Decimal(0), paymentStatus: 'PARTIAL' })
    prismaMock.payment.findMany.mockResolvedValue([
      { amount: new Decimal(200), tipAmount: new Decimal(0), type: 'REGULAR' },
      { amount: new Decimal(-200), tipAmount: new Decimal(0), type: 'REFUND' },
    ])

    const result = await payCashOrder('venue-1', 'order-1', { amount: 30000, tip: 0, staffId: 'staff-1' })

    expect(pagoRegistrado().amount).toBe(200)
    expect(result.changeCents).toBe(10000)
  })

  it('un reintento idempotente devuelve el MISMO cambio: lo pedido menos lo que quedó registrado', async () => {
    // El outbox offline reintenta con la misma llave y el mismo `amount`; el
    // cajero tiene que ver el mismo cambio que la primera vez, y ningún pago nuevo.
    seedOrder()
    prismaMock.payment.findUnique.mockResolvedValue({
      id: 'payment-previo',
      amount: new Decimal(90),
      tipAmount: new Decimal(0),
      method: 'CASH',
      receipts: [],
    })

    const result = await payCashOrder('venue-1', 'order-1', { amount: 15000, tip: 0, staffId: 'staff-1', idempotencyKey: 'k-1' })

    expect(result.paymentId).toBe('payment-previo')
    expect(result.amount).toBe(9000)
    expect(result.changeCents).toBe(6000)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('el recorte deja rastro en el log: la app nunca manda de más, así que es un cliente raro', async () => {
    seedOrder()
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger)

    await payCashOrder('venue-1', 'order-1', { amount: 15000, tip: 0, staffId: 'staff-1' })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cambio'), expect.objectContaining({ orderId: 'order-1', cambioCents: 6000 }))
  })
})
