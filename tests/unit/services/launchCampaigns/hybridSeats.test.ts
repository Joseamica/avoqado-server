import { prismaMock } from '../../../__helpers__/setup'
const seatCap = jest.fn()
const execute = jest.fn()
const reactivate = jest.fn()
const clearPending = jest.fn()
jest.mock('@/services/access/seatCap.service', () => ({ getVenueSeatCap: (...args: unknown[]) => seatCap(...args) }))
jest.mock('@/services/dashboard/seatReconciliation.service', () => ({
  executeSeatReconciliation: (...args: unknown[]) => execute(...args),
  reactivateSeatCapDeactivated: (...args: unknown[]) => reactivate(...args),
  clearPendingReconciliation: (...args: unknown[]) => clearPending(...args),
}))
import { settleSeatsAfterHybridDelivery, endLapsedHybridContracts } from '@/services/launchCampaigns/hybridSeats'

const replacing = {
  replaces: ['sub_origin'],
  input: { lines: [], replaceSubscriptionIds: ['sub_origin'], dropFeatureCodes: [], keepStaffVenueIds: ['sv_owner', 'sv_ana'] },
}
const adding = { replaces: [], input: { lines: [], replaceSubscriptionIds: [], dropFeatureCodes: [] } }

beforeEach(() => {
  prismaMock.hybridBillingOperation.findUnique.mockResolvedValue(null)
  prismaMock.hybridBillingOperation.upsert.mockResolvedValue({})
  seatCap.mockReset()
  execute.mockReset().mockResolvedValue(2)
  reactivate.mockReset().mockResolvedValue(3)
  clearPending.mockReset().mockResolvedValue(true)
  prismaMock.venueFeature.findFirst.mockReset().mockResolvedValue(null) // no classic plan row behind the replaced subscriptions
})

describe('settleSeatsAfterHybridDelivery', () => {
  it('a paid plan that replaced the classic plan brings back whoever the Free cap turned off, drops its pending choice and marks the purchase', async () => {
    seatCap.mockResolvedValue(null)
    prismaMock.venueFeature.findFirst.mockResolvedValue({ id: 'vf_pro' })
    await settleSeatsAfterHybridDelivery('venue', 'purchase', replacing as never)
    expect(reactivate).toHaveBeenCalledWith('venue')
    expect(clearPending).toHaveBeenCalledWith('venue')
    expect(execute).not.toHaveBeenCalled()
    expect(prismaMock.venueFeature.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: 'venue', stripeSubscriptionId: { in: ['sub_origin'] }, feature: { code: { in: ['PLAN_PRO', 'PLAN_PREMIUM'] } } },
      }),
    )
    expect(prismaMock.hybridBillingOperation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { purchaseId_step: { purchaseId: 'purchase', step: 'SEATS' } },
        create: expect.objectContaining({ step: 'SEATS', status: 'OBSERVED', resultHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      }),
    )
  })

  // 🔴 A classic plan with a scheduled downgrade holds the owner's "who stays"; a functions-only purchase must not erase it,
  // or the automatic order runs instead of the owner's choice when that classic plan ends.
  it('🔴 a functions-only purchase on a paid venue brings people back but keeps the owner’s pending choice', async () => {
    seatCap.mockResolvedValue(null)
    await settleSeatsAfterHybridDelivery('venue', 'purchase', adding as never)
    expect(reactivate).toHaveBeenCalledWith('venue')
    expect(clearPending).not.toHaveBeenCalled()
    expect(prismaMock.venueFeature.findFirst).not.toHaveBeenCalled()
  })

  it('🔴 replacing only a hybrid subscription (not the classic plan) keeps the owner’s pending choice', async () => {
    seatCap.mockResolvedValue(null)
    await settleSeatsAfterHybridDelivery('venue', 'purchase', replacing as never)
    expect(reactivate).toHaveBeenCalledWith('venue')
    expect(clearPending).not.toHaveBeenCalled()
  })

  it('a replacement that leaves the venue on Free applies the cap with the choice from the quote', async () => {
    seatCap.mockResolvedValue(2)
    await settleSeatsAfterHybridDelivery('venue', 'purchase', replacing as never)
    expect(execute).toHaveBeenCalledWith('venue', { keepStaffVenueIds: ['sv_owner', 'sv_ana'] })
    expect(reactivate).not.toHaveBeenCalled()
  })

  it('buying functions on a venue that was already on Free touches nobody', async () => {
    seatCap.mockResolvedValue(2)
    await settleSeatsAfterHybridDelivery('venue', 'purchase', adding as never)
    expect(execute).not.toHaveBeenCalled()
    expect(reactivate).not.toHaveBeenCalled()
    expect(prismaMock.hybridBillingOperation.upsert).toHaveBeenCalled()
  })

  it('a replayed delivery never re-applies the choice made at checkout', async () => {
    prismaMock.hybridBillingOperation.findUnique.mockResolvedValue({ resultHash: 'a'.repeat(64) })
    await settleSeatsAfterHybridDelivery('venue', 'purchase', replacing as never)
    expect(seatCap).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(reactivate).not.toHaveBeenCalled()
  })

  it('a failure leaves no mark, so the next replay retries', async () => {
    seatCap.mockResolvedValue(2)
    execute.mockRejectedValue(new Error('db down'))
    await expect(settleSeatsAfterHybridDelivery('venue', 'purchase', replacing as never)).rejects.toThrow('db down')
    expect(prismaMock.hybridBillingOperation.upsert).not.toHaveBeenCalled()
  })
})

describe('endLapsedHybridContracts', () => {
  beforeEach(() => {
    prismaMock.hybridContract.updateMany.mockResolvedValue({ count: 1 })
  })

  it('does nothing while no cancellation has taken effect', async () => {
    prismaMock.hybridContract.findMany.mockResolvedValue([])
    await expect(endLapsedHybridContracts('venue', 'purchase')).resolves.toBe(0)
    expect(prismaMock.hybridContract.updateMany).not.toHaveBeenCalled()
  })

  it('a lapsed PLAN contract applies the Free cap first, then ends and audits', async () => {
    prismaMock.hybridContract.findMany.mockResolvedValue([{ id: 'hc_plan', planTier: 'PRO' }])
    const order: string[] = []
    execute.mockImplementation(async () => {
      order.push('seats')
      return 1
    })
    prismaMock.hybridContract.updateMany.mockImplementation(async () => {
      order.push('end')
      return { count: 1 }
    })
    await expect(endLapsedHybridContracts('venue', 'purchase')).resolves.toBe(1)
    expect(order).toEqual(['seats', 'end'])
    expect(prismaMock.hybridContract.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { purchaseId: 'purchase', venueId: 'venue', endedAt: null, cancelAt: { lte: expect.any(Date) } },
        take: 9,
      }),
    )
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'HYBRID_ACCESS_ENDED',
          entityId: 'purchase',
          data: { contractIds: ['hc_plan'], reason: 'RENEWAL_CANCELLED' },
        }),
      }),
    )
  })

  it('a lapsed functions-only contract ends without touching the team', async () => {
    prismaMock.hybridContract.findMany.mockResolvedValue([{ id: 'hc_fn', planTier: null }])
    await endLapsedHybridContracts('venue', 'purchase')
    expect(execute).not.toHaveBeenCalled()
    expect(prismaMock.hybridContract.updateMany).toHaveBeenCalled()
  })

  it('if the cap fails, the contract stays open for the next sweep', async () => {
    prismaMock.hybridContract.findMany.mockResolvedValue([{ id: 'hc_plan', planTier: 'PREMIUM' }])
    execute.mockRejectedValue(new Error('db down'))
    await expect(endLapsedHybridContracts('venue', 'purchase')).rejects.toThrow('db down')
    expect(prismaMock.hybridContract.updateMany).not.toHaveBeenCalled()
  })
})
