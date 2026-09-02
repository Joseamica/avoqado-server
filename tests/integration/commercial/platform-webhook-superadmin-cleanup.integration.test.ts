import { Prisma } from '@prisma/client'
import {
  createPlatformWebhookInboxService,
  createPrismaPlatformWebhookRepository,
  type PlatformWebhookRepository,
  type WebhookLease,
} from '@/services/stripe-webhooks/platformWebhookInbox.service'
import {
  createDurableManualRetryAuditWriter,
  createWebhookManualRetryService,
  type ManualRetrySnapshot,
} from '@/services/superadmin/webhookManualRetry.service'
import {
  createPrismaWebhookManualRetryOutboxRepository,
  createWebhookManualRetryOutboxService,
} from '@/services/superadmin/webhookManualRetryOutbox.service'
import { deleteUnboundPlatformWebhookEventsForVenue } from '@/services/cleanup/liveDemoCleanup.service'
import { withOrchestratorPrimitivesDatabase } from './platform-webhook-orchestrator-primitives-harness'

jest.setTimeout(120_000)

const baseClock = new Date('2030-08-24T12:00:00.000Z')

async function insertAttemptFour(sql: { query(statement: string, values?: unknown[]): Promise<unknown> }, eventId: string) {
  await sql.query(
    `INSERT INTO "WebhookEvent" (
       id, "stripeEventId", "eventType", payload, status,
       "classificationState", "classificationAttempts", "classificationNextAttemptAt", "classificationResolvedAt",
       "ownerKind", "routeKey", "subjectKind", "subjectId",
       "effectAttempts", "effectNextAttemptAt", "retryCount", "venueId", "createdAt", "updatedAt"
     ) VALUES (
       $1, $2, 'invoice.payment_failed', $3::jsonb, 'FAILED',
       'CLASSIFIED', 2, NULL, $4::timestamp,
       'LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'VENUE_FEATURE', 'feature-1',
       4, $4::timestamp, 4, 'venue-1', $4::timestamp, $4::timestamp
     )`,
    [eventId, `evt_${eventId}`, JSON.stringify({ id: `evt_${eventId}`, type: 'invoice.payment_failed', data: { object: {} } }), baseClock],
  )
}

function observation(lease: WebhookLease, outcome: 'SUCCESS' | 'FAILED') {
  return {
    webhookEventId: lease.eventId,
    effectAttempt: lease.attempt,
    steps: [],
    effectOutcome: outcome,
    failureStep: outcome === 'FAILED' ? ('COMMERCIAL_ADAPTER' as const) : null,
    comparisonCode: 'CLASSIFICATION_PENDING' as const,
  }
}

describe('P3-1A1c-c PostgreSQL manual retry result outbox', () => {
  it('atomically claims attempt five, survives unknown commits/restarts, and audits exact terminal outcomes once', async () => {
    const proof = await withOrchestratorPrimitivesDatabase(async ({ first, sql, applyA1cMigration, applyA1cCManualRetryMigration }) => {
      await applyA1cMigration()
      await applyA1cCManualRetryMigration()
      for (const eventId of ['manual-success', 'manual-failure', 'manual-unknown', 'manual-interrupted', 'manual-skipped']) {
        await insertAttemptFour(sql, eventId)
      }

      let clock = new Date(baseClock)
      const prismaInboxRepository = createPrismaPlatformWebhookRepository(first)
      let simulateUnknownCommit = true
      let unknownCommitCalls = 0
      const inboxRepository: PlatformWebhookRepository = {
        ...prismaInboxRepository,
        async acquireManualEffectWithAuditIntent(command) {
          const result = await prismaInboxRepository.acquireManualEffectWithAuditIntent(command)
          if (command.eventId === 'manual-success') {
            unknownCommitCalls += 1
            if (simulateUnknownCommit) {
              simulateUnknownCommit = false
              throw new Error('connection lost after commit acknowledgement')
            }
          }
          return result
        },
      }
      let effectToken = 0
      const inbox = createPlatformWebhookInboxService({
        repository: inboxRepository,
        workerId: 'superadmin-pg-worker',
        now: () => new Date(clock),
        newClaimToken: () => `manual-pg-${++effectToken}`,
      })
      let deliveryToken = 0
      const createOutboxWorker = (workerId: string) =>
        createWebhookManualRetryOutboxService({
          repository: createPrismaWebhookManualRetryOutboxRepository(first),
          workerId,
          now: () => new Date(clock),
          newClaimToken: () => `${workerId}-${++deliveryToken}`,
        })
      const immediateOutbox = createOutboxWorker('manual-audit-immediate')
      const inspect = (eventId: string): Promise<ManualRetrySnapshot | null> =>
        first.webhookEvent.findUnique({
          where: { id: eventId },
          select: {
            id: true,
            venueId: true,
            status: true,
            effectAttempts: true,
            effectNextAttemptAt: true,
            claimPhase: true,
            claimExpiresAt: true,
          },
        })
      const writeAudit = createDurableManualRetryAuditWriter(first)
      const ids = [
        'intent-success',
        'request-success',
        'result-success',
        'intent-failure',
        'request-failure',
        'result-failure',
        'intent-unknown',
        'request-unknown',
        'result-unknown',
        'intent-skipped',
        'request-skipped',
        'result-skipped',
      ]
      const manualRetry = createWebhookManualRetryService({
        inspect,
        writeAudit,
        acquireEffectWithIntent: input => inbox.acquireManualEffectWithAuditIntent(input),
        markDispatchStarted: (intentId, lease) => immediateOutbox.markDispatchStarted(intentId, lease),
        async processEffect(eventId, lease) {
          if (eventId === 'manual-success') {
            await inbox.finalizeEffectWithObservation(lease, observation(lease, 'SUCCESS'), {
              outcome: 'SUCCESS',
              processingTime: 12,
            })
            return 'COMPLETED'
          }
          if (eventId === 'manual-failure') {
            await inbox.finalizeEffectWithObservation(lease, observation(lease, 'FAILED'), {
              outcome: 'FAILED',
              processingTime: 13,
              error: { code: 'INJECTED_EFFECT_FAILURE', message: 'Injected failure' },
            })
            throw new Error('Injected failure after durable observation')
          }
          if (eventId === 'manual-skipped') return 'SKIPPED'
          throw new Error('Injected crash after durable dispatch-start')
        },
        settleRejected: (intentId, lease) => immediateOutbox.settleRejected(intentId, lease),
        deliverResult: intentId => immediateOutbox.deliverResult(intentId),
        now: () => new Date(clock),
        newId: () => ids.shift()!,
      })

      const success = await manualRetry('manual-success', { actorId: 'staff-root', reason: 'Éxito controlado' })
      const failure = await manualRetry('manual-failure', { actorId: 'staff-root', reason: 'Falla controlada' }).catch(error => error)
      const unknown = await manualRetry('manual-unknown', { actorId: 'staff-root', reason: 'Crash controlado' }).catch(error => error)
      const skipped = await manualRetry('manual-skipped', { actorId: 'staff-root', reason: 'Salto controlado' }).catch(error => error)

      await writeAudit({
        activityLogId: 'request-interrupted',
        intentId: 'intent-interrupted',
        requestActivityLogId: 'request-interrupted',
        resultActivityLogId: 'result-interrupted',
        actorId: 'staff-root',
        venueId: 'venue-1',
        eventId: 'manual-interrupted',
        action: 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_REQUESTED',
        reason: 'Interrupción antes de dispatch',
      })
      const interruptedIntent = await inbox.acquireManualEffectWithAuditIntent({
        intentId: 'intent-interrupted',
        requestActivityLogId: 'request-interrupted',
        resultActivityLogId: 'result-interrupted',
        actorId: 'staff-root',
        venueId: 'venue-1',
        eventId: 'manual-interrupted',
        reason: 'Interrupción antes de dispatch',
      })

      const pendingBeforeRestart = await sql.query(`
          SELECT id, "dispatchStartedAt", outcome, "deliveredAt"
          FROM "WebhookManualRetryResultOutbox"
          WHERE id IN ('intent-unknown', 'intent-interrupted')
          ORDER BY id
        `)
      clock = new Date(baseClock.getTime() + 16 * 60_000)
      const restartedOutbox = createOutboxWorker('manual-audit-restarted')
      const restartDelivery = await restartedOutbox.deliverDueResults()
      const duplicateDelivery = await restartedOutbox.deliverDueResults()

      const outboxes = await sql.query(`
          SELECT id, "webhookEventId", "actorId", "venueId", "requestActivityLogId", "resultActivityLogId",
                 "effectAttempt", outcome, "deliveredAt"
          FROM "WebhookManualRetryResultOutbox"
          ORDER BY id
        `)
      const audits = await sql.query(`
          SELECT id, "staffId", "venueId", action, "entityId", data
          FROM "ActivityLog"
          ORDER BY id
        `)
      const states = await sql.query(`
          SELECT id, status, "effectAttempts", "retryCount"
          FROM "WebhookEvent" WHERE id LIKE 'manual-%' ORDER BY id
        `)
      const duplicateResultCount = await sql.query(`
          SELECT count(*)::integer AS count FROM "ActivityLog" WHERE id = 'result-success'
        `)

      return {
        success,
        failure: { name: failure.name, code: failure.code, attempt: failure.attempt, auditRecorded: failure.auditRecorded },
        unknown: { name: unknown.name, code: unknown.code, attempt: unknown.attempt, auditPending: unknown.auditPending },
        skipped: { name: skipped.name, code: skipped.code, attempt: skipped.attempt, auditRecorded: skipped.auditRecorded },
        interruptedAttempt: interruptedIntent?.lease.attempt,
        unknownCommitCalls,
        pendingBeforeRestart: pendingBeforeRestart.rows,
        restartDelivery,
        duplicateDelivery,
        outboxes: outboxes.rows,
        audits: audits.rows,
        states: states.rows,
        duplicateResultCount: duplicateResultCount.rows[0].count,
      }
    })

    expect(proof.result.success).toMatchObject({ success: true, phase: 'EFFECT', attempt: 5, auditRecorded: true })
    expect(proof.result.failure).toEqual({
      name: 'WebhookEffectAttemptFailedError',
      code: 'WEBHOOK_EFFECT_ATTEMPT_FAILED',
      attempt: 5,
      auditRecorded: true,
    })
    expect(proof.result.unknown).toEqual({
      name: 'WebhookEffectAttemptFailedError',
      code: 'WEBHOOK_EFFECT_ATTEMPT_FAILED',
      attempt: 5,
      auditPending: true,
    })
    expect(proof.result.skipped).toEqual({
      name: 'WebhookLeaseBusyError',
      code: 'WEBHOOK_LEASE_BUSY',
      attempt: 5,
      auditRecorded: true,
    })
    expect(proof.result.interruptedAttempt).toBe(5)
    expect(proof.result.unknownCommitCalls).toBe(2)
    expect(proof.result.pendingBeforeRestart).toEqual([
      expect.objectContaining({ id: 'intent-interrupted', dispatchStartedAt: null, outcome: null, deliveredAt: null }),
      expect.objectContaining({ id: 'intent-unknown', dispatchStartedAt: expect.any(Date), outcome: null, deliveredAt: null }),
    ])
    expect(proof.result.restartDelivery).toEqual({ claimed: 2, delivered: 2, waiting: 0, failed: 0 })
    expect(proof.result.duplicateDelivery).toEqual({ claimed: 0, delivered: 0, waiting: 0, failed: 0 })
    expect(proof.result.outboxes).toHaveLength(5)
    expect(proof.result.outboxes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'intent-success',
          effectAttempt: 5,
          outcome: 'SUCCEEDED',
          actorId: 'staff-root',
          venueId: 'venue-1',
        }),
        expect.objectContaining({ id: 'intent-failure', effectAttempt: 5, outcome: 'FAILED' }),
        expect.objectContaining({ id: 'intent-skipped', effectAttempt: 5, outcome: 'REJECTED' }),
        expect.objectContaining({ id: 'intent-interrupted', effectAttempt: 5, outcome: 'INTERRUPTED' }),
        expect.objectContaining({ id: 'intent-unknown', effectAttempt: 5, outcome: 'UNKNOWN' }),
      ]),
    )
    expect(proof.result.audits).toHaveLength(10)
    expect(proof.result.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'request-success',
          action: 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_REQUESTED',
          data: expect.objectContaining({
            actorId: 'staff-root',
            venueId: 'venue-1',
            intentId: 'intent-success',
            requestActivityLogId: 'request-success',
            resultActivityLogId: 'result-success',
          }),
        }),
        expect.objectContaining({
          id: 'result-success',
          action: 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_SUCCEEDED',
          data: expect.objectContaining({
            actorId: 'staff-root',
            venueId: 'venue-1',
            attempt: 5,
            code: 'WEBHOOK_EFFECT_RETRY_SUCCEEDED',
          }),
        }),
        expect.objectContaining({ id: 'result-interrupted', action: 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_INTERRUPTED' }),
        expect.objectContaining({ id: 'result-unknown', action: 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_UNKNOWN' }),
      ]),
    )
    expect(proof.result.states.every(row => row.effectAttempts === 5 && row.retryCount === 5)).toBe(true)
    expect(proof.result.duplicateResultCount).toBe(1)
    expect(JSON.stringify(proof.result.audits)).not.toContain('evt_manual')
    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
  })

  it('rolls back the EFFECT claim when a different intent collides on the same event attempt', async () => {
    const proof = await withOrchestratorPrimitivesDatabase(async ({ first, sql, applyA1cMigration, applyA1cCManualRetryMigration }) => {
      await applyA1cMigration()
      await applyA1cCManualRetryMigration()
      await insertAttemptFour(sql, 'manual-collision')
      await sql.query(
        `INSERT INTO "ActivityLog" (id, "staffId", "venueId", action, entity, "entityId", data)
           VALUES
             ('collision-existing-request', 'staff-root', 'venue-1', 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_REQUESTED',
              'WebhookEvent', 'manual-collision', '{}'),
             ('collision-new-request', 'staff-root', 'venue-1', 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_REQUESTED',
              'WebhookEvent', 'manual-collision', '{}')`,
      )
      await sql.query(
        `INSERT INTO "WebhookManualRetryResultOutbox" (
             id, "webhookEventId", "actorId", "venueId", reason,
             "requestActivityLogId", "resultActivityLogId", "effectAttempt", "effectClaimToken", "effectClaimedBy",
             "effectClaimedAt", "effectClaimExpiresAt", "nextAttemptAt", "createdAt", "updatedAt"
           ) VALUES (
             'collision-existing-intent', 'manual-collision', 'staff-root', 'venue-1', 'Existing intent',
             'collision-existing-request', 'collision-existing-result', 5, 'collision-existing-token', 'other-worker',
             $1::timestamp, $2::timestamp, $1::timestamp, $1::timestamp, $1::timestamp
           )`,
        [baseClock, new Date(baseClock.getTime() + 15 * 60_000)],
      )
      const inbox = createPlatformWebhookInboxService({
        repository: createPrismaPlatformWebhookRepository(first),
        workerId: 'collision-worker',
        now: () => new Date(baseClock),
        newClaimToken: () => 'collision-new-token',
      })

      const outcome = await inbox
        .acquireManualEffectWithAuditIntent({
          intentId: 'collision-new-intent',
          requestActivityLogId: 'collision-new-request',
          resultActivityLogId: 'collision-new-result',
          actorId: 'staff-root',
          venueId: 'venue-1',
          eventId: 'manual-collision',
          reason: 'Different intent',
        })
        .then(
          value => ({ value, error: null }),
          error => ({ value: null, error }),
        )
      const state = await sql.query(`
          SELECT status, "effectAttempts", "retryCount", "claimPhase", "claimToken"
          FROM "WebhookEvent" WHERE id = 'manual-collision'
        `)
      const outboxCounts = await sql.query(`
          SELECT
            count(*)::integer AS total,
            count(*) FILTER (WHERE id = 'collision-new-intent')::integer AS "newIntent"
          FROM "WebhookManualRetryResultOutbox" WHERE "webhookEventId" = 'manual-collision'
        `)

      return {
        value: outcome.value,
        errorCode: outcome.error?.meta?.code ?? outcome.error?.code,
        state: state.rows[0],
        outboxCounts: outboxCounts.rows[0],
      }
    })

    expect(proof.result.value).toBeNull()
    expect(proof.result.errorCode).toBe('23505')
    expect(proof.result.state).toEqual({
      status: 'FAILED',
      effectAttempts: 4,
      retryCount: 4,
      claimPhase: null,
      claimToken: null,
    })
    expect(proof.result.outboxCounts).toEqual({ total: 1, newIntent: 0 })
    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
  })
})

describe('P3-1A1c-c PostgreSQL live-demo cleanup', () => {
  it('preserves outbox evidence without retaining Staff/Venue and closes the concurrent delete race by FK', async () => {
    const proof = await withOrchestratorPrimitivesDatabase(
      async ({ first, second, sql, applyA1cMigration, applyA1cCManualRetryMigration }) => {
        await applyA1cMigration()
        await applyA1cCManualRetryMigration()
        const eventIds = ['cleanup-unbound', 'cleanup-binding', 'cleanup-observation', 'cleanup-alert', 'cleanup-outbox']
        for (const eventId of eventIds) {
          await sql.query(
            `INSERT INTO "WebhookEvent" (id, "stripeEventId", "eventType", payload, "venueId", "createdAt", "updatedAt")
             VALUES ($1, $2, 'invoice.paid', $3::jsonb, 'venue-1', $4::timestamp, $4::timestamp)`,
            [eventId, `evt_${eventId}`, JSON.stringify({ id: `evt_${eventId}`, type: 'invoice.paid', data: { object: {} } }), baseClock],
          )
        }
        await sql.query(
          `INSERT INTO "StripeObjectBinding" (
             "objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId", "sourceWebhookEventId"
           ) VALUES (
             'CHECKOUT_SESSION', 'cs_cleanup', 'LEGACY', 'LEGACY_PLAN_CHECKOUT', 'STRIPE_CHECKOUT_ORIGIN', 'origin-1', 'cleanup-binding'
           );
           INSERT INTO "WebhookDispatchObservation" (
             "webhookEventId", "effectAttempt", steps, "effectOutcome", "comparisonCode"
           ) VALUES ('cleanup-observation', 1, '[]', 'SUCCESS', 'CLASSIFICATION_PENDING');
           INSERT INTO "WebhookOperationalAlert" (
             "webhookEventId", phase, "terminalReason", attempt, payload
           ) VALUES (
             'cleanup-alert', 'EFFECT', 'TEST_ALERT', 1,
             '{"webhookEventId":"cleanup-alert","phase":"EFFECT","terminalReason":"TEST_ALERT","attempt":1}'
           );
           INSERT INTO "ActivityLog" (id, "staffId", "venueId", action, entity, "entityId", data)
           VALUES (
             'cleanup-request', 'staff-root', 'venue-1', 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_REQUESTED',
             'WebhookEvent', 'cleanup-outbox',
             '{"phase":"EFFECT","reason":"Cleanup","actorId":"staff-root","venueId":"venue-1","intentId":"cleanup-intent","requestActivityLogId":"cleanup-request","resultActivityLogId":"cleanup-result"}'
           );`,
        )
        await sql.query(
          `INSERT INTO "WebhookManualRetryResultOutbox" (
             id, "webhookEventId", "actorId", "venueId", reason,
             "requestActivityLogId", "resultActivityLogId", "effectAttempt", "effectClaimToken", "effectClaimedBy",
             "effectClaimedAt", "effectClaimExpiresAt", "nextAttemptAt", "createdAt", "updatedAt"
           ) VALUES (
             'cleanup-intent', 'cleanup-outbox', 'staff-root', 'venue-1', 'Cleanup',
             'cleanup-request', 'cleanup-result', 1, 'cleanup-effect-token', 'cleanup-worker',
             $1::timestamp, $2::timestamp, $1::timestamp, $1::timestamp, $1::timestamp
           )`,
          [baseClock, new Date(baseClock.getTime() + 15 * 60_000)],
        )

        const firstCleanup = await first.$transaction(tx => deleteUnboundPlatformWebhookEventsForVenue(tx, 'venue-1'))
        const remainingAfterFirst = await sql.query(`SELECT id FROM "WebhookEvent" ORDER BY id`)

        await sql.query(`DELETE FROM "Venue" WHERE id = 'venue-1'; DELETE FROM "Staff" WHERE id = 'staff-root';`)
        const afterIdentityCleanup = await sql.query(`
          SELECT outbox."actorId", outbox."venueId", event."venueId" AS "eventVenueId", request."staffId" AS "requestStaffId"
          FROM "WebhookManualRetryResultOutbox" outbox
          JOIN "WebhookEvent" event ON event.id = outbox."webhookEventId"
          JOIN "ActivityLog" request ON request.id = outbox."requestActivityLogId"
          WHERE outbox.id = 'cleanup-intent'
        `)

        const cleanupOutbox = createWebhookManualRetryOutboxService({
          repository: createPrismaWebhookManualRetryOutboxRepository(first),
          workerId: 'cleanup-audit-worker',
          now: () => new Date(baseClock.getTime() + 16 * 60_000),
          newClaimToken: () => 'cleanup-delivery-token',
        })
        const delivery = await cleanupOutbox.deliverDueResults()
        const deliveredAudit = await sql.query(`
          SELECT "staffId", "venueId", action, data FROM "ActivityLog" WHERE id = 'cleanup-result'
        `)
        const requestDeleteError = await sql.query(`DELETE FROM "ActivityLog" WHERE id = 'cleanup-request'`).then(
          () => null,
          error => error,
        )

        await sql.query(`
          INSERT INTO "WebhookEvent" (id, "stripeEventId", "eventType", payload, "venueId")
          VALUES (
            'cleanup-race', 'evt_cleanup-race', 'invoice.paid',
            '{"id":"evt_cleanup-race","type":"invoice.paid","data":{"object":{}}}', 'venue-2'
          );
          INSERT INTO "ActivityLog" (id, action, entity, "entityId", data)
          VALUES (
            'cleanup-race-request', 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_REQUESTED', 'WebhookEvent', 'cleanup-race',
            '{"phase":"EFFECT","reason":"Race","actorId":"staff-deleted-snapshot","venueId":"venue-2","intentId":"cleanup-race-intent","requestActivityLogId":"cleanup-race-request","resultActivityLogId":"cleanup-race-result"}'
          );
        `)

        let releaseDelete!: () => void
        let markDeleted!: () => void
        const holdDelete = new Promise<void>(resolve => {
          releaseDelete = resolve
        })
        const deleteReached = new Promise<void>(resolve => {
          markDeleted = resolve
        })
        const deleting = first.$transaction(async tx => {
          const result = await deleteUnboundPlatformWebhookEventsForVenue(tx, 'venue-2')
          markDeleted()
          await holdDelete
          return result
        })
        await deleteReached

        const concurrentOutbox = second.$executeRaw(Prisma.sql`
          INSERT INTO "WebhookManualRetryResultOutbox" (
            id, "webhookEventId", "actorId", "venueId", reason,
            "requestActivityLogId", "resultActivityLogId", "effectAttempt", "effectClaimToken", "effectClaimedBy",
            "effectClaimedAt", "effectClaimExpiresAt", "nextAttemptAt", "createdAt", "updatedAt"
          ) VALUES (
            'cleanup-race-intent', 'cleanup-race', 'staff-deleted-snapshot', 'venue-2', 'Race',
            'cleanup-race-request', 'cleanup-race-result', 1, 'cleanup-race-effect-token', 'cleanup-race-worker',
            ${baseClock.toISOString()}::timestamp, ${new Date(baseClock.getTime() + 15 * 60_000).toISOString()}::timestamp,
            ${baseClock.toISOString()}::timestamp, ${baseClock.toISOString()}::timestamp, ${baseClock.toISOString()}::timestamp
          )
        `)
        await new Promise(resolve => setImmediate(resolve))
        releaseDelete()
        const raceCleanup = await deleting
        const outboxRaceError = await concurrentOutbox.then(
          () => null,
          error => error,
        )
        const raceEvent = await sql.query(`SELECT id FROM "WebhookEvent" WHERE id = 'cleanup-race'`)
        const evidenceCounts = await sql.query(`
          SELECT
            (SELECT count(*)::integer FROM "StripeObjectBinding" WHERE "sourceWebhookEventId" = 'cleanup-binding') AS bindings,
            (SELECT count(*)::integer FROM "WebhookDispatchObservation" WHERE "webhookEventId" = 'cleanup-observation') AS observations,
            (SELECT count(*)::integer FROM "WebhookOperationalAlert" WHERE "webhookEventId" = 'cleanup-alert') AS alerts,
            (SELECT count(*)::integer FROM "WebhookManualRetryResultOutbox" WHERE id = 'cleanup-intent') AS outboxes,
            (SELECT count(*)::integer FROM "Staff" WHERE id = 'staff-root') AS staff,
            (SELECT count(*)::integer FROM "Venue" WHERE id = 'venue-1') AS venues
        `)

        return {
          firstCleanup,
          remainingAfterFirst: remainingAfterFirst.rows.map(row => row.id),
          afterIdentityCleanup: afterIdentityCleanup.rows[0],
          delivery,
          deliveredAudit: deliveredAudit.rows[0],
          requestDeleteErrorCode: requestDeleteError?.code,
          raceCleanup,
          outboxRaceErrorCode: outboxRaceError?.meta?.code ?? outboxRaceError?.code,
          raceEventCount: raceEvent.rowCount,
          evidenceCounts: evidenceCounts.rows[0],
        }
      },
    )

    expect(proof.result.firstCleanup).toEqual({ preserved: 4, deleted: 1 })
    expect(proof.result.remainingAfterFirst).toEqual(['cleanup-alert', 'cleanup-binding', 'cleanup-observation', 'cleanup-outbox'])
    expect(proof.result.afterIdentityCleanup).toEqual({
      actorId: 'staff-root',
      venueId: 'venue-1',
      eventVenueId: null,
      requestStaffId: null,
    })
    expect(proof.result.delivery).toEqual({ claimed: 1, delivered: 1, waiting: 0, failed: 0 })
    expect(proof.result.deliveredAudit).toEqual({
      staffId: null,
      venueId: null,
      action: 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_INTERRUPTED',
      data: expect.objectContaining({ actorId: 'staff-root', venueId: 'venue-1', intentId: 'cleanup-intent' }),
    })
    expect(proof.result.requestDeleteErrorCode).toBe('23503')
    expect(proof.result.raceCleanup).toEqual({ preserved: 0, deleted: 1 })
    expect(proof.result.outboxRaceErrorCode).toBe('23503')
    expect(proof.result.raceEventCount).toBe(0)
    expect(proof.result.evidenceCounts).toEqual({ bindings: 1, observations: 1, alerts: 1, outboxes: 1, staff: 0, venues: 0 })
    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
  })
})
