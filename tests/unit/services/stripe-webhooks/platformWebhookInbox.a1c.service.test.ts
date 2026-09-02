import {
  PLATFORM_WEBHOOK_LIMITS,
  StaleWebhookLeaseError,
  WebhookCanonicalPayloadError,
  createPlatformWebhookInboxService,
  type OperationalAlertLease,
  type PlatformWebhookRepository,
  type WebhookLease,
} from '@/services/stripe-webhooks/platformWebhookInbox.service'

const NOW = new Date('2026-08-23T20:00:00.000Z')

function lease(phase: 'CLASSIFICATION' | 'EFFECT', attempt = 1): WebhookLease {
  return {
    eventId: 'webhook_1',
    phase,
    claimToken: `claim-${phase.toLowerCase()}`,
    claimedBy: 'worker-a',
    claimedAt: NOW,
    claimExpiresAt: new Date(NOW.getTime() + 60_000),
    attempt,
  }
}

function service(repository: Partial<PlatformWebhookRepository>, times: Date[] = [NOW]) {
  let cursor = 0
  return createPlatformWebhookInboxService({
    repository: repository as PlatformWebhookRepository,
    now: () => times[Math.min(cursor++, times.length - 1)],
    workerId: 'worker-a',
    newClaimToken: () => 'claim-generation',
  })
}

describe('P3-1A1c canonical durable load', () => {
  it('returns only a stored event whose payload id and type match the durable columns', async () => {
    const inbox = service({
      loadCanonical: async () => ({
        id: 'webhook_1',
        stripeEventId: 'evt_1',
        eventType: 'invoice.paid',
        payload: { id: 'evt_1', type: 'invoice.paid', data: { object: { id: 'in_1' } } },
      }),
    })

    await expect(inbox.load('webhook_1')).resolves.toMatchObject({ stripeEventId: 'evt_1', eventType: 'invoice.paid' })
  })

  it.each([
    [{ id: 'evt_other', type: 'invoice.paid' }, 'id'],
    [{ id: 'evt_1', type: 'invoice.payment_failed' }, 'type'],
    [null, 'shape'],
  ])('fails closed before dispatch when the stored payload has a mismatched %s', async (payload, _reason) => {
    const inbox = service({
      loadCanonical: async () => ({ id: 'webhook_1', stripeEventId: 'evt_1', eventType: 'invoice.paid', payload }),
    })

    await expect(inbox.load('webhook_1')).rejects.toBeInstanceOf(WebhookCanonicalPayloadError)
  })
})

describe('P3-1A1c claims and heartbeat', () => {
  it('uses phase-specific lease defaults and a fresh generation for an ingress/manual claim', async () => {
    const seen: Array<{ phase: string; expiresAt: Date; manual: boolean }> = []
    const inbox = service(
      {
        acquireLease: async command => {
          seen.push({ phase: command.phase, expiresAt: command.claimExpiresAt, manual: command.manual })
          return { ...lease(command.phase), claimToken: command.claimToken, claimExpiresAt: command.claimExpiresAt }
        },
      },
      [NOW, NOW],
    )

    await inbox.acquire('webhook_1', 'CLASSIFICATION')
    await inbox.acquire('webhook_1', 'EFFECT', { manual: true })

    expect(seen).toEqual([
      { phase: 'CLASSIFICATION', expiresAt: new Date(NOW.getTime() + 2 * 60_000), manual: false },
      { phase: 'EFFECT', expiresAt: new Date(NOW.getTime() + 15 * 60_000), manual: true },
    ])
  })

  it('requests one atomic ordered batch capped at 25 and preserves repository order', async () => {
    const claimed = Array.from({ length: 25 }, (_, index) => ({ ...lease('EFFECT'), eventId: `event-${index + 1}` }))
    let requestedLimit = 0
    const inbox = service({
      acquireLeaseBatch: async command => {
        requestedLimit = command.limit
        return claimed
      },
    })

    await expect(inbox.acquireBatch('EFFECT')).resolves.toEqual(claimed)
    expect(requestedLimit).toBe(PLATFORM_WEBHOOK_LIMITS.batchSize)
  })

  it('claims exactly one next row just-in-time', async () => {
    const claimed = { ...lease('CLASSIFICATION'), eventId: 'next-event' }
    let requestedLimit = 0
    const inbox = service({
      acquireLeaseBatch: async command => {
        requestedLimit = command.limit
        return [claimed]
      },
    })

    await expect(inbox.acquireNext('CLASSIFICATION')).resolves.toEqual(claimed)
    expect(requestedLimit).toBe(1)
  })

  it('renews either phase through the same live-lease CAS before provided-lease execution', async () => {
    const classification = lease('CLASSIFICATION')
    const renewed = { ...classification, claimExpiresAt: new Date(NOW.getTime() + PLATFORM_WEBHOOK_LIMITS.classificationLeaseMs) }
    const inbox = service({ renewLease: async () => renewed })

    await expect(inbox.renew(classification)).resolves.toEqual(renewed)
  })

  it('renews EFFECT from one repository db clock and rejects a stale generation', async () => {
    const current = lease('EFFECT')
    const renewed = { ...current, claimExpiresAt: new Date(NOW.getTime() + PLATFORM_WEBHOOK_LIMITS.effectLeaseMs) }
    const live = service({ renewLease: async () => renewed })
    await expect(live.heartbeat(current)).resolves.toEqual(renewed)

    const stale = service({ renewLease: async () => null })
    await expect(stale.heartbeat(current)).rejects.toBeInstanceOf(StaleWebhookLeaseError)
  })

  it('does not offer heartbeat for the normal CLASSIFICATION path', async () => {
    const inbox = service({ renewLease: async () => lease('CLASSIFICATION') })
    await expect(inbox.heartbeat(lease('CLASSIFICATION'))).rejects.toThrow('EFFECT')
  })
})

describe('P3-1A1c terminalization, observations and operational alerts', () => {
  it('finalizes SUCCESS and its dispatch observation through one repository CAS', async () => {
    let command: Record<string, unknown> | undefined
    const inbox = service({
      finalizeEffectWithObservation: async input => {
        command = input as unknown as Record<string, unknown>
        return true
      },
    })
    const effectLease = lease('EFFECT', 3)
    await expect(
      inbox.finalizeEffectWithObservation(
        effectLease,
        {
          webhookEventId: effectLease.eventId,
          effectAttempt: effectLease.attempt,
          steps: [{ step: 'COMMERCIAL_ADAPTER', outcome: 'NOT_MATCHED' }],
          effectOutcome: 'SUCCESS',
          comparisonCode: 'CLASSIFICATION_PENDING',
        },
        { outcome: 'SUCCESS', processingTime: 42 },
      ),
    ).resolves.toBeUndefined()
    expect(command).toMatchObject({ lease: effectLease, outcome: 'SUCCESS', processingTime: 42 })
  })

  it('finalizes a recoverable failure and observation with one computed backoff', async () => {
    let nextAttemptAt: Date | null | undefined
    const inbox = service({
      finalizeEffectWithObservation: async command => {
        nextAttemptAt = command.nextAttemptAt
        return true
      },
    })
    const effectLease = lease('EFFECT', 2)
    await inbox.finalizeEffectWithObservation(
      effectLease,
      {
        webhookEventId: effectLease.eventId,
        effectAttempt: effectLease.attempt,
        steps: [],
        effectOutcome: 'FAILED',
        failureStep: 'COMMERCIAL_ADAPTER',
        comparisonCode: 'CLASSIFICATION_PENDING',
      },
      { outcome: 'FAILED', error: { code: 'DISPATCH_FAILED', message: 'closed failure' } },
    )
    expect(nextAttemptAt).toEqual(new Date(NOW.getTime() + 4_000))
  })

  it.each([
    [{ steps: [{ step: 'COMMERCIAL_ADAPTER', outcome: 'ATTEMPTED' }] }, 'step outcome'],
    [{ steps: [{ step: 'INVOICE_PAYMENT_SUCCEEDED', outcome: 'COMPLETED', metadata: { venueId: 'pii' } }] }, 'step shape'],
    [{ steps: [{ step: 'ARBITRARY_HANDLER', outcome: 'COMPLETED' }] }, 'step code'],
    [{ failureStep: 'ARBITRARY_HANDLER' }, 'failure step'],
    [{ comparisonCode: 'ARBITRARY_COMPARISON' }, 'comparison'],
    [{ effectOutcome: 'PARTIAL' }, 'effect outcome'],
  ])('rejects an observation with an unknown or data-bearing %s', async (override, _reason) => {
    const finalizeEffectWithObservation = jest.fn(async () => true)
    const inbox = service({ finalizeEffectWithObservation })

    await expect(
      inbox.finalizeEffectWithObservation(
        lease('EFFECT'),
        {
          webhookEventId: 'webhook_1',
          effectAttempt: 1,
          steps: [],
          effectOutcome: 'SUCCESS',
          failureStep: null,
          comparisonCode: 'CLASSIFICATION_PENDING',
          ...override,
        } as any,
        { outcome: 'SUCCESS' },
      ),
    ).rejects.toThrow('observation')
    expect(finalizeEffectWithObservation).not.toHaveBeenCalled()
  })

  it.each([
    [{ webhookEventId: 'other', effectAttempt: 3, effectOutcome: 'SUCCESS' }, 'event'],
    [{ webhookEventId: 'webhook_1', effectAttempt: 2, effectOutcome: 'SUCCESS' }, 'attempt'],
    [{ webhookEventId: 'webhook_1', effectAttempt: 3, effectOutcome: 'FAILED' }, 'outcome'],
  ])('rejects a mismatched atomic observation %s before persistence', async (override, _reason) => {
    const finalizeEffectWithObservation = jest.fn(async () => true)
    const inbox = service({ finalizeEffectWithObservation })
    const observation = Object.assign(
      {
        webhookEventId: 'webhook_1',
        effectAttempt: 3,
        steps: [],
        effectOutcome: 'SUCCESS' as const,
        comparisonCode: 'CLASSIFICATION_PENDING' as const,
      },
      override,
    )
    await expect(inbox.finalizeEffectWithObservation(lease('EFFECT', 3), observation as never, { outcome: 'SUCCESS' })).rejects.toThrow(
      'observation',
    )
    expect(finalizeEffectWithObservation).not.toHaveBeenCalled()
  })

  it('treats a lost atomic-effect CAS as stale and never falls back to a separate write', async () => {
    const inbox = service({ finalizeEffectWithObservation: async () => false })
    const effectLease = lease('EFFECT', 1)
    await expect(
      inbox.finalizeEffectWithObservation(
        effectLease,
        {
          webhookEventId: effectLease.eventId,
          effectAttempt: effectLease.attempt,
          steps: [],
          effectOutcome: 'SUCCESS',
          comparisonCode: 'CLASSIFICATION_PENDING',
        },
        { outcome: 'SUCCESS' },
      ),
    ).rejects.toBeInstanceOf(StaleWebhookLeaseError)
  })

  it('terminalizes exhausted phases through one repository transition that owns alert creation', async () => {
    const calls: unknown[] = []
    const inbox = service({
      terminalizeExhaustedPhase: async command => {
        calls.push(command)
        return [{ eventId: 'webhook_1', phase: command.phase, attempt: 5, terminalReason: 'EFFECT_ATTEMPTS_EXHAUSTED' }]
      },
    })

    await expect(inbox.terminalizeExhausted('EFFECT', 'webhook_1')).resolves.toEqual([
      { eventId: 'webhook_1', phase: 'EFFECT', attempt: 5, terminalReason: 'EFFECT_ATTEMPTS_EXHAUSTED' },
    ])
    expect(calls).toHaveLength(1)
  })

  it('persists venue enrichment without changing either phase state', async () => {
    const inbox = service({ enrichVenue: async command => command.venueId === 'venue_1' })
    await expect(inbox.enrichVenueId('webhook_1', 'venue_1')).resolves.toBe(true)
  })

  it('creates an append-only observation idempotently for the same effect attempt', async () => {
    const inbox = service({ createDispatchObservation: async command => ({ status: 'CREATED', observation: command }) })
    await expect(
      inbox.recordDispatchObservation({
        webhookEventId: 'webhook_1',
        effectAttempt: 3,
        steps: [{ step: 'COMMERCIAL_ADAPTER', outcome: 'NOT_MATCHED' }],
        effectOutcome: 'SUCCESS',
        comparisonCode: 'CLASSIFICATION_PENDING',
      }),
    ).resolves.toMatchObject({ status: 'CREATED' })
  })

  it('claims operational alerts in a batch and acknowledges only the live anti-ABA token', async () => {
    const alert: OperationalAlertLease = {
      alertId: 'alert_1',
      webhookEventId: 'webhook_1',
      phase: 'EFFECT',
      terminalReason: 'EFFECT_ATTEMPTS_EXHAUSTED',
      attempt: 5,
      payload: { webhookEventId: 'webhook_1', phase: 'EFFECT', attempt: 5 },
      deliveryAttempt: 1,
      claimToken: 'alert-claim',
      claimedBy: 'worker-a',
      claimedAt: NOW,
      claimExpiresAt: new Date(NOW.getTime() + 60_000),
    }
    const inbox = service({
      acquireOperationalAlertBatch: async () => [alert],
      completeOperationalAlert: async () => true,
    })

    await expect(inbox.claimOperationalAlerts()).resolves.toEqual([alert])
    await expect(inbox.acknowledgeOperationalAlert(alert)).resolves.toBeUndefined()
  })

  it('rejects an operational alert acknowledgement after its lease generation is stale', async () => {
    const alert = {
      alertId: 'alert_1',
      webhookEventId: 'webhook_1',
      phase: 'EFFECT' as const,
      terminalReason: 'EFFECT_ATTEMPTS_EXHAUSTED',
      attempt: 5,
      payload: {},
      deliveryAttempt: 1,
      claimToken: 'stale',
      claimedBy: 'worker-a',
      claimedAt: NOW,
      claimExpiresAt: new Date(NOW.getTime() + 60_000),
    }
    const inbox = service({ completeOperationalAlert: async () => false })
    await expect(inbox.acknowledgeOperationalAlert(alert)).rejects.toThrow('stale')
  })

  it('retries alert delivery with bounded backoff and the same anti-ABA generation', async () => {
    const alert = {
      alertId: 'alert_1',
      webhookEventId: 'webhook_1',
      phase: 'EFFECT' as const,
      terminalReason: 'EFFECT_ATTEMPTS_EXHAUSTED',
      attempt: 5,
      payload: {},
      deliveryAttempt: 2,
      claimToken: 'live',
      claimedBy: 'worker-a',
      claimedAt: NOW,
      claimExpiresAt: new Date(NOW.getTime() + 60_000),
    }
    let nextAttemptAt: Date | undefined
    const inbox = service({
      retryOperationalAlert: async command => {
        nextAttemptAt = command.nextAttemptAt
        return true
      },
    })

    await expect(inbox.retryOperationalAlert(alert)).resolves.toBeUndefined()
    expect(nextAttemptAt).toEqual(new Date(NOW.getTime() + 4_000))
  })
})
