/**
 * 🔴 DINERO — las liquidaciones CASH del dashboard pertenecen al turno actual.
 * El actor sale del auth context del controller; aquí llega ya server-owned.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
const createSalePostingInTxMock = jest.fn().mockResolvedValue(null)
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: (...args: unknown[]) => createSalePostingInTxMock(...args),
  applySalePosting: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn() }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  postCashSaleToDrawer: jest.fn().mockResolvedValue('POSTED'),
  cashSaleDrawerLocalId: (id: string) => `pay:${id}`,
}))

import { Prisma } from '@prisma/client'
import { settleOrder } from '@/services/dashboard/order.dashboard.service'
import { settleCustomerBalance } from '@/services/dashboard/customer.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-settle'
const ACTOR = 'staff-authenticated'

function commonTransactionWorld() {
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  prismaMock.orderItem.findMany.mockResolvedValue([] as any)
  prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true } as any)
  prismaMock.activityLog.create.mockResolvedValue({ id: 'audit-1' } as any)
  prismaMock.payment.create.mockImplementation(async (args: any) => ({
    id: `pay-${prismaMock.payment.create.mock.calls.length}`,
    ...args.data,
  }))
  prismaMock.payment.count.mockResolvedValue(0 as any)
  prismaMock.$queryRaw.mockResolvedValue([] as any)
  createSalePostingInTxMock.mockResolvedValue(null)
}

function arrangeOrderSettlement() {
  const order = {
    id: 'order-1',
    venueId: VENUE,
    orderNumber: 'ORD-1',
    total: new Prisma.Decimal(100),
    tipAmount: new Prisma.Decimal(0),
    remainingBalance: new Prisma.Decimal(100),
    paymentStatus: 'PENDING',
    version: 1,
  }
  prismaMock.order.findFirst.mockResolvedValue(order as any)
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 } as any)
  prismaMock.payment.aggregate.mockResolvedValue({ _sum: { amount: 0, tipAmount: 0 } } as any)
}

beforeEach(() => {
  jest.clearAllMocks()
  commonTransactionWorld()
})

describe('settleOrder — turno y señal atómica', () => {
  it('OPEN atribuye el Payment e incrementa el turno exactamente una vez', async () => {
    arrangeOrderSettlement()
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-open', status: 'OPEN' } as any)
    prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as any)

    await settleOrder(VENUE, 'order-1', undefined, ACTOR)

    expect(prismaMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ shiftId: 'shift-open' }) }),
    )
    expect(prismaMock.shift.updateMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('una liquidación posterior a un abono previo suma dinero pero no vuelve a contar la orden', async () => {
    arrangeOrderSettlement()
    prismaMock.order.findFirst.mockResolvedValue({
      id: 'order-1',
      venueId: VENUE,
      orderNumber: 'ORD-1',
      total: new Prisma.Decimal(100),
      tipAmount: new Prisma.Decimal(0),
      remainingBalance: new Prisma.Decimal(50),
      paymentStatus: 'PARTIAL',
      version: 2,
    } as any)
    prismaMock.payment.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(50), tipAmount: new Prisma.Decimal(0) } } as any)
    prismaMock.payment.count.mockResolvedValue(1 as any)
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-open', status: 'OPEN' } as any)
    prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as any)

    await settleOrder(VENUE, 'order-1', undefined, ACTOR)

    const shiftData = prismaMock.shift.updateMany.mock.calls[0][0].data
    expect(shiftData.totalSales.increment).toEqual(new Prisma.Decimal(50))
    expect(shiftData).not.toHaveProperty('totalOrders')
  })

  it('NO_SHIFT conserva el Payment y escribe la acción canónica con actor autenticado', async () => {
    arrangeOrderSettlement()
    prismaMock.shift.findFirst.mockResolvedValue(null)

    await settleOrder(VENUE, 'order-1', undefined, ACTOR)

    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PAYMENT_WITHOUT_SHIFT',
        entityId: 'pay-1',
        staffId: ACTOR,
        data: expect.objectContaining({
          reason: 'NO_SHIFT',
          channel: 'settleOrder',
          amountPesos: '100.00',
          tipPesos: '0.00',
          totalPesos: '100.00',
        }),
      }),
    })
  })

  it('CLOSING conserva el Payment sin turno y explica el candidato', async () => {
    arrangeOrderSettlement()
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-closing', status: 'CLOSING' } as any)

    await settleOrder(VENUE, 'order-1', undefined, ACTOR)

    expect(prismaMock.payment.create.mock.calls[0][0].data).not.toHaveProperty('shiftId')
    expect(prismaMock.activityLog.create.mock.calls[0][0].data.data).toMatchObject({
      reason: 'SHIFT_NOT_OPEN',
      candidateShiftId: 'shift-closing',
      observedShiftStatus: 'CLOSING',
    })
  })

  it('un candidato OPEN que pierde el claim conserva el Payment y explica CLAIM_LOST', async () => {
    arrangeOrderSettlement()
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-race', status: 'OPEN' } as any)
    prismaMock.shift.updateMany.mockResolvedValue({ count: 0 } as any)

    await settleOrder(VENUE, 'order-1', undefined, ACTOR)

    expect(prismaMock.payment.create.mock.calls[0][0].data).not.toHaveProperty('shiftId')
    expect(prismaMock.activityLog.create.mock.calls[0][0].data.data).toMatchObject({
      reason: 'CLAIM_LOST',
      candidateShiftId: 'shift-race',
      observedShiftStatus: 'OPEN',
    })
  })

  it('con turnos apagados no crea una falsa alarma', async () => {
    arrangeOrderSettlement()
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: false } as any)

    await settleOrder(VENUE, 'order-1', undefined, ACTOR)

    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('un fallo al resolver settings no revierte el Payment y todavía intenta la auditoría atómica', async () => {
    arrangeOrderSettlement()
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.venueSettings.findUnique.mockRejectedValue(new Error('settings timeout'))
    const committed = { payments: [] as any[], audits: [] as any[] }

    prismaMock.$transaction.mockImplementationOnce(async (callback: any) => {
      const staged = { payments: [...committed.payments], audits: [...committed.audits] }
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        order: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'order-1',
            total: new Prisma.Decimal(100),
            tipAmount: new Prisma.Decimal(0),
            remainingBalance: new Prisma.Decimal(100),
            paymentStatus: 'PENDING',
            version: 1,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        payment: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0, tipAmount: 0 } }),
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn().mockImplementation(async ({ data }: any) => {
            const row = { id: 'pay-staged', ...data }
            staged.payments.push(row)
            return row
          }),
        },
        shift: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() },
        venueSettings: prismaMock.venueSettings,
        activityLog: {
          create: jest.fn().mockImplementation(async ({ data }: any) => {
            staged.audits.push(data)
            return { id: 'audit-staged' }
          }),
        },
        orderItem: { findMany: jest.fn().mockResolvedValue([]) },
      }
      const result = await callback(tx)
      Object.assign(committed, staged)
      return result
    })

    await expect(settleOrder(VENUE, 'order-1', undefined, ACTOR)).resolves.toEqual(expect.objectContaining({ settledAmount: 100 }))

    expect(committed.payments).toHaveLength(1)
    expect(committed.audits).toHaveLength(1)
  })

  it('si crear el Payment revierte, no deja bitácora fantasma', async () => {
    arrangeOrderSettlement()
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.payment.create.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 'P2002' }))

    await expect(settleOrder(VENUE, 'order-1', undefined, ACTOR)).rejects.toMatchObject({ code: 'P2002' })

    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('si falla después del audit, Payment, claim y señal se revierten juntos', async () => {
    arrangeOrderSettlement()
    const committed = { payments: [] as any[], audits: [] as any[] }
    let stagedBeforeFailure: typeof committed | null = null
    prismaMock.$transaction.mockImplementationOnce(async (callback: any) => {
      const staged = { payments: [...committed.payments], audits: [...committed.audits] }
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        order: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'order-1',
            total: new Prisma.Decimal(100),
            tipAmount: new Prisma.Decimal(0),
            remainingBalance: new Prisma.Decimal(100),
            paymentStatus: 'PENDING',
            version: 1,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        payment: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0, tipAmount: 0 } }),
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn().mockImplementation(async ({ data }: any) => {
            const row = { id: 'pay-staged', ...data }
            staged.payments.push(row)
            return row
          }),
        },
        shift: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() },
        venueSettings: { findUnique: jest.fn().mockResolvedValue({ enableShifts: true }) },
        activityLog: {
          create: jest.fn().mockImplementation(async ({ data }: any) => {
            staged.audits.push(data)
            return { id: 'audit-staged' }
          }),
        },
        orderItem: { findMany: jest.fn().mockResolvedValue([]) },
      }
      createSalePostingInTxMock.mockImplementationOnce(async () => {
        stagedBeforeFailure = { payments: [...staged.payments], audits: [...staged.audits] }
        throw new Error('posting failure after audit')
      })
      const result = await callback(tx)
      Object.assign(committed, staged)
      return result
    })

    await expect(settleOrder(VENUE, 'order-1', undefined, ACTOR)).rejects.toThrow('posting failure after audit')

    expect(stagedBeforeFailure).toEqual({ payments: [expect.any(Object)], audits: [expect.any(Object)] })
    expect(committed).toEqual({ payments: [], audits: [] })
  })
})

describe('settleCustomerBalance — un claim por cada Payment ganador', () => {
  it('interleaving real bulk-vs-single termina: bulk no conserva Shift mientras espera otra Order', async () => {
    type TxName = 'bulk' | 'single'
    type Waiter = { tx: TxName; resolve: () => void; reject: (error: Error) => void }
    const owners = new Map<string, TxName>()
    const waitingFor = new Map<TxName, string>()
    const waiters = new Map<string, Waiter[]>()
    const held = new Map<TxName, Set<string>>([
      ['bulk', new Set()],
      ['single', new Set()],
    ])
    const acquire = async (tx: TxName, resource: string) => {
      const owner = owners.get(resource)
      if (!owner || owner === tx) {
        owners.set(resource, tx)
        held.get(tx)!.add(resource)
        return
      }
      const ownerWait = waitingFor.get(owner)
      if (ownerWait && owners.get(ownerWait) === tx) {
        throw new Error(`deterministic deadlock: ${tx} waits ${resource}; ${owner} waits ${ownerWait}`)
      }
      waitingFor.set(tx, resource)
      await new Promise<void>((resolve, reject) => {
        waiters.set(resource, [...(waiters.get(resource) ?? []), { tx, resolve, reject }])
      })
      waitingFor.delete(tx)
    }
    const releaseAll = (tx: TxName) => {
      for (const resource of held.get(tx) ?? []) {
        const queue = waiters.get(resource) ?? []
        const next = queue.shift()
        if (next) {
          owners.set(resource, next.tx)
          held.get(next.tx)!.add(resource)
          waiters.set(resource, queue)
          next.resolve()
        } else {
          owners.delete(resource)
        }
      }
      held.get(tx)!.clear()
    }
    const deferred = () => {
      let resolve!: () => void
      const promise = new Promise<void>(r => {
        resolve = r
      })
      return { promise, resolve }
    }
    const bulkHasA = deferred()
    const singleHasB = deferred()
    const bulkNextAttempted = deferred()
    const states: Record<string, 'PENDING' | 'PAID'> = { 'order-a': 'PENDING', 'order-b': 'PENDING' }
    const fresh = (id: string) => ({
      id,
      total: new Prisma.Decimal(id === 'order-a' ? 30 : 70),
      tipAmount: new Prisma.Decimal(0),
      remainingBalance: new Prisma.Decimal(id === 'order-a' ? 30 : 70),
      paymentStatus: states[id],
      version: 1,
    })
    const makeTx = (name: TxName) => ({
      $queryRaw: jest.fn(async (_sql: any, orderId: string) => {
        if (name === 'bulk' && orderId === 'order-a') bulkHasA.resolve()
        if (name === 'bulk' && orderId === 'order-b') {
          bulkNextAttempted.resolve()
          await singleHasB.promise
        }
        await acquire(name, `order:${orderId}`)
        if (name === 'single' && orderId === 'order-b') singleHasB.resolve()
        return []
      }),
      order: {
        findFirst: jest.fn(async ({ where }: any) => fresh(where.id)),
        updateMany: jest.fn(async ({ where }: any) => {
          if (states[where.id] === 'PAID') return { count: 0 }
          states[where.id] = 'PAID'
          return { count: 1 }
        }),
      },
      payment: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0, tipAmount: 0 } }),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(async ({ data }: any) => ({ id: `pay-${name}-${data.orderId}`, ...data })),
      },
      shift: {
        findFirst: jest.fn().mockResolvedValue({ id: 'shift-open', status: 'OPEN' }),
        updateMany: jest.fn(async () => {
          if (name === 'bulk') {
            bulkNextAttempted.resolve()
            await singleHasB.promise
          } else {
            await bulkNextAttempted.promise
          }
          await acquire(name, 'shift:shift-open')
          return { count: 1 }
        }),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: `audit-${name}` }) },
      orderItem: { findMany: jest.fn().mockResolvedValue([]) },
    })
    const bulkTx = makeTx('bulk')
    const singleTx = makeTx('single')
    const txQueue = [bulkTx, singleTx]
    prismaMock.$transaction.mockImplementation(async (callback: any) => {
      const tx = txQueue.shift()!
      const name: TxName = tx === bulkTx ? 'bulk' : 'single'
      try {
        return await callback(tx)
      } finally {
        releaseAll(name)
      }
    })
    prismaMock.customer.findFirst.mockResolvedValue({
      id: 'customer-1',
      orderAssociations: [
        { order: { id: 'order-a', orderNumber: 'A', remainingBalance: new Prisma.Decimal(30), total: new Prisma.Decimal(30) } },
        { order: { id: 'order-b', orderNumber: 'B', remainingBalance: new Prisma.Decimal(70), total: new Prisma.Decimal(70) } },
      ],
    } as any)
    prismaMock.order.findFirst.mockResolvedValue({ ...fresh('order-b'), venueId: VENUE, orderNumber: 'B' } as any)

    const bulk = settleCustomerBalance(VENUE, 'customer-1', undefined, ACTOR)
    await bulkHasA.promise
    const single = settleOrder(VENUE, 'order-b', undefined, ACTOR)

    await expect(Promise.all([bulk, single])).resolves.toEqual([
      expect.objectContaining({ settledOrderCount: 1, settledAmount: 30 }),
      expect.objectContaining({ settledAmount: 70 }),
    ])
    expect(states).toEqual({ 'order-a': 'PAID', 'order-b': 'PAID' })
  })

  it('bloquea todas las órdenes únicas en orden estable antes de tocar Shift', async () => {
    prismaMock.customer.findFirst.mockResolvedValue({
      id: 'customer-1',
      orderAssociations: [
        { order: { id: 'order-b', orderNumber: 'B', remainingBalance: new Prisma.Decimal(70), total: new Prisma.Decimal(70) } },
        { order: { id: 'order-a', orderNumber: 'A', remainingBalance: new Prisma.Decimal(30), total: new Prisma.Decimal(30) } },
        { order: { id: 'order-b', orderNumber: 'B', remainingBalance: new Prisma.Decimal(70), total: new Prisma.Decimal(70) } },
      ],
    } as any)
    const freshById: Record<string, any> = {
      'order-a': {
        id: 'order-a',
        total: new Prisma.Decimal(30),
        tipAmount: new Prisma.Decimal(0),
        remainingBalance: new Prisma.Decimal(30),
        paymentStatus: 'PENDING',
        version: 1,
      },
      'order-b': {
        id: 'order-b',
        total: new Prisma.Decimal(70),
        tipAmount: new Prisma.Decimal(0),
        remainingBalance: new Prisma.Decimal(70),
        paymentStatus: 'PENDING',
        version: 1,
      },
    }
    prismaMock.order.findFirst.mockImplementation(async ({ where }: any) => freshById[where.id])
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.payment.aggregate.mockResolvedValue({ _sum: { amount: 0, tipAmount: 0 } } as any)
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-open', status: 'OPEN' } as any)
    prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as any)
    const ops: string[] = []
    prismaMock.$queryRaw.mockImplementation(async (_sql: any, orderId: string) => {
      ops.push(`order:${orderId}`)
      return []
    })
    prismaMock.shift.findFirst.mockImplementation(async () => {
      ops.push('shift')
      return { id: 'shift-open', status: 'OPEN' } as any
    })

    await settleCustomerBalance(VENUE, 'customer-1', undefined, ACTOR)

    expect(ops.slice(0, 3)).toEqual(['order:order-a', 'order:order-b', 'shift'])
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(2)
  })

  it('relee el saldo durable y no sobrecobra la foto $100 cuando ya quedan $60', async () => {
    prismaMock.customer.findFirst.mockResolvedValue({
      id: 'customer-1',
      orderAssociations: [
        { order: { id: 'order-a', orderNumber: 'A', remainingBalance: new Prisma.Decimal(100), total: new Prisma.Decimal(100) } },
      ],
    } as any)
    prismaMock.order.findFirst.mockResolvedValue({
      id: 'order-a',
      total: new Prisma.Decimal(100),
      tipAmount: new Prisma.Decimal(0),
      remainingBalance: new Prisma.Decimal(60),
      paymentStatus: 'PARTIAL',
      version: 2,
    } as any)
    prismaMock.payment.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(40), tipAmount: new Prisma.Decimal(0) } } as any)
    prismaMock.payment.count.mockResolvedValue(1 as any)
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-open', status: 'OPEN' } as any)
    prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as any)

    const result = await settleCustomerBalance(VENUE, 'customer-1', undefined, ACTOR)

    expect(result).toEqual(expect.objectContaining({ settledOrderCount: 1, settledAmount: 60 }))
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ version: 2, remainingBalance: new Prisma.Decimal(60) }),
      }),
    )
    expect(prismaMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amount: new Prisma.Decimal(60), netAmount: new Prisma.Decimal(60) }),
      }),
    )
    expect(prismaMock.shift.updateMany.mock.calls[0][0].data.totalSales.increment).toEqual(new Prisma.Decimal(60))
  })

  it('dos órdenes ganadoras suman dos veces y heredan el mismo actor server-owned', async () => {
    prismaMock.customer.findFirst.mockResolvedValue({
      id: 'customer-1',
      orderAssociations: [
        { order: { id: 'order-a', orderNumber: 'A', remainingBalance: new Prisma.Decimal(30), total: new Prisma.Decimal(30) } },
        { order: { id: 'order-b', orderNumber: 'B', remainingBalance: new Prisma.Decimal(70), total: new Prisma.Decimal(70) } },
      ],
    } as any)
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.order.findFirst.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      total: new Prisma.Decimal(where.id === 'order-a' ? 30 : 70),
      tipAmount: new Prisma.Decimal(0),
      remainingBalance: new Prisma.Decimal(where.id === 'order-a' ? 30 : 70),
      paymentStatus: 'PENDING',
      version: 1,
    }))
    prismaMock.payment.aggregate.mockResolvedValue({ _sum: { amount: 0, tipAmount: 0 } } as any)
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-open', status: 'OPEN' } as any)
    prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as any)

    await settleCustomerBalance(VENUE, 'customer-1', undefined, ACTOR)

    expect(prismaMock.payment.create).toHaveBeenCalledTimes(2)
    expect(prismaMock.shift.updateMany).toHaveBeenCalledTimes(2)
    for (const paymentCall of prismaMock.payment.create.mock.calls) {
      expect(paymentCall[0].data.shiftId).toBe('shift-open')
    }
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
})
