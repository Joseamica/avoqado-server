import { Decimal } from '@prisma/client/runtime/library'
import { LoyaltyReconciliationJob } from '@/jobs/loyalty-reconciliation.job'

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    venueId: 'venue-1',
    total: new Decimal(90),
    customer: { id: 'cust-legacy', firstName: 'Ana', lastName: 'Ruiz' },
    loyaltyStaffId: 'staff-1',
    loyaltyEligibleAt: new Date('2026-09-01T20:00:00.000Z'),
    loyaltyProcessingAt: null,
    loyaltyAttempts: 0,
    ...overrides,
  }
}

function setup() {
  const order = {
    findMany: jest.fn().mockResolvedValue([candidate()]),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
  const cron = { start: jest.fn(), stop: jest.fn() }
  const award = jest.fn().mockResolvedValue({ complete: true, errors: [] })
  const now = () => new Date('2026-09-01T21:00:00.000Z')
  const job = new LoyaltyReconciliationJob({ prisma: { order } as any, cron, award, now })
  return { job, order, cron, award }
}

describe('LoyaltyReconciliationJob', () => {
  it('scans a small, stable batch of only pending eligible orders', async () => {
    const { job, order } = setup()

    await job.runNow()

    expect(order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ loyaltyEligibleAt: { not: null }, loyaltyProcessedAt: null, loyaltyAttempts: { lt: 15 } }),
        orderBy: [{ loyaltyEligibleAt: 'asc' }, { id: 'asc' }],
        take: 25,
      }),
    )
  })

  it('claims with a lease, retries loyalty, and marks the order processed', async () => {
    const { job, order, award } = setup()

    const result = await job.runNow()

    expect(award).toHaveBeenCalledWith({
      venueId: 'venue-1',
      orderId: 'order-1',
      orderTotal: 90,
      staffId: 'staff-1',
      legacyCustomer: { id: 'cust-legacy', firstName: 'Ana', lastName: 'Ruiz' },
    })
    expect(order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'order-1', loyaltyProcessedAt: null }),
        data: expect.objectContaining({ loyaltyProcessedAt: expect.any(Date), loyaltyProcessingAt: null, loyaltyLastError: null }),
      }),
    )
    expect(result).toEqual(expect.objectContaining({ scanned: 1, applied: 1, failed: 0 }))
  })

  it('keeps a failed order pending and releases the lease for a later retry', async () => {
    const { job, order, award } = setup()
    award.mockResolvedValue({ complete: false, errors: ['loyalty:cust-legacy'] })

    const result = await job.runNow()

    expect(order.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'order-1', loyaltyProcessedAt: null, loyaltyProcessingAt: new Date('2026-09-01T21:00:00.000Z') },
        data: { loyaltyProcessingAt: null, loyaltyLastError: 'loyalty:cust-legacy' },
      }),
    )
    expect(result).toEqual(expect.objectContaining({ scanned: 1, applied: 0, failed: 1 }))
  })

  it('does not overlap two sweeps in the same process', async () => {
    const { job, order } = setup()
    let release!: () => void
    order.findMany.mockReturnValue(new Promise(resolve => (release = () => resolve([candidate()]))))

    const first = job.runNow()
    const second = await job.runNow()
    release()
    await first

    expect(second).toEqual({ scanned: 0, applied: 0, failed: 0, skipped: 1 })
    expect(order.findMany).toHaveBeenCalledTimes(1)
  })
})
