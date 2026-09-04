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

jest.mock('@/services/referrals/referralQualification.service', () => ({
  onOrderPaid: jest.fn().mockResolvedValue(undefined),
}))

import { Prisma } from '@prisma/client'
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

function installFakeStore(initial: Partial<FakeOrderRow> = {}, options: { openShift?: boolean } = {}) {
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
  const shift = { totalSales: 0, totalTips: 0, totalOrders: 0 }

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
  prismaMock.shift.findFirst.mockResolvedValue(options.openShift ? { id: 'shift-open', status: 'OPEN' } : null)
  prismaMock.shift.updateMany.mockImplementation(async ({ data }: any) => {
    await yieldTurn()
    shift.totalSales += Number(data.totalSales?.increment ?? 0)
    shift.totalTips += Number(data.totalTips?.increment ?? 0)
    shift.totalOrders += Number(data.totalOrders?.increment ?? 0)
    return { count: 1 }
  })
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  prismaMock.order.findUniqueOrThrow?.mockResolvedValue?.({ id: 'order-1', items: [] })

  return { row, payments, shift }
}

function installStatefulP2002RollbackStore() {
  const committed = {
    order: {
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
    } satisfies FakeOrderRow,
    shift: { totalSales: 0, totalTips: 0, totalOrders: 0 },
    loserPayments: [] as any[],
    activityLogs: [] as any[],
  }
  const attempted = { orderCas: 0, shiftClaims: 0 }
  const ops: string[] = []
  const winner = {
    id: 'payment-winner',
    orderId: 'order-1',
    amount: new Decimal(100),
    tipAmount: new Decimal(0),
    method: 'CASH',
    status: 'COMPLETED',
    receipts: [],
    idempotencyKey: 'mobile-p2002',
  }

  prismaMock.order.findUnique.mockImplementation(async () => ({
    ...committed.order,
    areaTicketCheckoutSession: null,
    customerId: null,
    customer: null,
  }))
  let paymentLookups = 0
  prismaMock.payment.findUnique.mockImplementation(async () => {
    paymentLookups += 1
    return paymentLookups === 1 ? null : winner
  })
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })

  prismaMock.$transaction.mockImplementationOnce(async (callback: any) => {
    const staged = {
      order: { ...committed.order },
      shift: { ...committed.shift },
      loserPayments: [...committed.loserPayments],
      activityLogs: [...committed.activityLogs],
    }
    const tx = {
      ...prismaMock,
      order: {
        ...prismaMock.order,
        findUnique: jest.fn(async () => ({ ...staged.order })),
        updateMany: jest.fn(async ({ data }: any) => {
          ops.push('order.updateMany')
          attempted.orderCas += 1
          staged.order.paymentStatus = data.paymentStatus
          staged.order.status = data.status ?? staged.order.status
          staged.order.paidAmount = new Decimal(data.paidAmount)
          staged.order.remainingBalance = new Decimal(data.remainingBalance)
          staged.order.total = new Decimal(data.total)
          staged.order.version += Number(data.version.increment)
          return { count: 1 }
        }),
      },
      payment: {
        ...prismaMock.payment,
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(async () => {
          ops.push('payment.create:P2002')
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['venueId', 'idempotencyKey'] },
          })
        }),
      },
      shift: {
        ...prismaMock.shift,
        findFirst: jest.fn(async () => {
          ops.push('shift.findFirst')
          return { id: 'shift-open', status: 'OPEN' }
        }),
        updateMany: jest.fn(async ({ data }: any) => {
          ops.push('shift.updateMany')
          attempted.shiftClaims += 1
          staged.shift.totalSales += Number(data.totalSales.increment)
          staged.shift.totalTips += Number(data.totalTips.increment)
          staged.shift.totalOrders += Number(data.totalOrders.increment)
          return { count: 1 }
        }),
      },
      activityLog: {
        ...prismaMock.activityLog,
        create: jest.fn(async ({ data }: any) => {
          ops.push('activityLog.create')
          staged.activityLogs.push(data)
          return data
        }),
      },
    }

    const result = await callback(tx)
    committed.order = { ...staged.order }
    committed.shift = { ...staged.shift }
    committed.loserPayments = [...staged.loserPayments]
    committed.activityLogs = [...staged.activityLogs]
    return result
  })

  return { committed, attempted, ops, winner }
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

  it('P2002 después de CAS Order + claim revierte ambos y devuelve el Payment ganador según el contrato móvil', async () => {
    const rollback = installStatefulP2002RollbackStore()

    const result = await payCashOrder('venue-1', 'order-1', {
      amount: 10000,
      tip: 0,
      staffId: 'staff-1',
      idempotencyKey: 'mobile-p2002',
    })

    expect(result).toMatchObject({
      paymentId: rollback.winner.id,
      orderId: 'order-1',
      amount: 10000,
      tipAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
    })
    expect(rollback.attempted).toEqual({ orderCas: 1, shiftClaims: 1 })
    expect(rollback.ops).toEqual(['order.updateMany', 'shift.findFirst', 'shift.updateMany', 'payment.create:P2002'])
    expect(rollback.committed.order).toMatchObject({
      paymentStatus: 'PENDING',
      status: 'CONFIRMED',
      paidAmount: new Decimal(0),
      remainingBalance: new Decimal(100),
      version: 1,
    })
    expect(rollback.committed.shift).toEqual({ totalSales: 0, totalTips: 0, totalOrders: 0 })
    expect(rollback.committed.loserPayments).toEqual([])
    expect(rollback.committed.activityLogs).toEqual([])
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
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

  it('dos cobros de $50 sobre una orden de $100 cuentan una sola orden en el turno', async () => {
    const { payments, shift } = installFakeStore({}, { openShift: true })

    const results = await Promise.allSettled([
      payCashOrder('venue-1', 'order-1', { amount: 5000, tip: 0, staffId: 'staff-1', idempotencyKey: 'half-shift-A' }),
      payCashOrder('venue-1', 'order-1', { amount: 5000, tip: 0, staffId: 'staff-1', idempotencyKey: 'half-shift-B' }),
    ])

    expect(results.every(result => result.status === 'fulfilled')).toBe(true)
    expect(payments).toHaveLength(2)
    expect(shift.totalSales).toBe(100)
    expect(shift.totalOrders).toBe(1)
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
