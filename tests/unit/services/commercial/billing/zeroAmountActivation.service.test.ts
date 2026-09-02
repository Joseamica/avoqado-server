import { activateCommercialZeroAmountPeriod } from '@/services/commercial/billing/zeroAmountActivation.service'

describe('commercial zero-amount activation', () => {
  it('satisfies an accepted zero period without inventing cash, allocation or payment attempt', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          periodId: 'period-free-1',
          periodStatus: 'OPEN',
          periodStatusRevision: 1,
          amountDueMinor: 0n,
          contractId: 'contract-free-1',
          contractStatus: 'PENDING_PAYMENT',
          acceptanceStatus: 'ACCEPTED',
          organizationId: 'org-1',
          venueId: 'venue-1',
          receivableId: 'receivable-free-1',
          receivableStatus: 'OPEN',
          receivableAmountDueMinor: 0n,
          activeAllocatedMinor: 0n,
        },
      ]),
      commercialEventOutbox: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'outbox-free-1' }),
      },
      commercialSubscriptionPeriod: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      commercialAccountReceivable: {
        update: jest.fn().mockResolvedValue({ id: 'receivable-free-1', status: 'PAID' }),
      },
      commercialCashReceipt: { create: jest.fn() },
      commercialBillingAllocation: { create: jest.fn() },
      commercialBillingPaymentAttempt: { create: jest.fn() },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-free-1' }) },
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }

    const result = await activateCommercialZeroAmountPeriod(
      {
        organizationId: 'org-1',
        venueId: 'venue-1',
        periodId: 'period-free-1',
        now: new Date('2026-09-01T19:00:00.000Z'),
      },
      { host: host as never },
    )

    expect(result).toEqual({
      decision: 'ACTIVATED',
      periodId: 'period-free-1',
      sourceRevision: 2,
      eventId: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(tx.commercialSubscriptionPeriod.updateMany).toHaveBeenCalledWith({
      where: { id: 'period-free-1', status: 'OPEN', statusRevision: 1, amountDueMinor: 0n },
      data: { status: 'PAID', statusRevision: 2, paidAt: new Date('2026-09-01T19:00:00.000Z') },
    })
    expect(tx.commercialAccountReceivable.update).toHaveBeenCalledWith({
      where: { id: 'receivable-free-1' },
      data: { status: 'PAID' },
    })
    expect(tx.commercialEventOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceType: 'SUBSCRIPTION_PERIOD',
          sourceId: 'period-free-1',
          sourceRevision: 2,
          eventType: 'SUBSCRIPTION_NON_CASH_ACTIVATED',
          payload: expect.objectContaining({ activationBasis: 'ZERO_AMOUNT_ACCEPTED_OFFER', amountDueMinor: '0' }),
        }),
      }),
    )
    expect(tx.commercialCashReceipt.create).not.toHaveBeenCalled()
    expect(tx.commercialBillingAllocation.create).not.toHaveBeenCalled()
    expect(tx.commercialBillingPaymentAttempt.create).not.toHaveBeenCalled()
  })

  it('rejects a positive receivable instead of converting it into a free activation', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          periodId: 'period-paid-1',
          periodStatus: 'OPEN',
          periodStatusRevision: 1,
          amountDueMinor: 1n,
          contractId: 'contract-paid-1',
          contractStatus: 'PENDING_PAYMENT',
          acceptanceStatus: 'ACCEPTED',
          organizationId: 'org-1',
          venueId: 'venue-1',
          receivableId: 'receivable-paid-1',
          receivableStatus: 'OPEN',
          receivableAmountDueMinor: 1n,
          activeAllocatedMinor: 0n,
        },
      ]),
      commercialEventOutbox: { findFirst: jest.fn() },
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }

    await expect(
      activateCommercialZeroAmountPeriod(
        {
          organizationId: 'org-1',
          venueId: 'venue-1',
          periodId: 'period-paid-1',
          now: new Date('2026-09-01T19:00:00.000Z'),
        },
        { host: host as never },
      ),
    ).rejects.toThrow('COMMERCIAL_BILLING_NON_CASH_AMOUNT_NOT_ZERO')
  })
})
