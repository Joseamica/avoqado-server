/**
 * 🔴 UN REEMBOLSO NO REABRE EL SALDO — camino TERMINAL (`recordOrderPayment`).
 *
 * `updateOrderTotalsForStandalonePayment` recalcula `paidAmount`,
 * `remainingBalance`, `tipAmount` y `total` de la orden desde sus `Payment`
 * COMPLETED. Los leía sin mirar `type`, y un reembolso vive como un `Payment`
 * NEGATIVO `type: REFUND` colgado de la MISMA orden: al cobrar de nuevo sobre
 * una cuenta ya devuelta, lo reembolsado se restaba de lo pagado y la venta
 * volvía a pedir dinero que el cliente ya había recuperado.
 *
 * Decisión del founder (2026-08-18): la cuenta queda CERRADA y MARCADA, nunca
 * "debiendo $X" — el reembolso lleva su propio carril. Es el modelo de Toast
 * ("`totalAmount` is not affected by refunds", estado aparte NONE/PARTIAL/FULL)
 * y de Square (`refunded_money` acumulativo, la venta original intacta), y en
 * México lo cierra el SAT: la devolución se ampara con un CFDI de Egreso y el
 * CFDI de ingreso original NO se modifica ni se cancela.
 */

jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-1', status: 'PENDING' }),
  applySalePosting: jest.fn(),
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn(), update: jest.fn() },
    payment: { create: jest.fn(), findFirst: jest.fn() },
    merchantAccount: { findUnique: jest.fn() },
    venueTransaction: { create: jest.fn() },
    shift: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    paymentAllocation: { create: jest.fn() },
    review: { create: jest.fn() },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    serializedItem: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    orderCustomer: { findMany: jest.fn().mockResolvedValue([]) },
    areaTicketInventoryReservation: { findMany: jest.fn().mockResolvedValue([]) },
    areaTicketCheckoutSession: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    areaTicketPaymentAttempt: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    inventoryPosting: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    inventoryPostingLine: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  getProductInventoryStatus: jest.fn().mockResolvedValue({ inventoryMethod: null, available: true }),
  deductInventoryForProduct: jest.fn().mockResolvedValue({}),
}))

jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: jest.fn(),
}))

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToVenue: jest.fn() },
}))

jest.mock('@/services/payments/transactionCost.service', () => ({
  createTransactionCost: jest.fn(),
}))

import { Decimal } from '@prisma/client/runtime/library'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import * as paymentService from '@/services/tpv/payment.tpv.service'

const VENUE_ID = 'venue-123'
const ORDER_ID = 'order-123'

const mockLogger = logger as unknown as { warn: jest.Mock }

type SeedPayment = { amount: Decimal; tipAmount: Decimal; type: string }

/** El `include.payments` con el que el servicio releyó los pagos de la orden. */
let capturedPaymentsInclude: any

function seedOrder(payments: SeedPayment[], over: Record<string, any> = {}) {
  const order = {
    id: ORDER_ID,
    venueId: VENUE_ID,
    orderNumber: 'ORD-001',
    subtotal: new Decimal(200),
    discountAmount: new Decimal(0),
    total: new Decimal(200),
    paymentStatus: 'PARTIAL',
    source: 'TPV',
    externalId: null,
    createdById: 'staff-1',
    servedById: 'staff-1',
    items: [],
    customer: null,
    payments,
    ...over,
  }

  ;(prisma.order.findUnique as jest.Mock).mockImplementation(async (args: any) => {
    if (args?.include?.payments) {
      capturedPaymentsInclude = args.include.payments
      // El servicio excluye el pago recién creado por id; el mock ya recibe la
      // lista "previa", así que se devuelve tal cual.
      return order
    }
    return order
  })
  ;(prisma.order.update as jest.Mock).mockImplementation(async (args: any) => ({ ...order, ...args.data, items: [] }))

  return order
}

const paymentData = (amountCents: number, tipCents = 0) => ({
  venueId: VENUE_ID,
  amount: amountCents,
  tip: tipCents,
  status: 'COMPLETED' as const,
  method: 'CASH' as const,
  source: 'TPV',
  splitType: 'FULLPAYMENT' as const,
  tpvId: 'tpv-1',
  staffId: 'staff-1',
  paidProductsId: [],
  currency: 'MXN',
  isInternational: false,
})

/** Lo que se escribió en `order.update` (el recálculo del saldo). */
const lastOrderUpdate = () => (prisma.order.update as jest.Mock).mock.calls.at(-1)?.[0]?.data
const warnLogged = (needle: string) => mockLogger.warn.mock.calls.some((c: any[]) => String(c[0]).includes(needle))

describe('recordOrderPayment (TPV) — un reembolso previo no reabre saldo', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    capturedPaymentsInclude = undefined
    ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-1', status: 'OPEN' })
    ;(prisma.shift.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ staffId: 'staff-1', venueId: VENUE_ID })
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-new', feeAmount: 0, netAmount: 200 })
    ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
    ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) =>
      callback({
        payment: { create: prisma.payment.create },
        paymentAllocation: { create: prisma.paymentAllocation.create },
        venueTransaction: { create: prisma.venueTransaction.create },
        order: { update: prisma.order.update },
        shift: { findFirst: prisma.shift.findFirst, updateMany: prisma.shift.updateMany, update: prisma.shift.update },
        activityLog: { create: prisma.activityLog.create },
        areaTicketCheckoutSession: { findFirst: jest.fn().mockResolvedValue(null) },
        areaTicketPaymentAttempt: { findUnique: jest.fn().mockResolvedValue(null) },
        $queryRaw: jest.fn().mockResolvedValue([{ id: ORDER_ID }]),
      }),
    )
  })

  it('🔴 la relectura de pagos PIDE `type` (sin él el refund resta)', async () => {
    seedOrder([{ amount: new Decimal(200), tipAmount: new Decimal(0), type: 'REGULAR' }])

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(20000), 'user-1')

    expect(capturedPaymentsInclude?.select).toMatchObject({ amount: true, tipAmount: true, type: true })
  })

  it('🔴 un cobro NUEVO sobre una cuenta ya reembolsada no resucita lo devuelto', async () => {
    // Cuenta de $200 cobrada y devuelta: +200 REGULAR, −200 REFUND. El cliente
    // paga otra vez $200 con tarjeta. Antes: 200 − 200 + 200 = 200 pagados… pero
    // los $200 devueltos habían BORRADO el primer cobro, así que la cuenta se
    // "cerraba" sin registrar que se había cobrado dos veces. Ahora lo cobrado
    // bruto son $400 y lo devuelto vive en su propio carril.
    seedOrder([
      { amount: new Decimal(200), tipAmount: new Decimal(0), type: 'REGULAR' },
      { amount: new Decimal(-200), tipAmount: new Decimal(0), type: 'REFUND' },
    ])

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(20000), 'user-1')

    const data = lastOrderUpdate()
    expect(data.paymentStatus).toBe('PAID')
    expect(Number(data.paidAmount)).toBe(400)
    expect(Number(data.remainingBalance)).toBe(0)
  })

  it('🔴 un abono PARCIAL sobre una cuenta reembolsada no revive el saldo devuelto', async () => {
    // Cuenta de $200 cobrada y devuelta; entra un abono de $50. Con el refund
    // contando: 200 − 200 + 50 = 50 pagados ⇒ "faltan $150" sobre una venta ya
    // devuelta. Sin contarlo: $250 brutos ⇒ cuenta SALDADA.
    seedOrder([
      { amount: new Decimal(200), tipAmount: new Decimal(0), type: 'REGULAR' },
      { amount: new Decimal(-200), tipAmount: new Decimal(0), type: 'REFUND' },
    ])

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(5000), 'user-1')

    const data = lastOrderUpdate()
    expect(Number(data.paidAmount)).toBe(250)
    expect(Number(data.remainingBalance)).toBe(0)
    expect(data.paymentStatus).toBe('PAID')
  })

  it('la propina devuelta no borra la propina cobrada del total', async () => {
    seedOrder([
      { amount: new Decimal(200), tipAmount: new Decimal(10), type: 'REGULAR' },
      { amount: new Decimal(-200), tipAmount: new Decimal(-10), type: 'REFUND' },
    ])

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(0), 'user-1')

    const data = lastOrderUpdate()
    expect(Number(data.tipAmount)).toBe(10)
    expect(Number(data.total)).toBe(210)
  })

  it('deja un aviso greppable: el cobro NO se bloquea, pero se marca para revisión', async () => {
    seedOrder([
      { amount: new Decimal(200), tipAmount: new Decimal(0), type: 'REGULAR' },
      { amount: new Decimal(-200), tipAmount: new Decimal(0), type: 'REFUND' },
    ])

    // Cuando esto corre, la tarjeta YA se cobró en el proveedor: rechazar aquí
    // dejaría dinero cobrado al cliente SIN registro en Avoqado.
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(20000), 'user-1')

    expect(prisma.payment.create).toHaveBeenCalled()
    expect(warnLogged('[Reembolso] cobro sobre una cuenta con reembolsos')).toBe(true)
  })

  // ── REGRESIÓN: sin reembolsos los importes NO cambian ─────────────────────────

  it('REGRESIÓN: un abono parcial normal deja el saldo real', async () => {
    seedOrder([])

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(5000), 'user-1')

    const data = lastOrderUpdate()
    expect(data.paymentStatus).toBe('PARTIAL')
    expect(Number(data.paidAmount)).toBe(50)
    expect(Number(data.remainingBalance)).toBe(150)
    expect(Number(data.total)).toBe(200)
    expect(warnLogged('[Reembolso] cobro sobre una cuenta con reembolsos')).toBe(false)
  })

  it('REGRESIÓN: el segundo abono de un split sigue cerrando la cuenta', async () => {
    seedOrder([{ amount: new Decimal(150), tipAmount: new Decimal(0), type: 'REGULAR' }])

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(5000), 'user-1')

    const data = lastOrderUpdate()
    expect(data.paymentStatus).toBe('PAID')
    expect(Number(data.paidAmount)).toBe(200)
    expect(Number(data.remainingBalance)).toBe(0)
  })

  it('la propina acumulada entra al total, y el cargo por servicio TAMBIÉN', async () => {
    // 🔴 ACTUALIZADO el 2026-09-02 (auditoría de Codex). Este test nació clavando a propósito
    // una divergencia PREEXISTENTE —este camino no sumaba `serviceChargeAmount`, `payCashOrder`
    // sí— «para que un cambio futuro se note». Éste es ese cambio, y la divergencia era el
    // defecto: el schema define el cargo como «INGRESO GRAVABLE del negocio: SUMA al total y
    // entra al corte y al CFDI». La expectativa vieja (220) era correcta como retrato del
    // código de entonces, no como regla de dinero.
    //
    // 🔑 Y el efecto que hace visible por qué importaba: con 220 cobrados sobre una cuenta que
    // vale 240, la cuenta ya NO queda saldada. Antes se cerraba PAID y los $20 del cargo se
    // evaporaban del corte.
    seedOrder([{ amount: new Decimal(100), tipAmount: new Decimal(10), type: 'REGULAR' }], {
      serviceChargeAmount: new Decimal(20),
    })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(10000, 1000), 'user-1')

    const data = lastOrderUpdate()
    expect(Number(data.tipAmount)).toBe(20) // 10 previa + 10 nueva
    expect(Number(data.total)).toBe(240) // 200 mercancía + 20 cargo por servicio + 20 propina
    expect(Number(data.paidAmount)).toBe(220) // 110 previos + 100 + 10 de propina
    expect(Number(data.remainingBalance)).toBe(20) // justo el cargo por servicio
    expect(data.paymentStatus).toBe('PARTIAL')
  })

  it('REGRESIÓN: el descuento mayor que el subtotal sigue clampando el total a la propina', async () => {
    seedOrder([], { subtotal: new Decimal(253), discountAmount: new Decimal(278.3) })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(5000, 5000), 'user-1')

    const data = lastOrderUpdate()
    // max(0, 253 − 278.30) + 50 de propina = 50. Un total NEGATIVO restaría del corte.
    expect(Number(data.total)).toBe(50)
  })
})
