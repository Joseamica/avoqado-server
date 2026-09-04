import { Prisma } from '@prisma/client'

import { claimShiftForCapturedPayment, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'

type Release = () => void

class DeterministicRowLocks {
  private owner = new Map<string, string>()
  private waiters = new Map<string, Array<{ transaction: string; resume: Release }>>()

  async acquire(transaction: string, row: string): Promise<void> {
    if (!this.owner.has(row)) {
      this.owner.set(row, transaction)
      return
    }
    if (this.owner.get(row) === transaction) return
    await new Promise<void>(resume => {
      const queue = this.waiters.get(row) ?? []
      queue.push({ transaction, resume })
      this.waiters.set(row, queue)
    })
  }

  release(transaction: string): void {
    for (const [row, owner] of this.owner) {
      if (owner !== transaction) continue
      const next = this.waiters.get(row)?.shift()
      if (next) {
        this.owner.set(row, next.transaction)
        next.resume()
      } else {
        this.owner.delete(row)
      }
    }
  }
}

function fakeMoneyTransaction(name: string, locks: DeterministicRowLocks, trace: string[]) {
  return {
    $queryRaw: jest.fn(async () => {
      trace.push(`${name}:order:request`)
      await locks.acquire(name, 'Order:order-1')
      trace.push(`${name}:order:held`)
      return [{ id: 'order-1' }]
    }),
    shift: {
      findFirst: jest.fn().mockResolvedValue({ id: 'shift-1', status: 'OPEN' }),
      updateMany: jest.fn(async () => {
        trace.push(`${name}:shift:request`)
        await locks.acquire(name, 'Shift:shift-1')
        trace.push(`${name}:shift:held`)
        return { count: 1 }
      }),
    },
    activityLog: { create: jest.fn() },
  }
}

describe('paymentShiftClaim — orden global Order antes de Shift', () => {
  it.each(['manual', 'b4bit'])('settlement vs %s intercalados serializan sin ciclo bajo la misma disciplina', async otherLane => {
    const locks = new DeterministicRowLocks()
    const trace: string[] = []

    const runLane = async (name: string) => {
      const tx = fakeMoneyTransaction(name, locks, trace)
      try {
        await lockExistingOrderForPayment(tx as never, { venueId: 'venue-1', orderId: 'order-1' })
        await claimShiftForCapturedPayment(tx as never, {
          venueId: 'venue-1',
          amountPesos: new Prisma.Decimal(50),
          tipPesos: new Prisma.Decimal(0),
          incrementTotalOrders: name === 'settlement',
        })
      } finally {
        locks.release(name)
      }
    }

    const completed = Promise.all([runLane(otherLane), runLane('settlement')])
    let timeout: NodeJS.Timeout | undefined
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('deadlock')), 250)
    })
    try {
      await expect(Promise.race([completed, deadline])).resolves.toEqual([undefined, undefined])
    } finally {
      if (timeout) clearTimeout(timeout)
    }

    expect(trace).toEqual([
      `${otherLane}:order:request`,
      'settlement:order:request',
      `${otherLane}:order:held`,
      `${otherLane}:shift:request`,
      `${otherLane}:shift:held`,
      'settlement:order:held',
      'settlement:shift:request',
      'settlement:shift:held',
    ])
  })
})
