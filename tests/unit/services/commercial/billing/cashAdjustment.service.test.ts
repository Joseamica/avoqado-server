import { buildCommercialCashAdjustmentPlan, reconcileCommercialCashAdjustment } from '@/services/commercial/billing/cashAdjustment.service'

describe('buildCommercialCashAdjustmentPlan', () => {
  it('removes only the partial refund from active paid coverage', () => {
    expect(
      buildCommercialCashAdjustmentPlan({
        originalPaymentAmountMinor: 28_884n,
        previouslyAdjustedMinor: 0n,
        originalAllocatedMinor: 28_884n,
        previouslyDebitedMinor: 0n,
        activeReceivableAllocatedMinor: 28_884n,
        adjustmentAmountMinor: 10_000n,
      }),
    ).toEqual({
      debitMinor: 10_000n,
      nextActiveReceivableAllocatedMinor: 18_884n,
      remainingAdjustablePaymentMinor: 18_884n,
      remainingOriginalCoverageMinor: 18_884n,
    })
  })

  it('refunds unallocated overpayment without inventing negative receivable coverage', () => {
    expect(
      buildCommercialCashAdjustmentPlan({
        originalPaymentAmountMinor: 30_000n,
        previouslyAdjustedMinor: 0n,
        originalAllocatedMinor: 28_884n,
        previouslyDebitedMinor: 0n,
        activeReceivableAllocatedMinor: 28_884n,
        adjustmentAmountMinor: 30_000n,
      }),
    ).toEqual({
      debitMinor: 28_884n,
      nextActiveReceivableAllocatedMinor: 0n,
      remainingAdjustablePaymentMinor: 0n,
      remainingOriginalCoverageMinor: 0n,
    })
  })

  it('consumes the unallocated part of an overpayment before removing paid coverage', () => {
    expect(
      buildCommercialCashAdjustmentPlan({
        originalPaymentAmountMinor: 30_000n,
        previouslyAdjustedMinor: 0n,
        originalAllocatedMinor: 28_884n,
        previouslyDebitedMinor: 0n,
        activeReceivableAllocatedMinor: 28_884n,
        adjustmentAmountMinor: 1_116n,
      }),
    ).toEqual({
      debitMinor: 0n,
      nextActiveReceivableAllocatedMinor: 28_884n,
      remainingAdjustablePaymentMinor: 28_884n,
      remainingOriginalCoverageMinor: 28_884n,
    })
  })

  it('rejects cumulative refunds or reversals above the original payment', () => {
    expect(() =>
      buildCommercialCashAdjustmentPlan({
        originalPaymentAmountMinor: 28_884n,
        previouslyAdjustedMinor: 20_000n,
        originalAllocatedMinor: 28_884n,
        previouslyDebitedMinor: 20_000n,
        activeReceivableAllocatedMinor: 8_884n,
        adjustmentAmountMinor: 10_000n,
      }),
    ).toThrow('COMMERCIAL_BILLING_ADJUSTMENT_EXCEEDS_PAYMENT')
  })

  it('never debits more than the coverage still attributable to the original payment', () => {
    expect(
      buildCommercialCashAdjustmentPlan({
        originalPaymentAmountMinor: 30_000n,
        previouslyAdjustedMinor: 15_000n,
        originalAllocatedMinor: 20_000n,
        previouslyDebitedMinor: 5_000n,
        activeReceivableAllocatedMinor: 12_000n,
        adjustmentAmountMinor: 10_000n,
      }),
    ).toEqual({
      debitMinor: 10_000n,
      nextActiveReceivableAllocatedMinor: 2_000n,
      remainingAdjustablePaymentMinor: 5_000n,
      remainingOriginalCoverageMinor: 5_000n,
    })
  })
})

describe('reconcileCommercialCashAdjustment', () => {
  it('writes one compensating receipt, DEBIT and coverage-reversed event atomically', async () => {
    const tx = {
      commercialCashReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'refund-receipt-1' }),
      },
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([
          {
            originalReceiptId: 'payment-receipt-1',
            organizationId: 'org-1',
            venueId: 'venue-1',
            provider: 'STRIPE',
            entryType: 'PAYMENT',
            originalPaymentAmountMinor: 28_884n,
            currency: 'MXN',
            receivableId: 'ar-1',
            originalAllocatedMinor: 28_884n,
            amountDueMinor: 28_884n,
            periodId: 'period-1',
            periodStatus: 'PAID',
            periodStatusRevision: 2,
            dueAt: new Date('2026-09-05T05:59:59.999Z'),
            graceEndsAt: new Date('2026-09-10T05:59:59.999Z'),
          },
        ])
        .mockResolvedValueOnce([
          {
            previouslyAdjustedMinor: 0n,
            previouslyDebitedMinor: 0n,
            activeReceivableAllocatedMinor: 28_884n,
          },
        ]),
      commercialBillingAllocation: { create: jest.fn().mockResolvedValue({ id: 'debit-1' }) },
      commercialAccountReceivable: {
        update: jest.fn().mockResolvedValue({ id: 'ar-1', status: 'PARTIALLY_PAID' }),
      },
      commercialSubscriptionPeriod: {
        update: jest.fn().mockResolvedValue({ id: 'period-1', statusRevision: 3 }),
      },
      commercialEventOutbox: { create: jest.fn().mockResolvedValue({ id: 'outbox-reversal-1' }) },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-refund-1' }) },
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }

    await expect(
      reconcileCommercialCashAdjustment(
        {
          organizationId: 'org-1',
          venueId: 'venue-1',
          originalReceiptId: 'payment-receipt-1',
          idempotencyKey: 'refund-key-1',
          observation: {
            provider: 'STRIPE',
            providerEventId: 'evt-refund-1',
            entryType: 'REFUND',
            amountMinor: 10_000n,
            currency: 'MXN',
            receivingAccountFingerprint: 'a'.repeat(64),
            observedAt: new Date('2026-09-07T12:00:00.000Z'),
          },
          now: new Date('2026-09-07T12:00:01.000Z'),
        },
        { host: host as never },
      ),
    ).resolves.toMatchObject({
      decision: 'ADJUSTED',
      adjustmentReceiptId: 'refund-receipt-1',
      debitMinor: 10_000n,
      receivableStatus: 'PARTIALLY_PAID',
      periodStatus: 'PAST_DUE',
      eventId: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(tx.commercialCashReceipt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryType: 'REFUND',
          relatedReceiptId: 'payment-receipt-1',
          amountMinor: 10_000n,
        }),
      }),
    )
    expect(tx.commercialBillingAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ direction: 'DEBIT', amountMinor: 10_000n }),
      }),
    )
    expect(tx.commercialEventOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceRevision: 3,
          eventType: 'SUBSCRIPTION_PAYMENT_COVERAGE_REVERSED',
        }),
      }),
    )
  })
})
