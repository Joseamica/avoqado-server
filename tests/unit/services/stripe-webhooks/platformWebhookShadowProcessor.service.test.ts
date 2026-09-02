import type Stripe from 'stripe'
import {
  compareCurrentDispatchToClassification,
  createPlatformWebhookShadowProcessor,
} from '@/services/stripe-webhooks/platformWebhookShadowProcessor.service'
import type { CurrentDispatchTrace } from '@/services/stripe-webhooks/platformWebhookCurrentDispatcher.service'
import type { WebhookLease } from '@/services/stripe-webhooks/platformWebhookInbox.service'

const durableEvent = {
  id: 'whe-1',
  stripeEventId: 'evt-1',
  eventType: 'invoice.payment_succeeded',
  payload: { id: 'evt-1', type: 'invoice.payment_succeeded', data: { object: { id: 'in-1' } } },
}

function lease(phase: 'CLASSIFICATION' | 'EFFECT', attempt = 1): WebhookLease {
  return {
    eventId: 'whe-1',
    phase,
    attempt,
    claimToken: `${phase}-token`,
    claimedBy: 'worker-1',
    claimedAt: new Date('2026-08-23T00:00:00.000Z'),
    claimExpiresAt: new Date('2026-08-23T00:15:00.000Z'),
  }
}

function setup() {
  const classificationLease = lease('CLASSIFICATION')
  const effectLease = lease('EFFECT')
  const inbox = {
    load: jest.fn(async () => durableEvent),
    loadShadowState: jest.fn(async () => ({
      classificationState: 'CLASSIFIED',
      authority: {
        ownerKind: 'LEGACY',
        routeKey: 'LEGACY_SUBSCRIPTION_LIFECYCLE',
        subjectKind: 'VENUE_FEATURE',
        subjectId: 'vf-1',
      },
    })),
    acquire: jest.fn(async (_id: string, phase: string) => (phase === 'CLASSIFICATION' ? classificationLease : effectLease)),
    renew: jest.fn(async (value: WebhookLease) => value),
    finalizeClassification: jest.fn(),
    retry: jest.fn(),
    heartbeat: jest.fn(async (value: WebhookLease) => value),
    finalizeEffectWithObservation: jest.fn(),
  }
  const classifier = {
    classify: jest.fn(async () => ({
      state: 'CLASSIFIED',
      authority: {
        ownerKind: 'LEGACY',
        routeKey: 'LEGACY_SUBSCRIPTION_LIFECYCLE',
        subjectKind: 'VENUE_FEATURE',
        subjectId: 'vf-1',
      },
      candidateCount: 1,
      candidateSources: ['VENUE_FEATURE'],
      bindings: [],
    })),
  }
  const trace: CurrentDispatchTrace = {
    steps: [
      { step: 'COMMERCIAL_ADAPTER', outcome: 'NOT_MATCHED' },
      { step: 'VENUE_ENRICHMENT', outcome: 'NOT_APPLICABLE' },
      { step: 'INVOICE_PAYMENT_SUCCEEDED', outcome: 'ATTEMPTED' },
      { step: 'INVOICE_PAYMENT_SUCCEEDED', outcome: 'COMPLETED' },
    ],
    effectiveRouteKeys: ['LEGACY_SUBSCRIPTION_LIFECYCLE'],
  }
  const dispatch = jest.fn(async () => trace)
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const scheduleHeartbeat = jest.fn((_callback: () => Promise<void>) => ({ stop: jest.fn() }))
  const processor = createPlatformWebhookShadowProcessor({ inbox, classifier, dispatch, logger, scheduleHeartbeat } as any)
  return { processor, inbox, classifier, dispatch, logger, scheduleHeartbeat, trace, classificationLease, effectLease }
}

describe('classification/current-effect comparison', () => {
  it.each([
    ['PENDING_CLASSIFICATION', null, [], 'CLASSIFICATION_PENDING'],
    ['IGNORED', null, [], 'NO_AUTHORITY_NO_CURRENT_EFFECT'],
    ['UNRESOLVED', null, ['TOKEN_INVOICE'], 'CURRENT_EFFECT_WITHOUT_AUTHORITY'],
    ['CLASSIFIED', 'TOKEN_INVOICE', [], 'CLASSIFIED_CURRENT_NO_MATCH'],
    ['CLASSIFIED', 'TOKEN_INVOICE', ['LEGACY_SUBSCRIPTION_LIFECYCLE'], 'CLASSIFIED_CURRENT_ROUTE_MISMATCH'],
    ['CLASSIFIED', 'TOKEN_INVOICE', ['TOKEN_INVOICE', 'LEGACY_SUBSCRIPTION_LIFECYCLE'], 'MULTIPLE_CURRENT_BRANCHES'],
    ['CLASSIFIED', 'TOKEN_INVOICE', ['TOKEN_INVOICE'], 'MATCH'],
  ])('maps %s/%s/%j to %s', (classificationState, routeKey, currentRoutes, expected) => {
    expect(
      compareCurrentDispatchToClassification(
        { classificationState, authority: routeKey ? { routeKey } : null } as any,
        currentRoutes as any,
      ),
    ).toBe(expected)
  })
})

describe('platform webhook SHADOW processor', () => {
  it('classifies only the durable signed payload and finalizes through the classification lease', async () => {
    const { processor, inbox, classifier, classificationLease } = setup()

    await processor.processClassification('whe-1')

    expect(inbox.load).toHaveBeenCalledWith('whe-1')
    expect(classifier.classify).toHaveBeenCalledWith({
      webhookEventId: 'whe-1',
      stripeEventId: 'evt-1',
      type: 'invoice.payment_succeeded',
      object: { id: 'in-1' },
    })
    expect(inbox.finalizeClassification).toHaveBeenCalledWith(classificationLease, {
      state: 'CLASSIFIED',
      authority: expect.objectContaining({ routeKey: 'LEGACY_SUBSCRIPTION_LIFECYCLE' }),
    })
  })

  it('skips a stale provided CLASSIFICATION lease before loading or invoking the classifier', async () => {
    const { processor, inbox, classifier, classificationLease } = setup()
    inbox.renew.mockRejectedValueOnce(Object.assign(new Error('stale'), { code: 'STALE_WEBHOOK_LEASE' }))

    await expect(processor.processClassification('whe-1', classificationLease)).resolves.toBe('SKIPPED')

    expect(inbox.load).not.toHaveBeenCalled()
    expect(classifier.classify).not.toHaveBeenCalled()
  })

  it('schedules PENDING classification and does not dispatch an effect from classification', async () => {
    const { processor, inbox, classifier, dispatch } = setup()
    classifier.classify.mockResolvedValueOnce({ state: 'PENDING', code: 'LOCAL_REFERENCE_NOT_READY' } as any)

    await processor.processClassification('whe-1')

    expect(inbox.retry).toHaveBeenCalledWith(expect.objectContaining({ phase: 'CLASSIFICATION' }), {
      code: 'LOCAL_REFERENCE_NOT_READY',
      message: 'Platform webhook classification remains pending',
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not attempt a second retry transition when scheduling PENDING itself fails', async () => {
    const { processor, inbox, classifier } = setup()
    const bookkeepingFailure = new Error('classification retry write failed')
    classifier.classify.mockResolvedValueOnce({ state: 'PENDING', code: 'LOCAL_REFERENCE_NOT_READY' } as any)
    inbox.retry.mockRejectedValueOnce(bookkeepingFailure)

    await expect(processor.processClassification('whe-1')).rejects.toBe(bookkeepingFailure)

    expect(inbox.retry).toHaveBeenCalledTimes(1)
  })

  it('dispatches the durable payload, records the stable comparison and atomically completes EFFECT', async () => {
    const { processor, inbox, dispatch, effectLease, scheduleHeartbeat, trace } = setup()

    await processor.processEffect('whe-1')

    expect(dispatch).toHaveBeenCalledWith(durableEvent.payload as Stripe.Event, 'whe-1')
    expect(scheduleHeartbeat).toHaveBeenCalledWith(expect.any(Function), 5 * 60_000)
    expect(inbox.finalizeEffectWithObservation).toHaveBeenCalledWith(
      effectLease,
      {
        webhookEventId: 'whe-1',
        effectAttempt: 1,
        steps: trace.steps,
        effectOutcome: 'SUCCESS',
        failureStep: null,
        comparisonCode: 'MATCH',
      },
      expect.objectContaining({ outcome: 'SUCCESS', processingTime: expect.any(Number) }),
    )
  })

  it('skips a stale provided EFFECT lease after a manual retry wins and performs zero dispatch', async () => {
    const { processor, inbox, dispatch, effectLease } = setup()
    inbox.renew.mockRejectedValueOnce(Object.assign(new Error('manual worker replaced lease'), { code: 'STALE_WEBHOOK_LEASE' }))

    await expect(processor.processEffect('whe-1', effectLease)).resolves.toBe('SKIPPED')

    expect(inbox.load).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(inbox.finalizeEffectWithObservation).not.toHaveBeenCalled()
  })

  it('uses the CAS-renewed provided lease for heartbeat and finalization', async () => {
    const { processor, inbox, effectLease } = setup()
    const renewed = { ...effectLease, claimExpiresAt: new Date('2026-08-23T00:30:00.000Z') }
    inbox.renew.mockResolvedValueOnce(renewed)

    await processor.processEffect('whe-1', effectLease)

    expect(inbox.renew).toHaveBeenCalledWith(effectLease)
    expect(inbox.finalizeEffectWithObservation).toHaveBeenCalledWith(renewed, expect.any(Object), expect.any(Object))
  })

  it('keeps the EFFECT heartbeat alive through the atomic observation/finalization boundary', async () => {
    const { processor, inbox, scheduleHeartbeat } = setup()
    inbox.finalizeEffectWithObservation.mockImplementationOnce(async () => {
      expect(scheduleHeartbeat.mock.results[0].value.stop).not.toHaveBeenCalled()
    })

    await processor.processEffect('whe-1')

    expect(scheduleHeartbeat.mock.results[0].value.stop).toHaveBeenCalledTimes(1)
  })

  it('persists a partial failed trace and rethrows the identical dispatcher error', async () => {
    const { processor, inbox, dispatch, effectLease, logger } = setup()
    const failure = new Error('effect failed')
    Object.assign(failure, {
      dispatchFailureContext: {
        failureStep: 'INVOICE_PAYMENT_SUCCEEDED',
        steps: [
          { step: 'COMMERCIAL_ADAPTER', outcome: 'NOT_MATCHED' },
          { step: 'VENUE_ENRICHMENT', outcome: 'NOT_APPLICABLE' },
          { step: 'INVOICE_PAYMENT_SUCCEEDED', outcome: 'ATTEMPTED' },
        ],
        effectiveRouteKeys: [],
      },
    })
    dispatch.mockRejectedValueOnce(failure)

    await expect(processor.processEffect('whe-1')).rejects.toBe(failure)
    expect(inbox.finalizeEffectWithObservation).toHaveBeenCalledWith(
      effectLease,
      expect.objectContaining({
        effectOutcome: 'FAILED',
        failureStep: 'INVOICE_PAYMENT_SUCCEEDED',
        comparisonCode: 'CLASSIFIED_CURRENT_NO_MATCH',
      }),
      expect.objectContaining({ outcome: 'FAILED', error: { code: 'WEBHOOK_EFFECT_FAILED', message: 'effect failed' } }),
    )
    expect(logger.info).toHaveBeenCalledWith('Platform webhook EFFECT observed', {
      webhookEventId: 'whe-1',
      effectAttempt: 1,
      effectOutcome: 'FAILED',
      comparisonCode: 'CLASSIFIED_CURRENT_NO_MATCH',
    })
  })

  it('attempts EFFECT even when CLASSIFICATION throws during SHADOW ingress', async () => {
    const { processor, classifier, dispatch } = setup()
    classifier.classify.mockRejectedValueOnce(new Error('classifier failed'))

    const result = await processor.processIngress('whe-1', { mode: 'SHADOW', created: true })

    expect(result.classification).toBe('FAILED')
    expect(result.effect).toBe('COMPLETED')
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('completes EFFECT independently while CLASSIFICATION schedules a pending retry', async () => {
    const { processor, classifier, inbox, dispatch } = setup()
    classifier.classify.mockResolvedValueOnce({ state: 'PENDING', code: 'LOCAL_REFERENCE_NOT_READY' } as any)

    await expect(processor.processIngress('whe-1', { mode: 'SHADOW', created: false })).resolves.toEqual({
      classification: 'COMPLETED',
      effect: 'COMPLETED',
    })

    expect(inbox.retry).toHaveBeenCalledWith(expect.objectContaining({ phase: 'CLASSIFICATION' }), expect.any(Object))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('keeps a completed CLASSIFICATION when EFFECT fails independently', async () => {
    const { processor, inbox, dispatch } = setup()
    dispatch.mockRejectedValueOnce(new Error('effect failed'))

    await expect(processor.processIngress('whe-1', { mode: 'SHADOW', created: true })).resolves.toEqual({
      classification: 'COMPLETED',
      effect: 'FAILED',
    })

    expect(inbox.finalizeClassification).toHaveBeenCalled()
    expect(inbox.finalizeEffectWithObservation).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'EFFECT' }),
      expect.objectContaining({ effectOutcome: 'FAILED' }),
      expect.objectContaining({ outcome: 'FAILED' }),
    )
  })

  it('OFF runs only a newly-created EFFECT and does nothing for an observed duplicate', async () => {
    const first = setup()
    await expect(first.processor.processIngress('whe-1', { mode: 'OFF', created: true })).resolves.toMatchObject({
      classification: 'SKIPPED',
      effect: 'COMPLETED',
    })
    expect(first.classifier.classify).not.toHaveBeenCalled()

    const duplicate = setup()
    await expect(duplicate.processor.processIngress('whe-1', { mode: 'OFF', created: false })).resolves.toEqual({
      classification: 'SKIPPED',
      effect: 'SKIPPED',
    })
    expect(duplicate.dispatch).not.toHaveBeenCalled()
  })

  it('fails closed before dispatch when the durable payload identity is invalid', async () => {
    const { processor, inbox, dispatch } = setup()
    inbox.load.mockRejectedValueOnce(new Error('WEBHOOK_CANONICAL_PAYLOAD_MISMATCH'))

    await expect(processor.processEffect('whe-1')).rejects.toThrow('WEBHOOK_CANONICAL_PAYLOAD_MISMATCH')
    expect(dispatch).not.toHaveBeenCalled()
  })
})
