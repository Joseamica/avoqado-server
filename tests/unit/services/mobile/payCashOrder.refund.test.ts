/**
 * 🔴 UN REEMBOLSO NO REABRE EL SALDO — camino EFECTIVO (`payCashOrder`).
 *
 * Decisión del founder (2026-08-18): tras un reembolso la cuenta queda CERRADA y
 * MARCADA, nunca "debiendo $X". Es lo que hacen los referentes —Toast documenta
 * literal "`totalAmount` is not affected by refunds" y lleva el estado aparte en
 * `Payment.refundStatus` = NONE/PARTIAL/FULL; Square crea una devolución separada
 * con `source_order_id` y acumula en `refunded_money`— y en México además es
 * requisito fiscal: la devolución se ampara con un CFDI de Egreso y el CFDI de
 * ingreso original NO se toca.
 *
 * El defecto que esto cierra en ESTE camino: los pagos previos se leían con
 * `status: 'COMPLETED'` a secas, y un reembolso vive como un `Payment` NEGATIVO
 * `type: REFUND` colgado de la MISMA orden. Un segundo cobro sobre una cuenta ya
 * reembolsada recalculaba $200 + (−$200) + nuevo, o sea que la venta devuelta
 * volvía a pedir dinero — y el cajero se lo cobraba otra vez al cliente.
 *
 * Mismo harness que `payCashOrder.remainingBalance.test.ts`: base FALSA con
 * semántica CAS real, para poder comparar la RESPUESTA contra lo PERSISTIDO.
 */

jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

const mockBroadcastToVenue = jest.fn()
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: {
    getBroadcastingService: jest.fn(() => ({ broadcastToVenue: mockBroadcastToVenue })),
  },
}))

jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  generateAndStoreReceipt: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
}))

jest.mock('@/services/tpv/payment.tpv.service', () => ({
  mapDigitalReceiptResponse: jest.fn(() => ({ accessKey: 'ak-1', receiptUrl: 'https://r/ak-1', autofacturaAvailable: false })),
  resolveAutofacturaAvailable: jest.fn().mockResolvedValue(false),
  buildInventoryWarning: jest.fn(() => undefined),
}))

jest.mock('@/services/shared/cashDrawerPosting', () => ({
  postCashSaleToDrawer: jest.fn().mockResolvedValue('POSTED'),
  cashSaleDrawerLocalId: (paymentId: string) => `pay:${paymentId}`,
}))

jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-1', status: 'PENDING' }),
  applySalePosting: jest.fn().mockResolvedValue({ postingId: 'posting-1', applied: true, issues: [] }),
}))

jest.mock('@/services/dashboard/autoReorder.service', () => ({
  __esModule: true,
  runAutoReorderForVenue: jest.fn().mockResolvedValue(undefined),
}))

const mockOnOrderPaid = jest.fn().mockResolvedValue(undefined)
jest.mock('@/services/referrals/referralQualification.service', () => ({
  __esModule: true,
  onOrderPaid: (...args: unknown[]) => mockOnOrderPaid(...args),
}))

import { Decimal } from '@prisma/client/runtime/library'

import logger from '@/config/logger'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const mockLogger = logger as unknown as { warn: jest.Mock }

interface FakeOrderRow {
  id: string
  orderNumber: string
  venueId: string
  paymentStatus: 'PENDING' | 'PARTIAL' | 'PAID'
  status: string
  subtotal: Decimal
  discountAmount: Decimal
  serviceChargeAmount: Decimal
  total: Decimal
  paidAmount: Decimal
  remainingBalance: Decimal
  tipAmount: Decimal
  version: number
  areaTicketCode: string | null
}

interface FakePayment {
  id: string
  amount: number
  tipAmount: number
  /** 🔑 Lo que esta suite prueba: sin `type` un reembolso es un cobro negativo. */
  type: 'REGULAR' | 'REFUND'
  idempotencyKey: string | null
  method: string
}

function installFakeStore(initial: Partial<FakeOrderRow> = {}, seededPayments: FakePayment[] = []) {
  const row: FakeOrderRow = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    venueId: 'venue-1',
    paymentStatus: 'PENDING',
    status: 'CONFIRMED',
    subtotal: new Decimal(200),
    discountAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    total: new Decimal(200),
    paidAmount: new Decimal(0),
    remainingBalance: new Decimal(200),
    tipAmount: new Decimal(0),
    version: 1,
    areaTicketCode: null,
    ...initial,
  }

  const payments: FakePayment[] = [...seededPayments]

  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))

  prismaMock.order.findUnique.mockImplementation(async ({ where }: any) => {
    if (where?.venueId === undefined) return null // aislamiento de tenant: regla dura
    if (where.venueId !== row.venueId) return null
    if (where.id !== undefined && where.id !== row.id) return null
    return { ...row }
  })

  prismaMock.order.updateMany.mockImplementation(async ({ where, data }: any) => {
    const versionMatches = where.version === undefined || where.version === row.version
    const statusMatches = !where.paymentStatus?.in || where.paymentStatus.in.includes(row.paymentStatus)
    if (!versionMatches || !statusMatches) return { count: 0 }

    row.paymentStatus = data.paymentStatus ?? row.paymentStatus
    row.status = data.status ?? row.status
    row.paidAmount = new Decimal(data.paidAmount ?? row.paidAmount)
    row.remainingBalance = new Decimal(data.remainingBalance ?? row.remainingBalance)
    row.total = new Decimal(data.total ?? row.total)
    row.tipAmount = new Decimal(data.tipAmount ?? row.tipAmount)
    if (data.version?.increment) row.version += data.version.increment
    return { count: 1 }
  })

  /**
   * 🔴 La consulta que este trabajo cambia. El servicio DEBE pedir `type` — si
   * alguien lo quita del `select`, este mock devuelve `undefined` y el reembolso
   * vuelve a contar como cobro negativo, que es exactamente el bug.
   */
  const paymentSelects: any[] = []
  prismaMock.payment.findMany.mockImplementation(async (args: any) => {
    paymentSelects.push(args?.select)
    return payments.map(p => ({
      amount: new Decimal(p.amount),
      tipAmount: new Decimal(p.tipAmount),
      ...(args?.select?.type ? { type: p.type } : {}),
    }))
  })

  prismaMock.payment.create.mockImplementation(async ({ data }: any) => {
    const created: FakePayment = {
      id: `payment-${payments.length + 1}`,
      amount: Number(data.amount),
      tipAmount: Number(data.tipAmount),
      type: data.type ?? 'REGULAR',
      idempotencyKey: data.idempotencyKey ?? null,
      method: data.method,
    }
    payments.push(created)
    return { ...created, receipts: [] }
  })

  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })

  return { row, payments, paymentSelects }
}

const regular = (amount: number, tip = 0, key: string | null = null): FakePayment => ({
  id: `prev-${amount}`,
  amount,
  tipAmount: tip,
  type: 'REGULAR',
  idempotencyKey: key,
  method: 'CASH',
})

/** Un reembolso tal como lo escriben los tres servicios de refund: NEGATIVO. */
const refunded = (amount: number, tip = 0): FakePayment => ({
  id: `refund-${amount}`,
  amount: -amount,
  tipAmount: -tip,
  type: 'REFUND',
  idempotencyKey: null,
  method: 'CASH',
})

const warnLogged = (needle: string) => mockLogger.warn.mock.calls.some((c: any[]) => String(c[0]).includes(needle))

describe('payCashOrder — un reembolso previo no reabre saldo', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockOnOrderPaid.mockResolvedValue(undefined)
  })

  it('🔴 la consulta de pagos previos PIDE `type` (sin él el refund resta)', async () => {
    const { paymentSelects } = installFakeStore()

    await payCashOrder('venue-1', 'order-1', { amount: 20000, tip: 0, staffId: 'staff-1' })

    expect(paymentSelects.length).toBeGreaterThan(0)
    expect(paymentSelects[0]).toMatchObject({ amount: true, tipAmount: true, type: true })
  })

  it('🔴 un cobro NUEVO sobre una cuenta ya reembolsada no resucita los $200 devueltos', async () => {
    // Cuenta de $200 cobrada y devuelta por completo: +200 REGULAR, −200 REFUND.
    // El cliente vuelve a pagar $200 en efectivo. Antes, lo pagado se calculaba
    // 200 − 200 + 200 = 200 sobre un total de 200 → parecía correcto por
    // casualidad; lo delataba el caso PARCIAL (siguiente test). Lo que aquí se
    // fija es que el refund NO participa: lo cobrado bruto son $400.
    const { row } = installFakeStore({ paymentStatus: 'PARTIAL', status: 'COMPLETED' }, [regular(200), refunded(200)])

    const res = await payCashOrder('venue-1', 'order-1', { amount: 20000, tip: 0, staffId: 'staff-1' })

    expect(res.orderPaymentStatus).toBe('PAID')
    expect(res.remainingBalanceCents).toBe(0)
    expect(res.totalPaidCents).toBe(40000)
    expect(Number(row.paidAmount)).toBe(400)
    expect(Number(row.remainingBalance)).toBe(0)
    expect(row.paymentStatus).toBe('PAID')
  })

  it('🔴 un abono PARCIAL sobre una cuenta reembolsada no revive el saldo devuelto', async () => {
    // Éste es el caso que delataba el bug. Cuenta de $200 cobrada y devuelta.
    // Entra un abono de $50. Con el refund contando: 200 − 200 + 50 = 50 pagados
    // ⇒ "faltan $150" sobre una venta que ya se devolvió. Sin contarlo: $250
    // cobrados en bruto ⇒ cuenta SALDADA, y lo devuelto vive en su propio carril.
    const { row } = installFakeStore({ paymentStatus: 'PARTIAL', status: 'COMPLETED' }, [regular(200), refunded(200)])

    const res = await payCashOrder('venue-1', 'order-1', { amount: 5000, tip: 0, staffId: 'staff-1' })

    expect(res.totalPaidCents).toBe(25000)
    expect(res.remainingBalanceCents).toBe(0)
    expect(res.orderPaymentStatus).toBe('PAID')
    expect(Number(row.remainingBalance)).toBe(0)
  })

  it('la PROPINA devuelta tampoco se resta del total de la cuenta', async () => {
    // Cobro de $200 + $10 de propina, devuelto completo (propina incluida).
    // Antes, la propina negativa del refund borraba la propina del total y
    // `Order.tipAmount` quedaba en 0 aunque el mesero sí la había cobrado.
    // El nuevo cobro entra sin propina para aislar la propina VIEJA.
    const { row } = installFakeStore({ paymentStatus: 'PARTIAL', status: 'COMPLETED' }, [regular(200, 10), refunded(200, 10)])

    await payCashOrder('venue-1', 'order-1', { amount: 1000, tip: 0, staffId: 'staff-1' })

    expect(Number(row.tipAmount)).toBe(10)
    expect(Number(row.total)).toBe(210)
  })

  it('deja un aviso greppable: el cobro NO se bloquea, pero se marca para revisión', async () => {
    installFakeStore({ paymentStatus: 'PARTIAL', status: 'COMPLETED' }, [regular(200), refunded(200)])

    const res = await payCashOrder('venue-1', 'order-1', { amount: 20000, tip: 0, staffId: 'staff-1' })

    // El dinero SIEMPRE se registra: rechazar aquí dejaría efectivo en la caja
    // sin registro en Avoqado, que es peor que el estado raro.
    expect(res.paymentId).toBeDefined()
    expect(warnLogged('[Reembolso] cobro sobre una cuenta con reembolsos')).toBe(true)
  })

  // ── REGRESIÓN: sin reembolsos NADA cambia ─────────────────────────────────────

  it('REGRESIÓN: un abono parcial normal sigue dejando el saldo real', async () => {
    const { row } = installFakeStore({ subtotal: new Decimal(100), total: new Decimal(100), remainingBalance: new Decimal(100) })

    const res = await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1' })

    expect(res.orderPaymentStatus).toBe('PARTIAL')
    expect(res.remainingBalanceCents).toBe(6000)
    expect(res.orderTotalCents).toBe(10000)
    expect(res.totalPaidCents).toBe(4000)
    expect(Number(row.remainingBalance)).toBe(60)
    expect(warnLogged('[Reembolso] cobro sobre una cuenta con reembolsos')).toBe(false)
  })

  it('REGRESIÓN: el segundo abono de un split sigue cerrando la cuenta', async () => {
    const { row } = installFakeStore(
      {
        subtotal: new Decimal(100),
        total: new Decimal(100),
        paymentStatus: 'PARTIAL',
        paidAmount: new Decimal(40),
        remainingBalance: new Decimal(60),
        version: 2,
      },
      [regular(40, 0, 'parte-1')],
    )

    const res = await payCashOrder('venue-1', 'order-1', { amount: 6000, tip: 0, staffId: 'staff-1', idempotencyKey: 'parte-2' })

    expect(res.orderPaymentStatus).toBe('PAID')
    expect(res.remainingBalanceCents).toBe(0)
    expect(res.totalPaidCents).toBe(10000)
    expect(row.paymentStatus).toBe('PAID')
  })

  it('REGRESIÓN: el cargo por servicio y la propina siguen entrando al total', async () => {
    const { row } = installFakeStore({
      subtotal: new Decimal(100),
      serviceChargeAmount: new Decimal(20),
      total: new Decimal(120),
      remainingBalance: new Decimal(120),
    })

    const res = await payCashOrder('venue-1', 'order-1', { amount: 12000, tip: 1500, staffId: 'staff-1' })

    expect(res.orderTotalCents).toBe(13500)
    expect(res.totalPaidCents).toBe(13500)
    expect(res.remainingBalanceCents).toBe(0)
    expect(Number(row.total)).toBe(135)
  })
})
