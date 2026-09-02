import {
  createCommercialSubscriptionLifecycleService,
  type CommercialLifecycleEvent,
} from '@/services/commercial/commercialSubscriptionLifecycle.service'

function event(overrides: Partial<CommercialLifecycleEvent> = {}): CommercialLifecycleEvent {
  return {
    stripeEventId: 'evt_100',
    type: 'CHECKOUT_COMPLETED',
    effectiveAt: new Date('2026-08-22T12:00:00.000Z'),
    acceptanceId: 'acceptance-1',
    stripeCheckoutSessionId: 'cs_1',
    stripeSubscriptionId: 'sub_1',
    ...overrides,
  }
}

function harness(initialStatus = 'STRIPE_PENDING') {
  let acceptance: any = {
    id: 'acceptance-1',
    organizationId: 'org-1',
    venueId: 'venue-1',
    status: initialStatus,
    revision: 2,
    lastStripeEventId: null,
    lastStripeEventCreatedAt: null,
    quoteSchemaVersion: 2,
    offerVersionId: null,
  }
  const events = new Map<string, any>()
  const tx = {
    findEvent: jest.fn(async (stripeEventId: string) => events.get(stripeEventId) ?? null),
    lockAcceptance: jest.fn(async (reference: any) => {
      if (reference.acceptanceId && reference.acceptanceId !== acceptance.id) return null
      return acceptance
    }),
    createEvent: jest.fn(async (input: any) => {
      events.set(input.stripeEventId, input)
      return input
    }),
    updateAcceptance: jest.fn(async (input: any) => {
      acceptance = {
        ...acceptance,
        status: input.status,
        revision: acceptance.revision + 1,
        lastStripeEventId: input.lastStripeEventId,
        lastStripeEventCreatedAt: input.lastStripeEventCreatedAt,
      }
      return acceptance
    }),
    bindStripeReferences: jest.fn(async () => undefined),
    writeAudit: jest.fn(async () => undefined),
  }
  const repository = {
    runInTransaction: jest.fn(async (operation: any) => operation(tx)),
  }
  const service = createCommercialSubscriptionLifecycleService({ repository })
  return { service, repository, tx, getAcceptance: () => acceptance }
}

describe('commercial subscription lifecycle', () => {
  it('activates exactly the accepted quote and binds Stripe references atomically', async () => {
    const { service, tx, getAcceptance } = harness()

    await expect(service.reconcile(event())).resolves.toMatchObject({ matched: true, applied: true, status: 'ACTIVE' })
    expect(getAcceptance().status).toBe('ACTIVE')
    expect(tx.bindStripeReferences).toHaveBeenCalledWith({
      acceptanceId: 'acceptance-1',
      stripeCheckoutSessionId: 'cs_1',
      stripeSubscriptionId: 'sub_1',
    })
    expect(tx.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COMMERCIAL_SUBSCRIPTION_ACTIVE',
        organizationId: 'org-1',
        venueId: 'venue-1',
      }),
    )
  })

  it('makes duplicate Stripe delivery idempotent', async () => {
    const { service, tx } = harness()
    await service.reconcile(event())

    await expect(service.reconcile(event())).resolves.toEqual({
      matched: true,
      applied: false,
      duplicate: true,
      status: 'ACTIVE',
    })
    expect(tx.updateAcceptance).toHaveBeenCalledTimes(1)
  })

  it('records but ignores an older out-of-order event', async () => {
    const { service, tx, getAcceptance } = harness('ACTIVE')
    await service.reconcile(event({ stripeEventId: 'evt_200', effectiveAt: new Date('2026-08-22T13:00:00.000Z') }))

    await expect(
      service.reconcile(
        event({
          stripeEventId: 'evt_150',
          type: 'INVOICE_FAILED',
          effectiveAt: new Date('2026-08-22T12:30:00.000Z'),
        }),
      ),
    ).resolves.toMatchObject({ matched: true, applied: false, stale: true, status: 'ACTIVE' })
    expect(getAcceptance().status).toBe('ACTIVE')
    expect(tx.createEvent).toHaveBeenLastCalledWith(expect.objectContaining({ applied: false, fromStatus: 'ACTIVE', toStatus: 'ACTIVE' }))
  })

  it.each([
    ['SUBSCRIPTION_CANCELED', 'CANCELED'],
    ['REFUND_SUCCEEDED', 'REFUNDED'],
    ['INVOICE_FAILED', 'FAILED'],
  ] as const)('lets risk-reducing %s win when Stripe timestamps tie to the same second', async (type, status) => {
    const { service, getAcceptance } = harness('ACTIVE')
    await service.reconcile(event({ stripeEventId: 'evt_zzz_paid' }))

    await expect(service.reconcile(event({ stripeEventId: 'evt_aaa_risk', type }))).resolves.toMatchObject({
      applied: true,
      status,
    })
    expect(getAcceptance().status).toBe(status)
  })

  it.each([
    ['INVOICE_FAILED', 'ACTIVE', 'FAILED'],
    ['INVOICE_PAID', 'FAILED', 'ACTIVE'],
    ['SUBSCRIPTION_CANCELED', 'ACTIVE', 'CANCELED'],
    ['REFUND_SUCCEEDED', 'ACTIVE', 'REFUNDED'],
    ['PARTIAL_REFUND', 'ACTIVE', 'ACTIVE'],
    ['DISPUTE_OPENED', 'ACTIVE', 'DISPUTED'],
    ['DISPUTE_WON', 'DISPUTED', 'ACTIVE'],
    ['DISPUTE_LOST', 'DISPUTED', 'DISPUTED'],
  ] as const)('applies %s: %s → %s', async (type, from, to) => {
    const { service, getAcceptance } = harness(from)
    await service.reconcile(event({ type }))
    expect(getAcceptance().status).toBe(to)
  })

  it('does not silently revive canceled or refunded subscriptions', async () => {
    for (const status of ['CANCELED', 'REFUNDED'] as const) {
      const { service, getAcceptance } = harness(status)
      await expect(service.reconcile(event({ type: 'INVOICE_PAID' }))).resolves.toMatchObject({
        applied: false,
        status,
      })
      expect(getAcceptance().status).toBe(status)
    }
  })

  it('records a full refund after cancellation as REFUNDED financial state', async () => {
    const { service, getAcceptance } = harness('CANCELED')

    await expect(service.reconcile(event({ type: 'REFUND_SUCCEEDED' }))).resolves.toMatchObject({
      applied: true,
      status: 'REFUNDED',
    })
    expect(getAcceptance().status).toBe('REFUNDED')
  })

  it('does not let a dispute win revive an independently failed renewal', async () => {
    const { service, getAcceptance } = harness('FAILED')

    await expect(service.reconcile(event({ type: 'DISPUTE_WON' }))).resolves.toMatchObject({
      applied: false,
      status: 'FAILED',
    })
    expect(getAcceptance().status).toBe('FAILED')
  })

  it.each([
    ['SUBSCRIPTION_CANCELED', 'CANCELED'],
    ['INVOICE_FAILED', 'FAILED'],
  ] as const)('lets %s supersede a dispute so a later win cannot restore access', async (terminalEvent, terminalStatus) => {
    const { service, getAcceptance } = harness('DISPUTED')

    await expect(
      service.reconcile(
        event({
          stripeEventId: `evt_${terminalStatus.toLowerCase()}`,
          type: terminalEvent,
          effectiveAt: new Date('2026-08-22T12:01:00.000Z'),
        }),
      ),
    ).resolves.toMatchObject({ applied: true, status: terminalStatus })
    await expect(
      service.reconcile(
        event({
          stripeEventId: `evt_dispute_won_after_${terminalStatus.toLowerCase()}`,
          type: 'DISPUTE_WON',
          effectiveAt: new Date('2026-08-22T12:02:00.000Z'),
        }),
      ),
    ).resolves.toMatchObject({ applied: false, status: terminalStatus })
    expect(getAcceptance().status).toBe(terminalStatus)
  })

  it('lets an independently failed renewal supersede a dispute in the same Stripe second', async () => {
    const { service, getAcceptance } = harness('DISPUTED')
    const tiedAt = new Date('2026-08-22T12:00:00.000Z')

    await service.reconcile(event({ stripeEventId: 'evt_dispute_lost_tie', type: 'DISPUTE_LOST', effectiveAt: tiedAt }))
    await expect(
      service.reconcile(event({ stripeEventId: 'evt_invoice_failed_tie', type: 'INVOICE_FAILED', effectiveAt: tiedAt })),
    ).resolves.toMatchObject({ applied: true, status: 'FAILED' })
    await expect(
      service.reconcile(
        event({
          stripeEventId: 'evt_dispute_won_after_invoice_failed_tie',
          type: 'DISPUTE_WON',
          effectiveAt: new Date('2026-08-22T12:01:00.000Z'),
        }),
      ),
    ).resolves.toMatchObject({ applied: false, status: 'FAILED' })
    expect(getAcceptance().status).toBe('FAILED')
  })

  it('does not replace an independently failed renewal with a later dispute lifecycle', async () => {
    const { service, getAcceptance } = harness('FAILED')

    await expect(
      service.reconcile(
        event({
          stripeEventId: 'evt_dispute_opened_after_failed',
          type: 'DISPUTE_OPENED',
          effectiveAt: new Date('2026-08-22T12:01:00.000Z'),
        }),
      ),
    ).resolves.toMatchObject({ applied: false, status: 'FAILED' })
    await expect(
      service.reconcile(
        event({
          stripeEventId: 'evt_dispute_won_after_failed',
          type: 'DISPUTE_WON',
          effectiveAt: new Date('2026-08-22T12:02:00.000Z'),
        }),
      ),
    ).resolves.toMatchObject({ applied: false, status: 'FAILED' })
    expect(getAcceptance().status).toBe('FAILED')
  })

  it('ignores unrelated Stripe events without writing domain state', async () => {
    const { service, tx } = harness()
    tx.lockAcceptance.mockResolvedValueOnce(null)

    await expect(service.reconcile(event({ acceptanceId: 'other' }))).resolves.toEqual({ matched: false, applied: false })
    expect(tx.createEvent).not.toHaveBeenCalled()
    expect(tx.updateAcceptance).not.toHaveBeenCalled()
  })

  it('ignores Quote v3 lineage without projecting lifecycle state or binding Stripe references', async () => {
    const unsupported = harness()
    unsupported.tx.lockAcceptance.mockResolvedValueOnce({
      ...unsupported.getAcceptance(),
      quoteSchemaVersion: 3,
      offerVersionId: 'offer-v3-1',
    })

    await expect(unsupported.service.reconcile(event())).resolves.toEqual({ matched: false, applied: false })
    expect(unsupported.tx.createEvent).not.toHaveBeenCalled()
    expect(unsupported.tx.bindStripeReferences).not.toHaveBeenCalled()
    expect(unsupported.tx.updateAcceptance).not.toHaveBeenCalled()
    expect(unsupported.tx.writeAudit).not.toHaveBeenCalled()
  })
})
