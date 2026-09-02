import { reserveCommercialBillingPaymentAttempt } from '@/services/commercial/billing/paymentAttempt.service'

describe('reserveCommercialBillingPaymentAttempt', () => {
  it('derives the payable amount from the locked receivable instead of caller money', async () => {
    const tx = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'ar-attempt-1',
            organizationId: 'org-1',
            venueId: 'venue-1',
            amountDueMinor: 28_884n,
            currency: 'MXN',
            status: 'PARTIALLY_PAID',
          },
        ])
        .mockResolvedValueOnce([{ activeAllocatedMinor: 10_000n }]),
      commercialBillingPaymentAttempt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'attempt-created-1',
          status: 'PENDING',
          amountMinor: 18_884n,
        }),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-attempt-1' }) },
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }

    const result = await reserveCommercialBillingPaymentAttempt(
      {
        organizationId: 'org-1',
        venueId: 'venue-1',
        receivableId: 'ar-attempt-1',
        provider: 'STRIPE',
        idempotencyKey: 'attempt-reserve-key-1',
        requestFingerprint: 'a'.repeat(64),
      },
      { host: host as never },
    )

    expect(result).toEqual({
      decision: 'CREATED',
      paymentAttemptId: 'attempt-created-1',
      status: 'PENDING',
      amountMinor: 18_884n,
      currency: 'MXN',
    })
    expect(tx.commercialBillingPaymentAttempt.create).toHaveBeenCalledWith({
      data: {
        receivableId: 'ar-attempt-1',
        provider: 'STRIPE',
        idempotencyKey: 'attempt-reserve-key-1',
        status: 'PENDING',
        amountMinor: 18_884n,
        currency: 'MXN',
        requestFingerprint: 'a'.repeat(64),
      },
      select: { id: true, status: true, amountMinor: true },
    })
  })
})
