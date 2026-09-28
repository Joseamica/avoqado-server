/**
 * Plan 3b T7-R1: the paid-but-open repair path (`reconcileOrderFromPayments` → `updateOrderTotalsForStandalonePayment`,
 * direct branch) pre-reads the Order and its payments, so a writer can commit between that read and the write. The
 * write transaction locks the Order first and rereads the inputs under the lock: on a change it reruns once from a
 * fresh read; if the rerun sees another change it writes nothing and warns (the sweep takes the order on its next tick).
 *  - The first two tests pause BEFORE the write transaction opens: they prove the reread, the rerun and the skip.
 *  - The third pauses INSIDE it, right after the reread: it proves the Order lock is already held there (a writer is
 *    blocked on real PostgreSQL). With the lock after the reread, or without it, that writer commits and is overwritten.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { reconcileOrderFromPayments } from '@/services/tpv/payment.tpv.service'
import { addItemsToOrder } from '@/services/tpv/order.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(database.pathname)
) {
  throw new Error('This suite requires an explicitly selected isolated local test database.')
}
const venueId = `reconcile-lost-update-${randomUUID()}`

function barrier<T = void>() {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    release = resolve
  })
  return { promise, release }
}
async function backendPid(tx: Pick<Prisma.TransactionClient, '$queryRaw'>) {
  const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
  return pid
}
/** Some connection is blocked by `pid` (row lock). */
async function blockedBy(pid: number) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
    if (count > 0) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`No connection waited on backend ${pid}`)
}

/**
 * Pauses the repair pass each time it opens a transaction — always after its pre-read. Work run through `meanwhile`
 * (another device's writer) passes straight through, so `opened()` counts only the repair's transactions.
 */
function pauseRepairTransactions(times: number) {
  const gates = Array.from({ length: times }, () => ({ entered: barrier(), finish: barrier() }))
  const original = prisma.$transaction.bind(prisma)
  let opened = 0
  let outside = false
  jest.spyOn(prisma, '$transaction').mockImplementation((async (...args: any[]) => {
    if (!outside) {
      const gate = gates[opened++]
      if (gate) {
        gate.entered.release()
        await gate.finish.promise
      }
    }
    return (original as any)(...args)
  }) as any)
  return {
    gates,
    opened: () => opened,
    async meanwhile(write: () => Promise<unknown>) {
      outside = true
      try {
        await write()
      } finally {
        outside = false
      }
    },
  }
}

/**
 * Pauses the repair pass INSIDE its write transaction, right after it rereads the Order (its last read before writing).
 * Everything else — including other writers' transactions once it paused — passes straight through.
 */
function pauseAfterRepairReread() {
  const entered = barrier<number>()
  const finish = barrier()
  const original = prisma.$transaction.bind(prisma)
  let paused = false
  const bound = (target: object, key: string | symbol) => {
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  }
  jest.spyOn(prisma, '$transaction').mockImplementation(((body: any, options?: any) => {
    if (paused || typeof body !== 'function') return (original as any)(body, options)
    return (original as any)(async (tx: any) => {
      const order = new Proxy(tx.order, {
        get: (delegate, key) =>
          key !== 'findFirst'
            ? bound(delegate, key)
            : async (...args: unknown[]) => {
                const row = await delegate.findFirst(...args)
                if (!paused) {
                  paused = true
                  entered.release(await backendPid(tx))
                  await finish.promise
                }
                return row
              },
      })
      return body(new Proxy(tx, { get: (client, key) => (key === 'order' ? order : bound(client, key)) }))
    }, options)
  }) as any)
  return {
    entered: (repair: Promise<unknown>) =>
      Promise.race([entered.promise, repair.then(() => Promise.reject(new Error('repair never reread inside its transaction')))]),
    release: () => finish.release(),
  }
}

/** Paid but open: the $150 payment is COMPLETED, the transition to PAID never landed. */
function paidButOpenOrder() {
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      subtotal: 150,
      taxAmount: 0,
      total: 150,
      remainingBalance: 150,
      items: { create: { productName: 'Plato', quantity: 1, unitPrice: 150, taxAmount: 0, total: 150 } },
      payments: { create: { venueId, amount: 150, feePercentage: 0, feeAmount: 0, netAmount: 150, method: 'CASH', status: 'COMPLETED' } },
    },
  })
}

/** Another device adds a $20 line (a real TPV writer: Order lock, reread, totals, commit). */
async function addDessert(orderId: string) {
  const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })
  await addItemsToOrder(venueId, orderId, [{ customName: 'Postre', customUnitPriceCents: 2000, quantity: 1 }], version)
}

async function state(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  return {
    subtotal: Number(o.subtotal),
    total: Number(o.total),
    paid: Number(o.paidAmount),
    remaining: Number(o.remainingBalance),
    tip: Number(o.tipAmount),
    paymentStatus: o.paymentStatus,
    status: o.status,
    completedAt: o.completedAt,
  }
}

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    value => ({ value, error: undefined as unknown }),
    error => ({ value: undefined, error }),
  )

async function untilOpened(gate: { entered: { promise: Promise<void> } }, repair: Promise<unknown>) {
  await Promise.race([gate.entered.promise, repair.then(() => Promise.reject(new Error('repair did not open that transaction')))])
}

beforeAll(async () => {
  await prisma.organization.create({ data: { id: venueId, name: venueId, email: `${venueId}@test.example`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: venueId, slug: venueId } })
})
beforeEach(() => jest.mocked(logger.warn).mockClear())
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: venueId } })
})

it('a line added while the repair pass computes is not overwritten by its stale totals', async () => {
  const order = await paidButOpenOrder()
  const tx = pauseRepairTransactions(1)
  const repair = settle(reconcileOrderFromPayments(order.id))
  await untilOpened(tx.gates[0], repair)
  await tx.meanwhile(() => addDessert(order.id))
  tx.gates[0].finish.release()
  expect((await repair).error).toBeUndefined()

  // $170 of goods, $150 paid: the check stays open with $20 due — never PAID with an unpaid line.
  expect(await state(order.id)).toMatchObject({ subtotal: 170, total: 170, paid: 150, remaining: 20, paymentStatus: 'PARTIAL' })
  // The stale attempt wrote nothing; the rerun read the committed line and wrote once.
  expect(tx.opened()).toBe(2)
  expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('[StandaloneTotals]'), expect.anything())
})

it('a second change during the rerun leaves the order as that writer committed it, and warns', async () => {
  const order = await paidButOpenOrder()
  const tx = pauseRepairTransactions(2)
  const repair = settle(reconcileOrderFromPayments(order.id))
  await untilOpened(tx.gates[0], repair)
  await tx.meanwhile(() => addDessert(order.id))
  tx.gates[0].finish.release()
  await untilOpened(tx.gates[1], repair)
  await tx.meanwhile(() => addDessert(order.id))
  const committed = await state(order.id)
  tx.gates[1].finish.release()

  expect(await repair).toEqual({ value: { orderId: order.id, warning: null }, error: undefined })
  expect(committed).toMatchObject({ subtotal: 190, total: 190, paymentStatus: 'PENDING', completedAt: null })
  expect(await state(order.id)).toEqual(committed)
  expect(tx.opened()).toBe(2)
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('[StandaloneTotals]'),
    expect.objectContaining({ orderId: order.id, venueId }),
  )
})

it('a line arriving while the repair pass holds the Order waits for it, then sees the committed PAID and is refused', async () => {
  const order = await paidButOpenOrder()
  const hold = pauseAfterRepairReread()
  const repair = settle(reconcileOrderFromPayments(order.id))
  let adding: Promise<{ error: unknown }> | undefined
  try {
    const pid = await hold.entered(repair)
    adding = settle(addDessert(order.id))
    // Real PostgreSQL: the other device's writer is blocked by the repair pass's transaction, after its reread.
    await blockedBy(pid)
  } finally {
    hold.release()
    await repair
    await adding
  }

  expect(await repair).toEqual({ value: { orderId: order.id, warning: null }, error: undefined })
  // The writer read the committed PAID under the lock and refused: no unpaid line inside a paid check.
  expect((await adding!).error).toMatchObject({ message: 'Cannot add items to a paid order' })
  expect(await state(order.id)).toMatchObject({
    subtotal: 150,
    total: 150,
    paid: 150,
    remaining: 0,
    paymentStatus: 'PAID',
    status: 'COMPLETED',
  })
  expect(await prisma.orderItem.count({ where: { orderId: order.id } })).toBe(1)
})
