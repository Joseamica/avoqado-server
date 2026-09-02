import {
  createPrismaStripePaymentProviderRepository,
  createStripePaymentProviderAdapter,
} from '@/services/commercial/billing/stripePaymentProvider.adapter'

function invoiceEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_commercial_invoice_paid_1',
    type: 'invoice.paid',
    created: 1788271260,
    data: {
      object: {
        id: 'in_commercial_1',
        amount_paid: 20_880,
        currency: 'mxn',
        metadata: {
          type: 'commercial_billing_v1',
          paymentAttemptId: 'attempt-stripe-1',
          totalMinor: '1',
        },
        payments: {
          data: [
            {
              status: 'paid',
              payment: { payment_intent: 'pi_commercial_1', charge: 'ch_commercial_1' },
            },
          ],
        },
      },
    },
    ...overrides,
  } as never
}

describe('createStripePaymentProviderAdapter', () => {
  it('turns signed Stripe invoice money into the same neutral cash path without trusting metadata amounts', async () => {
    const repository = {
      loadAttempt: jest.fn().mockResolvedValue({
        id: 'attempt-stripe-1',
        provider: 'STRIPE',
        providerAttemptId: null,
        status: 'PENDING',
        amountMinor: 20_880n,
        currency: 'MXN',
        receivableId: 'ar-stripe-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
      }),
    }
    const reconcileCash = jest.fn().mockResolvedValue({
      decision: 'RECONCILED',
      receiptId: 'receipt-stripe-1',
      allocatedMinor: 20_880n,
      receivableStatus: 'PAID',
      periodStatus: 'PAID',
      eventId: 'event-period-paid-1',
    })
    const adapter = createStripePaymentProviderAdapter({
      repository,
      reconcileCash,
      reconcileAdjustment: jest.fn(),
      receivingAccountFingerprint: 'b'.repeat(64),
      now: () => new Date('2026-09-01T12:41:01.000Z'),
    })

    const result = await adapter.reconcile(invoiceEvent())

    expect(result).toMatchObject({ matched: true, applied: true, receiptId: 'receipt-stripe-1' })
    expect(reconcileCash).toHaveBeenCalledWith({
      organizationId: 'org-1',
      venueId: 'venue-1',
      receivableId: 'ar-stripe-1',
      paymentAttemptId: 'attempt-stripe-1',
      paymentAttemptProviderId: 'in_commercial_1',
      idempotencyKey: 'stripe:event:evt_commercial_invoice_paid_1',
      observation: {
        provider: 'STRIPE',
        providerEventId: 'evt_commercial_invoice_paid_1',
        amountMinor: 20_880n,
        currency: 'MXN',
        receivingAccountFingerprint: 'b'.repeat(64),
        observedAt: new Date(1788271260 * 1000),
      },
      providerObjectReferences: [
        { objectType: 'INVOICE', objectId: 'in_commercial_1' },
        { objectType: 'PAYMENT_INTENT', objectId: 'pi_commercial_1' },
        { objectType: 'CHARGE', objectId: 'ch_commercial_1' },
      ],
      now: new Date('2026-09-01T12:41:01.000Z'),
    })
  })

  it('ignores unrelated invoices before any billing lookup', async () => {
    const repository = { loadAttempt: jest.fn() }
    const reconcileCash = jest.fn()
    const adapter = createStripePaymentProviderAdapter({
      repository,
      reconcileCash,
      reconcileAdjustment: jest.fn(),
      receivingAccountFingerprint: 'b'.repeat(64),
      now: () => new Date(),
    })
    const unrelated = invoiceEvent()
    ;(unrelated as any).data.object.metadata = { type: 'another_product' }

    await expect(adapter.reconcile(unrelated)).resolves.toEqual({ matched: false, applied: false })
    expect(repository.loadAttempt).not.toHaveBeenCalled()
    expect(reconcileCash).not.toHaveBeenCalled()
  })

  it('does not reuse subscription metadata as a payment-attempt pointer for a renewal invoice', async () => {
    const repository = { loadAttempt: jest.fn() }
    const reconcileCash = jest.fn()
    const adapter = createStripePaymentProviderAdapter({
      repository,
      reconcileCash,
      reconcileAdjustment: jest.fn(),
      receivingAccountFingerprint: 'b'.repeat(64),
      now: () => new Date(),
    })
    const renewal = invoiceEvent()
    ;(renewal as any).data.object.metadata = {}
    ;(renewal as any).data.object.parent = {
      subscription_details: {
        metadata: { type: 'commercial_billing_v1', paymentAttemptId: 'stale-attempt-1' },
      },
    }

    await expect(adapter.reconcile(renewal)).resolves.toEqual({ matched: false, applied: false })
    expect(repository.loadAttempt).not.toHaveBeenCalled()
    expect(reconcileCash).not.toHaveBeenCalled()
  })

  it('treats the second signed delivery of the same succeeded invoice as an idempotent no-op', async () => {
    const repository = {
      loadAttempt: jest.fn().mockResolvedValue({
        id: 'attempt-stripe-1',
        provider: 'STRIPE',
        providerAttemptId: 'in_commercial_1',
        status: 'SUCCEEDED',
        amountMinor: 20_880n,
        currency: 'MXN',
        receivableId: 'ar-stripe-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
      }),
    }
    const reconcileCash = jest.fn()
    const adapter = createStripePaymentProviderAdapter({
      repository,
      reconcileCash,
      reconcileAdjustment: jest.fn(),
      receivingAccountFingerprint: 'b'.repeat(64),
      now: () => new Date(),
    })

    await expect(adapter.reconcile(invoiceEvent())).resolves.toEqual({ matched: true, applied: false })
    expect(reconcileCash).not.toHaveBeenCalled()
  })

  it('fails closed when a paid invoice has no payment-intent or charge alias for later adjustments', async () => {
    const repository = {
      loadAttempt: jest.fn().mockResolvedValue({
        id: 'attempt-stripe-1',
        provider: 'STRIPE',
        providerAttemptId: null,
        status: 'PENDING',
        amountMinor: 20_880n,
        currency: 'MXN',
        receivableId: 'ar-stripe-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
      }),
    }
    const reconcileCash = jest.fn()
    const adapter = createStripePaymentProviderAdapter({
      repository,
      reconcileCash,
      reconcileAdjustment: jest.fn(),
      receivingAccountFingerprint: 'b'.repeat(64),
      now: () => new Date(),
    })
    const invoiceWithoutSettlementAliases = invoiceEvent()
    delete (invoiceWithoutSettlementAliases as any).data.object.payments

    await expect(adapter.reconcile(invoiceWithoutSettlementAliases)).rejects.toThrow(
      'COMMERCIAL_STRIPE_INVOICE_SETTLEMENT_REFERENCE_REQUIRED',
    )
    expect(reconcileCash).not.toHaveBeenCalled()
  })

  it('maps a succeeded Stripe refund to the neutral adjustment path using the original receipt authority', async () => {
    const repository = {
      loadAttempt: jest.fn(),
      loadOriginalReceiptByReferences: jest.fn().mockResolvedValue({
        receiptId: 'receipt-stripe-1',
        receivableId: 'ar-stripe-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
        receivingAccountFingerprint: 'b'.repeat(64),
        reversedMinor: 20_880n,
      }),
    }
    const reconcileCash = jest.fn()
    const reconcileAdjustment = jest.fn().mockResolvedValue({
      decision: 'ADJUSTED',
      adjustmentReceiptId: 'refund-receipt-1',
      debitMinor: 10_000n,
      receivableStatus: 'PARTIALLY_PAID',
      periodStatus: 'PAST_DUE',
      eventId: 'event-coverage-reversed-1',
    })
    const adapter = createStripePaymentProviderAdapter({
      repository,
      reconcileCash,
      reconcileAdjustment,
      receivingAccountFingerprint: 'b'.repeat(64),
      now: () => new Date('2026-09-01T13:00:00.000Z'),
    })
    const refundEvent = {
      id: 'evt_refund_succeeded_1',
      type: 'refund.updated',
      created: 1788272000,
      data: {
        object: {
          id: 're_1',
          amount: 10_000,
          currency: 'mxn',
          status: 'succeeded',
          charge: 'ch_1',
          payment_intent: 'pi_1',
        },
      },
    } as never

    await expect(adapter.reconcile(refundEvent)).resolves.toEqual({
      matched: true,
      applied: true,
      receiptId: 'refund-receipt-1',
      eventId: 'event-coverage-reversed-1',
    })
    expect(repository.loadOriginalReceiptByReferences).toHaveBeenCalledWith(['ch_1', 'pi_1'])
    expect(reconcileAdjustment).toHaveBeenCalledWith({
      organizationId: 'org-1',
      venueId: 'venue-1',
      originalReceiptId: 'receipt-stripe-1',
      idempotencyKey: 'stripe:refund:re_1',
      observation: {
        provider: 'STRIPE',
        providerEventId: 're_1',
        entryType: 'REFUND',
        amountMinor: 10_000n,
        currency: 'MXN',
        receivingAccountFingerprint: 'b'.repeat(64),
        observedAt: new Date(1788272000 * 1000),
      },
      now: new Date('2026-09-01T13:00:00.000Z'),
    })
    expect(reconcileCash).not.toHaveBeenCalled()
  })

  it('maps Stripe dispute funds withdrawal to a reversible neutral cash reversal', async () => {
    const repository = {
      loadAttempt: jest.fn(),
      loadOriginalReceiptByReferences: jest.fn().mockResolvedValue({
        receiptId: 'receipt-stripe-1',
        receivableId: 'ar-stripe-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
        receivingAccountFingerprint: 'b'.repeat(64),
        reversedMinor: 20_880n,
      }),
    }
    const reconcileAdjustment = jest.fn().mockResolvedValue({
      decision: 'ADJUSTED',
      adjustmentReceiptId: 'reversal-receipt-1',
      debitMinor: 20_880n,
      receivableStatus: 'PAST_DUE',
      periodStatus: 'PAST_DUE',
      eventId: 'event-dispute-reversed-1',
    })
    const adapter = createStripePaymentProviderAdapter({
      repository,
      reconcileCash: jest.fn(),
      reconcileAdjustment,
      receivingAccountFingerprint: 'b'.repeat(64),
      now: () => new Date('2026-09-01T13:05:00.000Z'),
    })
    const disputeEvent = {
      id: 'evt_dispute_withdrawn_1',
      type: 'charge.dispute.funds_withdrawn',
      created: 1788272300,
      data: {
        object: {
          id: 'dp_1',
          amount: 20_880,
          currency: 'mxn',
          charge: 'ch_1',
          payment_intent: 'pi_1',
        },
      },
    } as never

    await adapter.reconcile(disputeEvent)

    expect(reconcileAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({
        originalReceiptId: 'receipt-stripe-1',
        idempotencyKey: 'stripe:dispute:dp_1',
        observation: expect.objectContaining({
          providerEventId: 'dp_1',
          entryType: 'REVERSAL',
          amountMinor: 20_880n,
        }),
      }),
    )
  })

  it('restores neutral cash coverage when Stripe reinstates funds for a won dispute', async () => {
    const repository = {
      loadAttempt: jest.fn(),
      loadOriginalReceiptByReferences: jest.fn().mockResolvedValue({
        receiptId: 'receipt-stripe-1',
        receivableId: 'ar-stripe-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
        receivingAccountFingerprint: 'b'.repeat(64),
        reversedMinor: 20_880n,
      }),
    }
    const reconcileCash = jest.fn().mockResolvedValue({
      decision: 'RECONCILED',
      receiptId: 'reinstated-receipt-1',
      allocatedMinor: 20_880n,
      receivableStatus: 'PAID',
      periodStatus: 'PAID',
      eventId: 'event-dispute-reinstated-1',
    })
    const adapter = createStripePaymentProviderAdapter({
      repository,
      reconcileCash,
      reconcileAdjustment: jest.fn(),
      receivingAccountFingerprint: 'b'.repeat(64),
      now: () => new Date('2026-09-01T13:10:00.000Z'),
    })
    const reinstatedEvent = {
      id: 'evt_dispute_reinstated_1',
      type: 'charge.dispute.funds_reinstated',
      created: 1788272600,
      data: {
        object: {
          id: 'dp_1',
          amount: 20_880,
          currency: 'mxn',
          charge: 'ch_1',
          payment_intent: 'pi_1',
        },
      },
    } as never

    await expect(adapter.reconcile(reinstatedEvent)).resolves.toEqual({
      matched: true,
      applied: true,
      receiptId: 'reinstated-receipt-1',
      eventId: 'event-dispute-reinstated-1',
    })
    expect(reconcileCash).toHaveBeenCalledWith({
      organizationId: 'org-1',
      venueId: 'venue-1',
      receivableId: 'ar-stripe-1',
      idempotencyKey: 'stripe:dispute-reinstated:dp_1',
      observation: {
        provider: 'STRIPE',
        providerEventId: 'dispute-reinstated:dp_1',
        amountMinor: 20_880n,
        currency: 'MXN',
        receivingAccountFingerprint: 'b'.repeat(64),
        observedAt: new Date(1788272600 * 1000),
      },
      now: new Date('2026-09-01T13:10:00.000Z'),
    })
  })

  it('does not create reinstated cash beyond the dispute coverage previously reversed', async () => {
    const repository = {
      loadAttempt: jest.fn(),
      loadOriginalReceiptByReferences: jest.fn().mockResolvedValue({
        receiptId: 'receipt-stripe-1',
        receivableId: 'ar-stripe-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
        receivingAccountFingerprint: 'b'.repeat(64),
        reversedMinor: 10_000n,
      }),
    }
    const reconcileCash = jest.fn()
    const adapter = createStripePaymentProviderAdapter({
      repository,
      reconcileCash,
      reconcileAdjustment: jest.fn(),
      receivingAccountFingerprint: 'b'.repeat(64),
      now: () => new Date('2026-09-01T13:10:00.000Z'),
    })
    const reinstatedEvent = {
      id: 'evt_dispute_reinstated_over_1',
      type: 'charge.dispute.funds_reinstated',
      created: 1788272600,
      data: {
        object: {
          id: 'dp_over_1',
          amount: 20_880,
          currency: 'mxn',
          charge: 'ch_1',
          payment_intent: 'pi_1',
        },
      },
    } as never

    await expect(adapter.reconcile(reinstatedEvent)).rejects.toThrow('COMMERCIAL_STRIPE_REINSTATED_AMOUNT_EXCEEDS_REVERSAL')
    expect(reconcileCash).not.toHaveBeenCalled()
  })
})

describe('createPrismaStripePaymentProviderRepository', () => {
  it('resolves an unallocated receipt through its payment attempt and reports reversed coverage', async () => {
    const client = {
      commercialBillingPaymentAttempt: { findUnique: jest.fn() },
      commercialBillingProviderObject: {
        findMany: jest.fn().mockResolvedValue([
          {
            cashReceipt: {
              id: 'receipt-unallocated-1',
              organizationId: 'org-1',
              venueId: 'venue-1',
              receivingAccountFingerprint: 'b'.repeat(64),
              paymentAttempt: { receivableId: 'ar-stripe-1' },
              allocations: [],
              adjustments: [{ amountMinor: 10_000n }, { amountMinor: 5_000n }],
            },
          },
        ]),
      },
    }
    const repository = createPrismaStripePaymentProviderRepository(client as never)

    await expect(repository.loadOriginalReceiptByReferences(['ch_1'])).resolves.toEqual({
      receiptId: 'receipt-unallocated-1',
      receivableId: 'ar-stripe-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
      receivingAccountFingerprint: 'b'.repeat(64),
      reversedMinor: 15_000n,
    })
  })
})
