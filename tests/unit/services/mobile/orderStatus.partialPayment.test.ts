/**
 * 🔴 UN ABONO PARCIAL NO RETROCEDE `Order.status`.
 *
 * `Order.status` es, en la práctica, el interruptor **"¿esta cuenta sigue abierta
 * / ocupa la mesa?"** — las listas de cuentas abiertas, el plano de mesas y el
 * cierre de día filtran con `status: { notIn: ['COMPLETED','CANCELLED','DELETED'] }`.
 * El dinero se lee de `paymentStatus`, no de aquí.
 *
 * Dos canales lo escribían como `isFullyPaid ? 'COMPLETED' : 'PENDING'`, o sea que
 * un abono parcial DEGRADABA la etapa de preparación: una comanda que ya iba
 * `CONFIRMED`/`PREPARING` volvía a `PENDING` porque el cliente pagó la mitad.
 * Cobrar no es un evento de cocina. Los otros tres canales (TPV, pago manual y
 * cripto) ya no tocaban `status` en un abono parcial; éstos eran los outliers.
 *
 * La regla que fijan estos tests: **un cobro sólo puede AVANZAR el status a
 * COMPLETED cuando la cuenta queda saldada; nunca lo retrocede, y nunca escribe
 * COMPLETED con saldo pendiente.**
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

jest.mock('@/services/referrals/referralQualification.service', () => ({
  __esModule: true,
  onOrderPaid: jest.fn().mockResolvedValue(undefined),
}))

import fs from 'fs'
import path from 'path'

import { AreaTicketPaymentAttemptStatus, Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

import { finalizeAreaTicketPaymentInTransaction } from '@/services/mobile/areaTicketV7.mobile.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE_ID = 'venue-1'
const ORDER_ID = 'order-1'

// ── payCashOrder ─────────────────────────────────────────────────────────────

/** Base falsa mínima con semántica CAS real: `updateMany` respeta la versión. */
function primePayCash(initial: { status?: string; paymentStatus?: string; paidAmount?: number } = {}, previouslyPaid = 0) {
  const row = {
    id: ORDER_ID,
    orderNumber: 'ORD-1',
    venueId: VENUE_ID,
    status: initial.status ?? 'CONFIRMED',
    paymentStatus: initial.paymentStatus ?? 'PENDING',
    subtotal: new Decimal(100),
    discountAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    total: new Decimal(100),
    paidAmount: new Decimal(initial.paidAmount ?? 0),
    remainingBalance: new Decimal(100 - (initial.paidAmount ?? 0)),
    version: 1,
    areaTicketCode: null,
  }

  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.order.findUnique.mockImplementation(async ({ where }: any) => {
    if (where?.venueId !== row.venueId || (where.id !== undefined && where.id !== row.id)) return null
    return { ...row }
  })
  prismaMock.order.updateMany.mockImplementation(async ({ where, data }: any) => {
    const versionMatches = where.version === undefined || where.version === row.version
    const statusMatches = !where.paymentStatus?.in || where.paymentStatus.in.includes(row.paymentStatus)
    if (!versionMatches || !statusMatches) return { count: 0 }
    row.paymentStatus = data.paymentStatus ?? row.paymentStatus
    // 🔑 `?? row.status` es justo lo que hace PostgreSQL con un campo ausente:
    // si el servicio deja de mandar `status`, la fila conserva el suyo.
    row.status = data.status ?? row.status
    if (data.version?.increment) row.version += data.version.increment
    return { count: 1 }
  })
  prismaMock.payment.findMany.mockResolvedValue(
    previouslyPaid > 0 ? [{ amount: new Decimal(previouslyPaid), tipAmount: new Decimal(0) }] : [],
  )
  prismaMock.payment.create.mockImplementation(async ({ data }: any) => ({
    id: 'payment-1',
    amount: new Decimal(data.amount),
    tipAmount: new Decimal(data.tipAmount),
    method: data.method,
    receipts: [],
  }))
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE_ID, active: true })

  return row
}

/** Lo que se escribió en la orden. */
const cashWrite = () => prismaMock.order.updateMany.mock.calls[0][0].data as Record<string, any>

describe('payCashOrder — el abono parcial no toca la etapa de la orden', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('🔴 un abono PARCIAL sobre una orden CONFIRMED la deja CONFIRMED', async () => {
    // Cuenta de $100, el cliente abona $40. Antes esto la devolvía a PENDING: la
    // cocina veía retroceder una comanda ya confirmada por un evento de caja.
    const row = primePayCash({ status: 'CONFIRMED' })

    await payCashOrder(VENUE_ID, ORDER_ID, { amount: 4000, tip: 0, staffId: 'staff-1' })

    const data = cashWrite()
    expect(data.paymentStatus).toBe('PARTIAL')
    expect(data.status).toBeUndefined() // el campo NI SIQUIERA se escribe
    expect(row.status).toBe('CONFIRMED')
  })

  it('🔴 tampoco retrocede una orden que ya iba en preparación', async () => {
    const row = primePayCash({ status: 'PREPARING' })

    await payCashOrder(VENUE_ID, ORDER_ID, { amount: 4000, tip: 0, staffId: 'staff-1' })

    expect(row.status).toBe('PREPARING')
  })

  it('REGRESIÓN: el abono que SALDA la cuenta sí escribe COMPLETED', async () => {
    const row = primePayCash({ status: 'CONFIRMED' })

    await payCashOrder(VENUE_ID, ORDER_ID, { amount: 10000, tip: 0, staffId: 'staff-1' })

    const data = cashWrite()
    expect(data.paymentStatus).toBe('PAID')
    expect(data.status).toBe('COMPLETED')
    expect(row.status).toBe('COMPLETED')
  })

  it('REGRESIÓN: el segundo abono, el que cierra, también la completa', async () => {
    // $40 ya cobrados + $60 ahora = saldada.
    const row = primePayCash({ status: 'CONFIRMED', paymentStatus: 'PARTIAL', paidAmount: 40 }, 40)

    await payCashOrder(VENUE_ID, ORDER_ID, { amount: 6000, tip: 0, staffId: 'staff-1' })

    expect(cashWrite().paymentStatus).toBe('PAID')
    expect(row.status).toBe('COMPLETED')
  })

  it('🔴 NUNCA escribe status COMPLETED junto con paymentStatus PARTIAL', async () => {
    // La combinación prohibida: libera la mesa y saca la cuenta de las listas de
    // cuentas abiertas MIENTRAS queda dinero por cobrar.
    primePayCash({ status: 'CONFIRMED' })

    await payCashOrder(VENUE_ID, ORDER_ID, { amount: 4000, tip: 0, staffId: 'staff-1' })

    const data = cashWrite()
    expect(data.paymentStatus === 'PARTIAL' && data.status === 'COMPLETED').toBe(false)
  })
})

// ── areaTicketV7 (vales por área) ────────────────────────────────────────────

function primeAreaTicket(orderStatus: string, previouslyPaid: number) {
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.areaTicket.findMany.mockResolvedValue([])
  prismaMock.order.findFirst.mockResolvedValue({
    paymentStatus: previouslyPaid > 0 ? 'PARTIAL' : 'PENDING',
    status: orderStatus,
    subtotal: new Prisma.Decimal(100),
    discountAmount: new Prisma.Decimal(0),
    serviceChargeAmount: new Prisma.Decimal(0),
    servedById: 'staff-1',
    createdById: 'staff-1',
    areaTicketCode: null,
  })
  prismaMock.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal(previouslyPaid), tipAmount: new Prisma.Decimal(0) }])
  prismaMock.order.update.mockResolvedValue({})
  prismaMock.areaTicketPaymentAttempt.findFirst.mockResolvedValue({
    id: 'attempt',
    status: AreaTicketPaymentAttemptStatus.PENDING,
    paymentId: null,
  })
  prismaMock.areaTicketPaymentAttempt.update.mockResolvedValue({})
  prismaMock.areaTicketCheckoutSession.update.mockResolvedValue({})
  prismaMock.areaTicketInventoryReservation.findMany.mockResolvedValue([])
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.areaTicket.updateMany.mockResolvedValue({ count: 0 })
}

const areaWrite = () => prismaMock.order.update.mock.calls[0][0].data as Record<string, any>

describe('areaTicketV7 — la conciliación parcial no retrocede el status', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('🔴 un cobro PARCIAL sobre una orden CONFIRMED no la baja a PENDING', async () => {
    primeAreaTicket('CONFIRMED', 40)

    await finalizeAreaTicketPaymentInTransaction(prismaMock, {
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      paymentId: 'payment-1',
      fullyPaid: false,
      reconcileCapturedPayment: true,
      locked: { sessionId: 'checkout-session', attemptId: 'attempt' } as any,
    })

    const data = areaWrite()
    expect(data.paymentStatus).toBe('PARTIAL')
    expect(data.status).toBeUndefined()
  })

  it('REGRESIÓN: cuando el cobro SALDA la cuenta sí la marca COMPLETED', async () => {
    primeAreaTicket('CONFIRMED', 100)

    await finalizeAreaTicketPaymentInTransaction(prismaMock, {
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      paymentId: 'payment-1',
      fullyPaid: true,
      reconcileCapturedPayment: true,
      locked: { sessionId: 'checkout-session', attemptId: 'attempt' } as any,
    })

    const data = areaWrite()
    expect(data.paymentStatus).toBe('PAID')
    expect(data.status).toBe('COMPLETED')
    expect(data.completedAt).toBeInstanceOf(Date)
  })

  it('🔴 NUNCA escribe status COMPLETED junto con paymentStatus PARTIAL', async () => {
    primeAreaTicket('CONFIRMED', 40)

    await finalizeAreaTicketPaymentInTransaction(prismaMock, {
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      paymentId: 'payment-1',
      fullyPaid: false,
      reconcileCapturedPayment: true,
      locked: { sessionId: 'checkout-session', attemptId: 'attempt' } as any,
    })

    const data = areaWrite()
    expect(data.paymentStatus === 'PARTIAL' && data.status === 'COMPLETED').toBe(false)
  })
})

// ── Guardia transversal sobre los 5 canales de liquidación ───────────────────

describe('ningún canal de cobro degrada Order.status en un abono parcial', () => {
  // Los 5 caminos que liquidan una cuenta abierta. Los otros (payment links,
  // venueCheckout, manualSale) crean su propia orden ya pagada y no aplican.
  const SETTLEMENT_FILES = [
    'src/services/mobile/order.mobile.service.ts', // efectivo móvil
    'src/services/mobile/areaTicketV7.mobile.service.ts', // vales por área
    'src/services/tpv/payment.tpv.service.ts', // TPV
    'src/services/dashboard/manualPayment.service.ts', // pago manual
    'src/services/b4bit/b4bit.service.ts', // cripto
  ]

  // `status: <algo>FullyPaid ? 'COMPLETED' : '<CUALQUIER OTRO>'` — el patrón que
  // devuelve la orden a una etapa anterior cuando el pago no alcanza.
  const DOWNGRADE = /status:\s*[A-Za-z.]*[Ff]ullyPaid\s*\?\s*'COMPLETED'\s*:\s*'[A-Z_]+'/

  it.each(SETTLEMENT_FILES)('%s no escribe el degradado condicional de status', file => {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    const offending = source
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => DOWNGRADE.test(line))

    expect(offending).toEqual([])
  })
})
