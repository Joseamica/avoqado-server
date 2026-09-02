import {
  createPlatformWebhookInboxService,
  getWebhookPhaseEligibility,
  isAllowedStripeAuthorityTuple,
  nextWebhookRetryAt,
  type PlatformWebhookRepository,
  type WebhookLease,
} from '@/services/stripe-webhooks/platformWebhookInbox.service'

const NOW = new Date('2026-08-23T18:00:00.000Z')

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    classificationState: 'PENDING_CLASSIFICATION' as const,
    classificationAttempts: 0,
    classificationNextAttemptAt: NOW,
    status: 'PENDING' as const,
    effectAttempts: 0,
    effectNextAttemptAt: NOW,
    claimPhase: null,
    claimExpiresAt: null,
    ...overrides,
  }
}

describe('platform webhook authority matrix', () => {
  it.each([
    ['COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE'],
    ['LEGACY', 'LEGACY_PLAN_CHECKOUT', 'STRIPE_CHECKOUT_ORIGIN'],
    ['LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'VENUE_FEATURE'],
    ['INDEPENDENT', 'TERMINAL_ORDER_CHECKOUT', 'TERMINAL_ORDER'],
    ['INDEPENDENT', 'TOKEN_PAYMENT_INTENT', 'TOKEN_PURCHASE'],
    ['INDEPENDENT', 'TOKEN_INVOICE', 'TOKEN_PURCHASE'],
    ['LEGACY', 'VENUE_BILLING_PROFILE', 'VENUE'],
  ] as const)('accepts the frozen owner/route/subject tuple %s/%s/%s', (ownerKind, routeKey, subjectKind) => {
    expect(isAllowedStripeAuthorityTuple({ ownerKind, routeKey, subjectKind, subjectId: 'subject_1' })).toBe(true)
  })

  it.each([
    ['LEGACY', 'CREDIT_PACK_CHECKOUT', 'TOKEN_PURCHASE'],
    ['LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'STRIPE_CHECKOUT_ORIGIN'],
    ['COMMERCIAL_V2', 'LEGACY_PLAN_CHECKOUT', 'STRIPE_CHECKOUT_ORIGIN'],
    ['INDEPENDENT', 'TOKEN_INVOICE', 'VENUE_FEATURE'],
    ['LEGACY', 'VENUE_BILLING_PROFILE', 'STRIPE_CHECKOUT_ORIGIN'],
  ] as const)('rejects non-authorizable and mismatched tuples %s/%s/%s', (ownerKind, routeKey, subjectKind) => {
    expect(isAllowedStripeAuthorityTuple({ ownerKind, routeKey, subjectKind, subjectId: 'subject_1' })).toBe(false)
  })
})

describe('Stripe object type/authority matrix', () => {
  const allowedBindings = [
    ['CHECKOUT_SESSION', 'COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE'],
    ['CHECKOUT_SESSION', 'LEGACY', 'LEGACY_PLAN_CHECKOUT', 'STRIPE_CHECKOUT_ORIGIN'],
    ['CHECKOUT_SESSION', 'INDEPENDENT', 'TERMINAL_ORDER_CHECKOUT', 'TERMINAL_ORDER'],
    ['SUBSCRIPTION', 'COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE'],
    ['SUBSCRIPTION', 'LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'VENUE_FEATURE'],
    ['INVOICE', 'COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE'],
    ['INVOICE', 'LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'VENUE_FEATURE'],
    ['INVOICE', 'INDEPENDENT', 'TOKEN_INVOICE', 'TOKEN_PURCHASE'],
    ['PAYMENT_INTENT', 'COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE'],
    ['PAYMENT_INTENT', 'LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'VENUE_FEATURE'],
    ['PAYMENT_INTENT', 'INDEPENDENT', 'TOKEN_PAYMENT_INTENT', 'TOKEN_PURCHASE'],
    ['CHARGE', 'COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE'],
    ['CHARGE', 'LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'VENUE_FEATURE'],
  ] as const

  const rejectedBindings = [
    ['CHECKOUT_SESSION', 'LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'VENUE_FEATURE'],
    ['SUBSCRIPTION', 'LEGACY', 'LEGACY_PLAN_CHECKOUT', 'STRIPE_CHECKOUT_ORIGIN'],
    ['INVOICE', 'INDEPENDENT', 'TOKEN_PAYMENT_INTENT', 'TOKEN_PURCHASE'],
    ['PAYMENT_INTENT', 'INDEPENDENT', 'TOKEN_INVOICE', 'TOKEN_PURCHASE'],
    ['CHARGE', 'INDEPENDENT', 'TOKEN_INVOICE', 'TOKEN_PURCHASE'],
    ['CHARGE', 'INDEPENDENT', 'TOKEN_PAYMENT_INTENT', 'TOKEN_PURCHASE'],
    ['INVOICE', 'LEGACY', 'VENUE_BILLING_PROFILE', 'VENUE'],
  ] as const

  function subjectId(subjectKind: string) {
    if (subjectKind === 'COMMERCIAL_ACCEPTANCE') return 'acceptance_1'
    if (subjectKind === 'STRIPE_CHECKOUT_ORIGIN') return 'origin_1'
    if (subjectKind === 'VENUE_FEATURE') return 'venue_feature_1'
    if (subjectKind === 'TERMINAL_ORDER') return 'terminal_order_1'
    if (subjectKind === 'TOKEN_PURCHASE') return 'token_purchase_1'
    return 'venue_1'
  }

  function bindingService() {
    const createOrCompareBinding = jest.fn(async command => ({ status: 'CREATED' as const, binding: command, authorityMatches: true }))
    const service = createPlatformWebhookInboxService({
      repository: { createOrCompareBinding } as unknown as PlatformWebhookRepository,
      now: () => NOW,
      workerId: 'binding-worker',
    })
    return { service, createOrCompareBinding }
  }

  it.each(allowedBindings)('allows %s with %s/%s/%s', async (objectType, ownerKind, routeKey, subjectKind) => {
    const { service, createOrCompareBinding } = bindingService()
    await expect(
      service.bind({
        objectType,
        stripeObjectId: `allowed_${objectType.toLowerCase()}`,
        authority: { ownerKind, routeKey, subjectKind, subjectId: subjectId(subjectKind) },
      }),
    ).resolves.toMatchObject({ status: 'CREATED' })
    expect(createOrCompareBinding).toHaveBeenCalledTimes(1)
  })

  it.each(rejectedBindings)('rejects %s with %s/%s/%s before persistence', async (objectType, ownerKind, routeKey, subjectKind) => {
    const { service, createOrCompareBinding } = bindingService()
    await expect(
      service.bind({
        objectType,
        stripeObjectId: `rejected_${objectType.toLowerCase()}`,
        authority: { ownerKind, routeKey, subjectKind, subjectId: subjectId(subjectKind) },
      }),
    ).rejects.toThrow('not authorizable')
    expect(createOrCompareBinding).not.toHaveBeenCalled()
  })
})

describe('platform webhook phase scheduling', () => {
  it('treats null next-attempt as terminal/not scheduled rather than due now', () => {
    expect(
      getWebhookPhaseEligibility(pendingRow({ classificationNextAttemptAt: null }), 'CLASSIFICATION', NOW, {
        classification: 5,
        effect: 5,
      }),
    ).toBe('NOT_SCHEDULED')
    expect(
      getWebhookPhaseEligibility(pendingRow({ effectNextAttemptAt: null }), 'EFFECT', NOW, {
        classification: 5,
        effect: 5,
      }),
    ).toBe('NOT_SCHEDULED')
    expect(
      getWebhookPhaseEligibility(pendingRow({ status: 'FAILED', effectNextAttemptAt: null }), 'EFFECT', NOW, {
        classification: 5,
        effect: 5,
      }),
    ).toBe('NOT_SCHEDULED')
  })

  it('keeps the two phase budgets independent while one live shared lease blocks both', () => {
    expect(
      getWebhookPhaseEligibility(pendingRow({ classificationAttempts: 5, effectAttempts: 1 }), 'CLASSIFICATION', NOW, {
        classification: 5,
        effect: 5,
      }),
    ).toBe('BUDGET_EXHAUSTED')
    expect(
      getWebhookPhaseEligibility(pendingRow({ classificationAttempts: 5, effectAttempts: 1 }), 'EFFECT', NOW, {
        classification: 5,
        effect: 5,
      }),
    ).toBe('ELIGIBLE')

    const liveLease = pendingRow({ claimPhase: 'CLASSIFICATION', claimExpiresAt: new Date(NOW.getTime() + 1) })
    expect(getWebhookPhaseEligibility(liveLease, 'CLASSIFICATION', NOW, { classification: 5, effect: 5 })).toBe('LIVE_LEASE')
    expect(getWebhookPhaseEligibility(liveLease, 'EFFECT', NOW, { classification: 5, effect: 5 })).toBe('LIVE_LEASE')
  })

  it('allows an expired shared lease to be recovered but never an over-budget phase', () => {
    const expired = pendingRow({ claimPhase: 'EFFECT', claimExpiresAt: new Date(NOW.getTime() - 1) })
    expect(getWebhookPhaseEligibility(expired, 'CLASSIFICATION', NOW, { classification: 5, effect: 5 })).toBe('ELIGIBLE')
    expect(getWebhookPhaseEligibility(expired, 'EFFECT', NOW, { classification: 5, effect: 5 })).toBe('ELIGIBLE')
    expect(getWebhookPhaseEligibility({ ...expired, effectAttempts: 5 }, 'EFFECT', NOW, { classification: 5, effect: 5 })).toBe(
      'BUDGET_EXHAUSTED',
    )
  })

  it('uses bounded deterministic backoff without turning a terminal null into due-now', () => {
    expect(nextWebhookRetryAt(NOW, 1, { baseMs: 2_000, maxMs: 30_000 })).toEqual(new Date(NOW.getTime() + 2_000))
    expect(nextWebhookRetryAt(NOW, 2, { baseMs: 2_000, maxMs: 30_000 })).toEqual(new Date(NOW.getTime() + 4_000))
    expect(nextWebhookRetryAt(NOW, 100, { baseMs: 2_000, maxMs: 30_000 })).toEqual(new Date(NOW.getTime() + 30_000))
  })
})

describe('platform webhook lease service', () => {
  it('generates a fresh anti-ABA token on every acquisition by the same worker', async () => {
    const seenTokens: string[] = []
    const repository = {
      acquireLease: jest.fn(async command => {
        seenTokens.push(command.claimToken)
        return {
          eventId: command.eventId,
          phase: command.phase,
          claimToken: command.claimToken,
          claimedBy: command.claimedBy,
          claimedAt: command.now,
          claimExpiresAt: command.claimExpiresAt,
          attempt: 1,
        } satisfies WebhookLease
      }),
    } as unknown as PlatformWebhookRepository
    let sequence = 0
    const service = createPlatformWebhookInboxService({
      repository,
      now: () => NOW,
      workerId: 'worker-a',
      newClaimToken: () => `claim-${++sequence}`,
      leaseMs: 30_000,
      maxAttempts: { classification: 5, effect: 5 },
      retryBackoff: { baseMs: 2_000, maxMs: 30_000 },
    })

    await expect(service.acquire('event_1', 'CLASSIFICATION')).resolves.toMatchObject({ claimToken: 'claim-1' })
    await expect(service.acquire('event_1', 'CLASSIFICATION')).resolves.toMatchObject({ claimToken: 'claim-2' })
    expect(seenTokens).toEqual(['claim-1', 'claim-2'])
  })
})
