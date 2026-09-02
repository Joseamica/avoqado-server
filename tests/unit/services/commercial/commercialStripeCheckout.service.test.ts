import { createCommercialStripeCheckoutService } from '@/services/commercial/commercialStripeCheckout.service'
import type { CommercialStripeGateway } from '@/services/commercial/commercialStripeCheckout.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import AppError from '@/errors/AppError'

const frozenQuote = {
  schemaVersion: 1,
  quoteId: 'quote-1',
  totalMinor: 5800,
  renewalTotalMinor: 28884,
}
const acceptance = {
  id: 'acceptance-1',
  quoteId: 'quote-1',
  organizationId: 'org-1',
  venueId: 'venue-1',
  status: 'ACCEPTED',
  revision: 1,
  quote: { schemaVersion: 2, offerVersionId: null as string | null, snapshot: frozenQuote, checksum: 'a'.repeat(64) },
}
const requestFingerprint = hashCanonicalJsonV1('commercial-stripe-checkout-v1', {
  acceptanceId: 'acceptance-1',
  quoteId: 'quote-1',
  quoteChecksum: 'a'.repeat(64),
})

function harness(assertCheckoutAllowed: () => void = jest.fn()) {
  let operation: any = null
  const repository = {
    loadAcceptance: jest.fn(async () => acceptance),
    reserveOperation: jest.fn(async input => {
      if (!operation) operation = { ...input, status: 'PENDING' }
      return operation
    }),
    markSucceeded: jest.fn(async (_id, result) => {
      operation = { ...operation, ...result, status: 'SUCCEEDED' }
      return operation
    }),
    markOutcomeUnknown: jest.fn(async (_id, message) => {
      operation = { ...operation, status: 'OUTCOME_UNKNOWN', lastError: message }
    }),
    markFailed: jest.fn(async (_id, message) => {
      operation = { ...operation, status: 'FAILED', lastError: message }
    }),
  }
  const gateway = {
    createCheckoutSession: jest.fn(async (_input: Parameters<CommercialStripeGateway['createCheckoutSession']>[0]) => ({
      checkoutSessionId: 'cs_test_1',
      checkoutUrl: 'https://checkout.stripe.test/cs_test_1',
    })),
  }
  const dependencies = {
    repository,
    gateway,
    randomId: () => 'stripe-operation-1',
    assertCheckoutAllowed,
  }
  const service = createCommercialStripeCheckoutService(dependencies)
  return { service, repository, gateway, assertCheckoutAllowed, getOperation: () => operation }
}

describe('commercial Stripe checkout boundary', () => {
  it('fails closed before reading checkout state or calling Stripe when rollout policy denies access', async () => {
    const disabled = new AppError('El checkout comercial v2 no está habilitado.', 503, true, 'COMMERCIAL_V2_CHECKOUT_DISABLED')
    const denied = harness(() => {
      throw disabled
    })

    await expect(denied.service.createCheckout({ acceptanceId: 'acceptance-1', organizationId: 'org-1', venueId: 'venue-1' })).rejects.toBe(
      disabled,
    )
    expect(denied.repository.loadAcceptance).not.toHaveBeenCalled()
    expect(denied.repository.reserveOperation).not.toHaveBeenCalled()
    expect(denied.gateway.createCheckoutSession).not.toHaveBeenCalled()
  })

  it('reloads the accepted frozen quote and sends only server authority to Stripe', async () => {
    const { service, repository, gateway } = harness()

    await expect(service.createCheckout({ acceptanceId: 'acceptance-1', organizationId: 'org-1', venueId: 'venue-1' })).resolves.toEqual({
      checkoutSessionId: 'cs_test_1',
      checkoutUrl: 'https://checkout.stripe.test/cs_test_1',
    })
    expect(repository.loadAcceptance).toHaveBeenCalledWith('acceptance-1')
    expect(repository.reserveOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptanceId: 'acceptance-1',
        type: 'CHECKOUT_SESSION',
        idempotencyKey: 'commercial:acceptance-1:checkout-session',
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    )
    expect(gateway.createCheckoutSession).toHaveBeenCalledWith({
      acceptanceId: 'acceptance-1',
      quoteId: 'quote-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
      idempotencyKey: 'commercial:acceptance-1:checkout-session',
      frozenQuote,
    })
  })

  it('returns a completed existing operation without calling Stripe twice', async () => {
    const { service, repository, gateway } = harness()
    repository.reserveOperation.mockResolvedValueOnce({
      id: 'stripe-operation-1',
      acceptanceId: 'acceptance-1',
      type: 'CHECKOUT_SESSION',
      status: 'SUCCEEDED',
      idempotencyKey: 'commercial:acceptance-1:checkout-session',
      requestFingerprint,
      stripeCheckoutSessionId: 'cs_existing',
      stripeCheckoutUrl: 'https://checkout.stripe.test/cs_existing',
    })

    await expect(service.createCheckout({ acceptanceId: 'acceptance-1', organizationId: 'org-1', venueId: 'venue-1' })).resolves.toEqual({
      checkoutSessionId: 'cs_existing',
      checkoutUrl: 'https://checkout.stripe.test/cs_existing',
    })
    expect(gateway.createCheckoutSession).not.toHaveBeenCalled()
  })

  it('marks an ambiguous timeout and retries with the exact same Stripe idempotency key', async () => {
    const { service, repository, gateway, getOperation } = harness()
    gateway.createCheckoutSession.mockRejectedValueOnce(new Error('ETIMEDOUT after remote success'))

    await expect(
      service.createCheckout({ acceptanceId: 'acceptance-1', organizationId: 'org-1', venueId: 'venue-1' }),
    ).rejects.toMatchObject({
      code: 'COMMERCIAL_STRIPE_OUTCOME_UNKNOWN',
    })
    expect(repository.markOutcomeUnknown).toHaveBeenCalledWith('stripe-operation-1', 'ETIMEDOUT after remote success')
    expect(getOperation().status).toBe('OUTCOME_UNKNOWN')

    await expect(
      service.createCheckout({ acceptanceId: 'acceptance-1', organizationId: 'org-1', venueId: 'venue-1' }),
    ).resolves.toMatchObject({
      checkoutSessionId: 'cs_test_1',
    })
    expect(gateway.createCheckoutSession.mock.calls.map(call => call[0].idempotencyKey)).toEqual([
      'commercial:acceptance-1:checkout-session',
      'commercial:acceptance-1:checkout-session',
    ])
  })

  it('rejects cross-organization and non-accepted records before reserving Stripe work', async () => {
    const crossed = harness()
    await expect(
      crossed.service.createCheckout({ acceptanceId: 'acceptance-1', organizationId: 'org-other', venueId: 'venue-1' }),
    ).rejects.toMatchObject({
      code: 'COMMERCIAL_STRIPE_SCOPE_MISMATCH',
    })
    expect(crossed.repository.reserveOperation).not.toHaveBeenCalled()

    const canceled = harness()
    canceled.repository.loadAcceptance.mockResolvedValueOnce({ ...acceptance, status: 'CANCELED' })
    await expect(
      canceled.service.createCheckout({ acceptanceId: 'acceptance-1', organizationId: 'org-1', venueId: 'venue-1' }),
    ).rejects.toMatchObject({
      code: 'COMMERCIAL_STRIPE_ACCEPTANCE_NOT_PAYABLE',
    })
    expect(canceled.repository.reserveOperation).not.toHaveBeenCalled()
  })

  it('rejects a cross-venue acceptance before reserving Stripe work', async () => {
    const crossed = harness()

    await expect(
      crossed.service.createCheckout({
        acceptanceId: 'acceptance-1',
        organizationId: 'org-1',
        venueId: 'venue-other',
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_STRIPE_SCOPE_MISMATCH' })
    expect(crossed.repository.reserveOperation).not.toHaveBeenCalled()
  })

  it('rejects Quote v3 lineage before reserving an operation or calling the provider', async () => {
    const unsupported = harness()
    unsupported.repository.loadAcceptance.mockResolvedValueOnce({
      ...acceptance,
      quote: {
        ...acceptance.quote,
        schemaVersion: 3,
        offerVersionId: 'offer-v3-1',
        snapshot: { ...frozenQuote, schemaVersion: 3 },
      },
    })

    await expect(
      unsupported.service.createCheckout({
        acceptanceId: 'acceptance-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTE_SCHEMA_UNSUPPORTED' })

    expect(unsupported.repository.reserveOperation).not.toHaveBeenCalled()
    expect(unsupported.gateway.createCheckoutSession).not.toHaveBeenCalled()
    expect(unsupported.repository.markFailed).not.toHaveBeenCalled()
    expect(unsupported.repository.markOutcomeUnknown).not.toHaveBeenCalled()
  })

  it('marks deterministic quote preparation failures as failed instead of ambiguous', async () => {
    const failed = harness()
    const error = Object.assign(new Error('mixed billing terms'), {
      code: 'COMMERCIAL_STRIPE_QUOTE_NOT_REPRESENTABLE',
      statusCode: 422,
    })
    failed.gateway.createCheckoutSession.mockRejectedValueOnce(error)

    await expect(
      failed.service.createCheckout({
        acceptanceId: 'acceptance-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
      }),
    ).rejects.toBe(error)
    expect(failed.repository.markFailed).toHaveBeenCalledWith('stripe-operation-1', 'mixed billing terms')
    expect(failed.repository.markOutcomeUnknown).not.toHaveBeenCalled()
  })

  it('allows a failed preparation to retry after configuration is corrected', async () => {
    const retried = harness()
    retried.repository.loadAcceptance.mockResolvedValueOnce({ ...acceptance, status: 'FAILED' })

    await expect(
      retried.service.createCheckout({
        acceptanceId: 'acceptance-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
      }),
    ).resolves.toMatchObject({ checkoutSessionId: 'cs_test_1' })
    expect(retried.gateway.createCheckoutSession).toHaveBeenCalledTimes(1)
  })
})
