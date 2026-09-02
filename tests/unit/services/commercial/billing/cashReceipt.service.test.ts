import {
  reconcileCommercialCashReceipt,
  resolveCommercialCashReceiptObservation,
} from '@/services/commercial/billing/cashReceipt.service'

const observation = {
  provider: 'STRIPE' as const,
  providerEventId: 'evt_reconciled_1',
  amountMinor: 28_884n,
  currency: 'MXN' as const,
  receivingAccountFingerprint: 'a'.repeat(64),
  observedAt: new Date('2026-09-01T15:00:00.000Z'),
}

describe('resolveCommercialCashReceiptObservation', () => {
  it('creates a provider-neutral receipt candidate for a first observation', () => {
    expect(resolveCommercialCashReceiptObservation({ observation, existingReceipt: null })).toEqual({
      decision: 'CREATE',
      receipt: observation,
    })
  })

  it('treats an identical provider event as an idempotent replay', () => {
    expect(
      resolveCommercialCashReceiptObservation({
        observation,
        existingReceipt: { id: 'receipt-1', ...observation },
      }),
    ).toEqual({ decision: 'REPLAY', receiptId: 'receipt-1' })
  })

  it('fails closed when a duplicated provider event changes money or destination', () => {
    expect(() =>
      resolveCommercialCashReceiptObservation({
        observation: { ...observation, amountMinor: 30_000n },
        existingReceipt: { id: 'receipt-1', ...observation },
      }),
    ).toThrow('COMMERCIAL_BILLING_PROVIDER_EVENT_CONFLICT')
  })

  it('rejects raw or malformed receiving-account identifiers', () => {
    expect(() =>
      resolveCommercialCashReceiptObservation({
        observation: { ...observation, receivingAccountFingerprint: '012345678901234567' },
        existingReceipt: null,
      }),
    ).toThrow('COMMERCIAL_BILLING_RECEIVING_ACCOUNT_FINGERPRINT_INVALID')
  })
})

describe('reconcileCommercialCashReceipt', () => {
  function transactionHarness(options: {
    amountDueMinor: bigint
    activeAllocatedMinor: bigint
    paymentAttempt?: {
      id: string
      receivableId: string
      provider: 'STRIPE'
      status: 'PENDING'
      amountMinor: bigint
      currency: 'MXN'
    }
  }) {
    const tx = {
      commercialCashReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'receipt-created' }),
      },
      commercialBillingAllocation: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'allocation-created' }),
      },
      commercialAccountReceivable: {
        update: jest.fn().mockResolvedValue({ id: 'ar-1' }),
      },
      commercialSubscriptionPeriod: {
        update: jest.fn().mockResolvedValue({ id: 'period-1', statusRevision: 2 }),
      },
      commercialBillingPaymentAttempt: {
        update: jest.fn().mockResolvedValue({ id: options.paymentAttempt?.id ?? 'attempt-unused' }),
      },
      commercialBillingProviderObject: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      commercialEventOutbox: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'outbox-1' }),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-1' }) },
      $queryRawUnsafe: jest.fn(),
    }
    tx.$queryRawUnsafe.mockResolvedValueOnce([
          {
            id: 'ar-1',
            organizationId: 'org-1',
            venueId: 'venue-1',
            subscriptionPeriodId: 'period-1',
            subjectType: 'SUBSCRIPTION_PERIOD',
            amountDueMinor: options.amountDueMinor,
            currency: 'MXN',
            status: 'OPEN',
          },
        ])
    if (options.paymentAttempt) tx.$queryRawUnsafe.mockResolvedValueOnce([options.paymentAttempt])
    tx.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 'period-1', status: 'OPEN', statusRevision: 1 }])
      .mockResolvedValueOnce([{ activeAllocatedMinor: options.activeAllocatedMinor }])
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }
    return { tx, host }
  }

  const input = {
    organizationId: 'org-1',
    venueId: 'venue-1',
    receivableId: 'ar-1',
    idempotencyKey: 'receipt-reconciliation-1',
    observation,
    now: new Date('2026-09-01T15:01:00.000Z'),
  } as const

  it('atomically creates receipt, allocation, PAID period and canonical outbox event', async () => {
    const { tx, host } = transactionHarness({ amountDueMinor: 28_884n, activeAllocatedMinor: 0n })

    const result = await reconcileCommercialCashReceipt(input, { host: host as never })

    expect(result).toMatchObject({
      decision: 'RECONCILED',
      receiptId: 'receipt-created',
      allocatedMinor: 28_884n,
      receivableStatus: 'PAID',
      periodStatus: 'PAID',
      eventId: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(host.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.commercialBillingAllocation.create).toHaveBeenCalledTimes(1)
    expect(tx.commercialSubscriptionPeriod.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'period-1' }, data: expect.objectContaining({ status: 'PAID' }) }),
    )
    expect(tx.commercialEventOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'SUBSCRIPTION_PAYMENT_RECONCILED',
          sourceId: 'period-1',
          sourceRevision: 2,
        }),
      }),
    )
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
  })

  it('persists partial cash but does not create a paid period or event', async () => {
    const { tx, host } = transactionHarness({ amountDueMinor: 28_884n, activeAllocatedMinor: 0n })

    const result = await reconcileCommercialCashReceipt(
      { ...input, observation: { ...observation, amountMinor: 10_000n } },
      { host: host as never },
    )

    expect(result).toMatchObject({
      decision: 'RECONCILED',
      allocatedMinor: 10_000n,
      receivableStatus: 'PARTIALLY_PAID',
      periodStatus: 'OPEN',
      eventId: null,
    })
    expect(tx.commercialSubscriptionPeriod.update).not.toHaveBeenCalled()
    expect(tx.commercialEventOutbox.create).not.toHaveBeenCalled()
  })

  it('links a persisted Stripe attempt and marks it succeeded in the cash transaction', async () => {
    const paymentAttempt = {
      id: 'attempt-stripe-1',
      receivableId: 'ar-1',
      provider: 'STRIPE' as const,
      status: 'PENDING' as const,
      amountMinor: 28_884n,
      currency: 'MXN' as const,
    }
    const { tx, host } = transactionHarness({
      amountDueMinor: 28_884n,
      activeAllocatedMinor: 0n,
      paymentAttempt,
    })

    await reconcileCommercialCashReceipt(
      { ...input, paymentAttemptId: paymentAttempt.id },
      { host: host as never },
    )

    expect(tx.commercialCashReceipt.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentAttemptId: paymentAttempt.id }) }),
    )
    expect(tx.commercialBillingPaymentAttempt.update).toHaveBeenCalledWith({
      where: { id: paymentAttempt.id },
      data: { status: 'SUCCEEDED', lastErrorCode: null },
    })
  })

  it('atomically records signed Stripe object aliases needed to find the original receipt later', async () => {
    const paymentAttempt = {
      id: 'attempt-stripe-alias-1',
      receivableId: 'ar-1',
      provider: 'STRIPE' as const,
      status: 'PENDING' as const,
      amountMinor: 28_884n,
      currency: 'MXN' as const,
    }
    const { tx, host } = transactionHarness({
      amountDueMinor: 28_884n,
      activeAllocatedMinor: 0n,
      paymentAttempt,
    })

    await reconcileCommercialCashReceipt(
      {
        ...input,
        paymentAttemptId: paymentAttempt.id,
        providerObjectReferences: [
          { objectType: 'INVOICE', objectId: 'in_1' },
          { objectType: 'PAYMENT_INTENT', objectId: 'pi_1' },
          { objectType: 'CHARGE', objectId: 'ch_1' },
        ],
      },
      { host: host as never },
    )

    expect(tx.commercialBillingProviderObject.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ provider: 'STRIPE', objectType: 'INVOICE', objectId: 'in_1' }),
        expect.objectContaining({ provider: 'STRIPE', objectType: 'PAYMENT_INTENT', objectId: 'pi_1' }),
        expect.objectContaining({ provider: 'STRIPE', objectType: 'CHARGE', objectId: 'ch_1' }),
      ]),
    })
  })
})
