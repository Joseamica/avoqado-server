import type Stripe from 'stripe'
import {
  PLATFORM_WEBHOOK_LIMITS,
  createPlatformWebhookInboxService,
  createPrismaPlatformWebhookRepository,
} from '@/services/stripe-webhooks/platformWebhookInbox.service'
import { createPlatformWebhookShadowProcessor } from '@/services/stripe-webhooks/platformWebhookShadowProcessor.service'
import { withOrchestratorPrimitivesDatabase } from './platform-webhook-orchestrator-primitives-harness'

jest.setTimeout(120_000)

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const classifier = {
  classify: jest.fn(async () => ({
    state: 'IGNORED' as const,
    code: 'EVENT_TYPE_NOT_HANDLED' as const,
    candidateCount: 0,
    candidateSources: [],
    bindings: [],
  })),
}

function signedEvent(id: string): Stripe.Event {
  return {
    id,
    type: 'invoice.upcoming',
    created: 1787522400,
    data: { object: { id: `in_${id}` } },
  } as unknown as Stripe.Event
}

describe('P3-1A1c-b PostgreSQL shadow processor', () => {
  it('recovers a post-side-effect/pre-commit crash with the durable payload and explicit at-least-once semantics', async () => {
    const proof = await withOrchestratorPrimitivesDatabase(async ({ first, second, sql, applyA1cMigration }) => {
      await applyA1cMigration()
      let clock = new Date('2026-08-23T12:00:00.000Z')
      const firstInbox = createPlatformWebhookInboxService({
        repository: createPrismaPlatformWebhookRepository(first),
        workerId: 'processor-before-crash',
        now: () => clock,
        newClaimToken: () => 'effect-before-crash',
      })
      const observed = await firstInbox.observe({
        stripeEventId: 'evt_processor_crash',
        eventType: 'invoice.upcoming',
        payload: signedEvent('evt_processor_crash'),
      })

      let externalEffects = 0
      const failBeforeCommitInbox = {
        ...firstInbox,
        async finalizeEffectWithObservation() {
          throw new Error('simulated crash before local completion commit')
        },
      }
      const crashedProcessor = createPlatformWebhookShadowProcessor({
        inbox: failBeforeCommitInbox,
        classifier,
        logger,
        dispatch: async event => {
          expect(event.id).toBe('evt_processor_crash')
          externalEffects++
          return { steps: [], effectiveRouteKeys: [] }
        },
        scheduleHeartbeat: () => ({ stop: jest.fn() }),
      })

      await expect(crashedProcessor.processEffect(observed.event.id)).rejects.toThrow('simulated crash before local completion commit')

      clock = new Date(clock.getTime() + PLATFORM_WEBHOOK_LIMITS.effectLeaseMs + 1)
      const recoveredInbox = createPlatformWebhookInboxService({
        repository: createPrismaPlatformWebhookRepository(second),
        workerId: 'processor-after-crash',
        now: () => clock,
        newClaimToken: () => 'effect-after-crash',
      })
      const recoveredProcessor = createPlatformWebhookShadowProcessor({
        inbox: recoveredInbox,
        classifier,
        logger,
        dispatch: async event => {
          expect(event.id).toBe('evt_processor_crash')
          externalEffects++
          return { steps: [], effectiveRouteKeys: [] }
        },
        scheduleHeartbeat: () => ({ stop: jest.fn() }),
      })

      await recoveredProcessor.processEffect(observed.event.id)

      const eventRow = await sql.query(
        `
        SELECT status, "effectAttempts", "retryCount", "effectNextAttemptAt", "processedAt", "claimPhase"
        FROM "WebhookEvent" WHERE id = $1
      `,
        [observed.event.id],
      )
      const observations = await sql.query(
        `
        SELECT "effectAttempt", "effectOutcome", "comparisonCode", steps
        FROM "WebhookDispatchObservation" WHERE "webhookEventId" = $1 ORDER BY "effectAttempt"
      `,
        [observed.event.id],
      )

      return { externalEffects, event: eventRow.rows[0], observations: observations.rows }
    })

    expect(proof.result.externalEffects).toBe(2)
    expect(proof.result.event).toEqual({
      status: 'SUCCESS',
      effectAttempts: 2,
      retryCount: 2,
      effectNextAttemptAt: null,
      processedAt: expect.any(Date),
      claimPhase: null,
    })
    expect(proof.result.observations).toEqual([
      {
        effectAttempt: 2,
        effectOutcome: 'SUCCESS',
        comparisonCode: 'CLASSIFICATION_PENDING',
        steps: [],
      },
    ])
    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
  })
})
