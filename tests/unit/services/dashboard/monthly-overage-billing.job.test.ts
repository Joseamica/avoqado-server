import { prismaMock } from '../../../__helpers__/setup'

// Mock the service the job depends on. Path matches the import in the job file.
const mockChargeOverage = jest.fn()
jest.mock('../../../../src/services/dashboard/token-budget.service', () => ({
  __esModule: true,
  default: { chargeOverage: (...args: any[]) => mockChargeOverage(...args) },
}))

import { MonthlyOverageBillingJob } from '../../../../src/jobs/monthly-overage-billing.job'

describe('MonthlyOverageBillingJob', () => {
  let job: MonthlyOverageBillingJob

  beforeEach(() => {
    jest.clearAllMocks()
    job = new MonthlyOverageBillingJob()
  })

  afterEach(() => {
    job.stop()
  })

  it('returns zero work when no venues have expired periods with overage', async () => {
    prismaMock.chatbotTokenBudget.findMany.mockResolvedValue([])

    const result = await job.run()

    expect(result).toEqual({
      venuesScanned: 0,
      venuesCharged: 0,
      venuesSkipped: 0,
      venuesFailed: 0,
      totalAmountUSD: 0,
    })
    expect(mockChargeOverage).not.toHaveBeenCalled()
  })

  it('calls chargeOverage for each venue with expired period + overage', async () => {
    prismaMock.chatbotTokenBudget.findMany.mockResolvedValue([
      { venueId: 'v1', overageTokensUsed: 50000 },
      { venueId: 'v2', overageTokensUsed: 25000 },
    ] as any)
    mockChargeOverage
      .mockResolvedValueOnce({ charged: true, venueId: 'v1', tokenAmount: 50000, amountUSD: 1.5, paymentIntentId: 'pi_1' })
      .mockResolvedValueOnce({ charged: true, venueId: 'v2', tokenAmount: 25000, amountUSD: 0.75, paymentIntentId: 'pi_2' })

    const result = await job.run()

    expect(mockChargeOverage).toHaveBeenCalledTimes(2)
    expect(mockChargeOverage).toHaveBeenCalledWith('v1')
    expect(mockChargeOverage).toHaveBeenCalledWith('v2')
    expect(result).toMatchObject({
      venuesScanned: 2,
      venuesCharged: 2,
      venuesSkipped: 0,
      venuesFailed: 0,
      totalAmountUSD: 2.25,
    })
  })

  it('counts skipped venues separately (no payment method, etc.)', async () => {
    prismaMock.chatbotTokenBudget.findMany.mockResolvedValue([
      { venueId: 'v1', overageTokensUsed: 50000 },
      { venueId: 'v2', overageTokensUsed: 30000 },
    ] as any)
    mockChargeOverage
      .mockResolvedValueOnce({ charged: true, venueId: 'v1', tokenAmount: 50000, amountUSD: 1.5, paymentIntentId: 'pi_1' })
      .mockResolvedValueOnce({ skipped: 'no_payment_method', venueId: 'v2' })

    const result = await job.run()

    expect(result).toMatchObject({
      venuesScanned: 2,
      venuesCharged: 1,
      venuesSkipped: 1,
      venuesFailed: 0,
      totalAmountUSD: 1.5,
    })
  })

  it('counts failed venues separately (Stripe declined, etc.)', async () => {
    prismaMock.chatbotTokenBudget.findMany.mockResolvedValue([
      { venueId: 'v1', overageTokensUsed: 50000 },
    ] as any)
    mockChargeOverage.mockResolvedValueOnce({
      charged: false,
      venueId: 'v1',
      error: 'card_declined',
    })

    const result = await job.run()

    expect(result).toMatchObject({
      venuesScanned: 1,
      venuesCharged: 0,
      venuesSkipped: 0,
      venuesFailed: 1,
      totalAmountUSD: 0,
    })
  })

  it('continues processing other venues when one throws unexpectedly', async () => {
    prismaMock.chatbotTokenBudget.findMany.mockResolvedValue([
      { venueId: 'v1', overageTokensUsed: 50000 },
      { venueId: 'v2', overageTokensUsed: 30000 },
    ] as any)
    mockChargeOverage
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({ charged: true, venueId: 'v2', tokenAmount: 30000, amountUSD: 0.9, paymentIntentId: 'pi_2' })

    const result = await job.run()

    expect(mockChargeOverage).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      venuesScanned: 2,
      venuesCharged: 1,
      venuesFailed: 1,
      totalAmountUSD: 0.9,
    })
  })

  // Regression: the prisma filter MUST scope to overage > 0 and expired period.
  // Without this, we'd bill venues whose periods haven't ended yet.
  it('regression: query filters to currentPeriodEnd <= now AND overageTokensUsed > 0', async () => {
    prismaMock.chatbotTokenBudget.findMany.mockResolvedValue([])
    await job.run()

    expect(prismaMock.chatbotTokenBudget.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          currentPeriodEnd: { lte: expect.any(Date) },
          overageTokensUsed: { gt: 0 },
        }),
      }),
    )
  })

  // Regression: concurrent runs must not double-bill.
  it('regression: skips a second concurrent run while the first is in progress', async () => {
    let resolveFirst!: () => void
    const firstRun = new Promise<void>(r => (resolveFirst = r))
    prismaMock.chatbotTokenBudget.findMany.mockImplementationOnce(async () => {
      await firstRun
      return []
    })

    const a = job.run()
    // Second run while the first is still pending — should bail immediately.
    const b = await job.run()

    expect(b.venuesScanned).toBe(0)
    expect(prismaMock.chatbotTokenBudget.findMany).toHaveBeenCalledTimes(1)

    resolveFirst()
    await a
  })
})
