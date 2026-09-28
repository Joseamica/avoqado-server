/**
 * Plan 3b T7-R1: the paid-but-open repair path (`reconcileOrderFromPayments` → `updateOrderTotalsForStandalonePayment`,
 * direct branch) pre-reads the Order and its payments, so a writer can commit between that read and the write. The
 * write transaction locks the Order first and rereads the inputs under the lock: on a change it reruns once from a
 * fresh read; if the rerun sees another change it writes nothing and warns (the sweep takes the order on its next tick).
 */
import { randomUUID } from 'crypto'
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

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
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
