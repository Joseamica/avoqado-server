/**
 * 🔴 LA PRUEBA DEL BUG DE §5.4 — doble cobro entre dispositivos con llaves DISTINTAS.
 *
 * Spec §10: *"Concurrencia de cobro: dos `payCashOrder` simultáneos, misma orden,
 * **llaves distintas** → un solo `Payment`."*
 *
 * El bug que ya estaba desplegado: `paymentStatus` se leía FUERA de la transacción y
 * el `Payment` se creaba DENTRO. El único guard real era el índice
 * `[venueId, idempotencyKey]`, que sólo atrapa dos requests con la MISMA llave. Dos
 * dispositivos generan llaves distintas, ambos leen PENDING, ambos crean un pago, y
 * `paidAmount > total` sin que nadie se entere hasta el corte.
 *
 * ── Cómo se prueba una carrera con un prisma MOCK ────────────────────────────────
 *
 * No basta con llamar dos veces seguidas: eso prueba secuencia, no carrera. Aquí se
 * monta una BASE FALSA con semántica CAS real:
 *
 *   · `order.findUnique` devuelve el estado ACTUAL de la fila falsa.
 *   · `order.updateMany` sólo aplica si `where.version` coincide con la fila (y el
 *     `paymentStatus` está en el `in`), igual que hace PostgreSQL al reevaluar el
 *     WHERE contra la fila ya actualizada por el ganador. Si no, `count: 0`.
 *   · `payment.create` empuja a un arreglo — es el CONTADOR de la prueba.
 *
 * Como las dos llamadas se lanzan con `Promise.all` y cada `await` cede el turno, sus
 * pasos SE INTERCALAN de verdad. Con el código viejo (validar fuera, crear dentro)
 * este test produce DOS pagos.
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

import { Decimal } from '@prisma/client/runtime/library'

import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

/** Fila de orden falsa con la misma forma que lee el servicio. */
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
  version: number
  areaTicketCode: string | null
}

function installFakeStore(initial: Partial<FakeOrderRow> = {}) {
  const row: FakeOrderRow = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    venueId: 'venue-1',
    paymentStatus: 'PENDING',
    status: 'CONFIRMED',
    subtotal: new Decimal(100),
    discountAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    total: new Decimal(100),
    paidAmount: new Decimal(0),
    remainingBalance: new Decimal(100),
    version: 1,
    areaTicketCode: null,
    ...initial,
  }

  const payments: Array<{ id: string; amount: number; tipAmount: number; idempotencyKey: string | null }> = []

  // Cada `await` cede el turno del event loop: es lo que hace que las dos llamadas
  // concurrentes se intercalen de verdad en vez de correr uña tras otra.
  const yieldTurn = () => new Promise(resolve => setImmediate(resolve))

  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))

  prismaMock.order.findUnique.mockImplementation(async () => {
    await yieldTurn()
    return { ...row }
  })

  prismaMock.order.updateMany.mockImplementation(async ({ where, data }: any) => {
    await yieldTurn()
    const versionMatches = where.version === undefined || where.version === row.version
    const statusMatches = !where.paymentStatus?.in || where.paymentStatus.in.includes(row.paymentStatus)
    if (!versionMatches || !statusMatches) return { count: 0 }

    row.paymentStatus = data.paymentStatus ?? row.paymentStatus
    row.status = data.status ?? row.status
    row.paidAmount = new Decimal(data.paidAmount ?? row.paidAmount)
    row.remainingBalance = new Decimal(data.remainingBalance ?? row.remainingBalance)
    row.total = data.total ?? row.total
    if (data.version?.increment) row.version += data.version.increment
    return { count: 1 }
  })

  prismaMock.payment.findMany.mockImplementation(async () => {
    await yieldTurn()
    return payments.map(p => ({ amount: new Decimal(p.amount), tipAmount: new Decimal(p.tipAmount) }))
  })

  prismaMock.payment.create.mockImplementation(async ({ data }: any) => {
    await yieldTurn()
    // Espeja el índice único [venueId, idempotencyKey] de la base real.
    if (data.idempotencyKey && payments.some(p => p.idempotencyKey === data.idempotencyKey)) {
      const err: any = new Error('Unique constraint failed')
      err.code = 'P2002'
      throw err
    }
    const created = {
      id: `payment-${payments.length + 1}`,
      amount: Number(data.amount),
      tipAmount: Number(data.tipAmount),
      idempotencyKey: data.idempotencyKey ?? null,
    }
    payments.push(created)
    return { ...created, method: data.method, receipts: [] }
  })

  prismaMock.payment.findUnique.mockImplementation(async ({ where }: any) => {
    await yieldTurn()
    const key = where?.venueId_idempotencyKey?.idempotencyKey
    const found = payments.find(p => p.idempotencyKey === key)
    return found
      ? { ...found, method: 'CASH', amount: new Decimal(found.amount), tipAmount: new Decimal(found.tipAmount), receipts: [] }
      : null
  })

  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  prismaMock.order.findUniqueOrThrow?.mockResolvedValue?.({ id: 'order-1', items: [] })

  return { row, payments }
}

describe('payCashOrder — cobro atómico (§5.4)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ── LA PRUEBA DEL BUG ──────────────────────────────────────────────────────────

  it('🔴 dos cobros simultáneos de la MISMA orden con llaves DISTINTAS crean UN SOLO Payment', async () => {
    const { row, payments } = installFakeStore()

    const results = await Promise.allSettled([
      payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', idempotencyKey: 'device-A' }),
      payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', idempotencyKey: 'device-B' }),
    ])

    // 🔴 EL ASSERT QUE IMPORTA: la orden se cobró UNA vez, no dos.
    expect(payments).toHaveLength(1)

    // Uno gana; el otro recibe un rechazo explicable, no un cobro fantasma.
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/ya está pagada|Order is already paid/i)

    // Y el dinero cuadra: la orden quedó PAID con saldo 0, no sobrepagada.
    expect(row.paymentStatus).toBe('PAID')
    expect(Number(row.paidAmount)).toBe(100)
    expect(Number(row.remainingBalance)).toBe(0)
  })

  it('🔴 dos cobros simultáneos SIN llave de idempotencia tampoco cobran dos veces', async () => {
    // Las apps viejas no siempre mandan `idempotencyKey`. Sin el arreglo atómico, este
    // caso no tenía NINGÚN guard: ni el índice único servía.
    const { payments } = installFakeStore()

    await Promise.allSettled([
      payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1' }),
      payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1' }),
    ])

    expect(payments).toHaveLength(1)
  })

  // ── REGRESIÓN: lo que NO se puede romper al arreglar lo de arriba ───────────────

  it('conserva el camino idempotente: el reintento con la MISMA llave devuelve el pago existente', async () => {
    const { payments } = installFakeStore()

    const first = await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', idempotencyKey: 'same-key' })
    const retry = await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', idempotencyKey: 'same-key' })

    expect(payments).toHaveLength(1)
    expect(retry.paymentId).toBe(first.paymentId)
    expect(retry.status).toBe('COMPLETED')
  })

  it('conserva el split de la cuenta: dos cobros CONCURRENTES de la mitad convergen a PAID con DOS pagos', async () => {
    // Es el caso que un 409 seco al perdedor habría roto: dos meseros cobrando mitad y
    // mitad a la vez. El perdedor de la CAS relee, ve el pago del ganador y cobra el
    // restante REAL — no el que había leído antes.
    const { row, payments } = installFakeStore()

    const results = await Promise.allSettled([
      payCashOrder('venue-1', 'order-1', { amount: 5000, tip: 0, staffId: 'staff-1', idempotencyKey: 'half-A' }),
      payCashOrder('venue-1', 'order-1', { amount: 5000, tip: 0, staffId: 'staff-1', idempotencyKey: 'half-B' }),
    ])

    expect(results.every(r => r.status === 'fulfilled')).toBe(true)
    expect(payments).toHaveLength(2)
    expect(row.paymentStatus).toBe('PAID')
    expect(Number(row.paidAmount)).toBe(100)
    expect(Number(row.remainingBalance)).toBe(0)
  })

  it('rechaza cobrar una orden que YA estaba pagada antes de empezar', async () => {
    const { payments } = installFakeStore({ paymentStatus: 'PAID', remainingBalance: new Decimal(0) })

    await expect(payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1' })).rejects.toThrow(/already paid/i)

    expect(payments).toHaveLength(0)
  })

  it('un cobro parcial deja la orden PARTIAL con el restante correcto', async () => {
    const { row, payments } = installFakeStore()

    await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1' })

    expect(payments).toHaveLength(1)
    expect(row.paymentStatus).toBe('PARTIAL')
    expect(Number(row.paidAmount)).toBe(40)
    expect(Number(row.remainingBalance)).toBe(60)
  })

  it('preserva el cobro por servicio en el total al cobrar parcialmente', async () => {
    // Regresión de una auditoría anterior: sin sumar serviceChargeAmount, un pago
    // parcial BORRABA el cobro por servicio del total y el restante dejaba de cobrarlo.
    const { row } = installFakeStore({
      subtotal: new Decimal(100),
      serviceChargeAmount: new Decimal(10),
      total: new Decimal(110),
      remainingBalance: new Decimal(110),
    })

    await payCashOrder('venue-1', 'order-1', { amount: 5000, tip: 0, staffId: 'staff-1' })

    expect(Number(row.total)).toBe(110)
    expect(Number(row.remainingBalance)).toBe(60)
  })
})
