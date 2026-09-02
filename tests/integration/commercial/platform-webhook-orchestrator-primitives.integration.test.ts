import {
  PLATFORM_WEBHOOK_LIMITS,
  StaleWebhookLeaseError,
  createPlatformWebhookInboxService,
  createPrismaPlatformWebhookRepository,
} from '@/services/stripe-webhooks/platformWebhookInbox.service'
import { withOrchestratorPrimitivesDatabase } from './platform-webhook-orchestrator-primitives-harness'

jest.setTimeout(120_000)

async function rejectedCode(run: () => Promise<unknown>, expected: string) {
  try {
    await run()
    return false
  } catch (error) {
    return (error as { code?: string }).code === expected
  }
}

describe('P3-1A1c-a PostgreSQL migration and runtime primitives', () => {
  it('normalizes history, installs the strict legacy projection, append-only evidence and the stable CHECK', async () => {
    const proof = await withOrchestratorPrimitivesDatabase(async ({ sql, applyA1cMigration }) => {
      await sql.query(`
        INSERT INTO "WebhookEvent" (
          id, "stripeEventId", "eventType", payload, status, "retryCount", "effectAttempts", "effectNextAttemptAt", "createdAt"
        ) VALUES
          ('historic-success', 'evt_h_success', 'invoice.paid', '{"id":"evt_h_success","type":"invoice.paid"}', 'SUCCESS', 2, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ('historic-pending', 'evt_h_pending', 'invoice.paid', '{"id":"evt_h_pending","type":"invoice.paid"}', 'PENDING', 0, 9, NULL, CURRENT_TIMESTAMP),
          ('historic-failed-4', 'evt_h_failed4', 'invoice.paid', '{"id":"evt_h_failed4","type":"invoice.paid"}', 'FAILED', 4, 1, NULL, CURRENT_TIMESTAMP),
          ('historic-failed-5', 'evt_h_failed5', 'invoice.paid', '{"id":"evt_h_failed5","type":"invoice.paid"}', 'FAILED', 5, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ('historic-retrying-5', 'evt_h_retry5', 'invoice.paid', '{"id":"evt_h_retry5","type":"invoice.paid"}', 'RETRYING', 5, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ('historic-retrying-6', 'evt_h_retry6', 'invoice.paid', '{"id":"evt_h_retry6","type":"invoice.paid"}', 'RETRYING', 6, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `)

      await applyA1cMigration()

      const rows = await sql.query(`
        SELECT id, status, "retryCount", "effectAttempts", "effectNextAttemptAt"
        FROM "WebhookEvent" WHERE id LIKE 'historic-%' ORDER BY id
      `)
      const overBudgetAlerts = await sql.query(`
        SELECT "webhookEventId", phase, "terminalReason", attempt, payload
        FROM "WebhookOperationalAlert" ORDER BY "webhookEventId"
      `)
      const databaseLimit = await sql.query(`SELECT avoqado_webhook_max_attempts() AS value`)

      await sql.query(`
        INSERT INTO "WebhookEvent" (id, "stripeEventId", "eventType", payload)
        VALUES ('legacy-trigger', 'evt_legacy_trigger', 'invoice.paid', '{"id":"evt_legacy_trigger","type":"invoice.paid"}')
      `)
      await sql.query(`UPDATE "WebhookEvent" SET status = 'FAILED', "retryCount" = "retryCount" + 1 WHERE id = 'legacy-trigger'`)
      const firstFailure = await sql.query(`
        SELECT status, "retryCount", "effectAttempts", "effectNextAttemptAt" IS NOT NULL AS due
        FROM "WebhookEvent" WHERE id = 'legacy-trigger'
      `)
      await sql.query(`UPDATE "WebhookEvent" SET status = 'RETRYING', "retryCount" = "retryCount" + 1 WHERE id = 'legacy-trigger'`)
      await sql.query(`UPDATE "WebhookEvent" SET status = 'FAILED' WHERE id = 'legacy-trigger'`)
      const laterFailure = await sql.query(`
        SELECT status, "retryCount", "effectAttempts", "effectNextAttemptAt" IS NOT NULL AS due
        FROM "WebhookEvent" WHERE id = 'legacy-trigger'
      `)
      const dueBeforeVenue = laterFailure.rows[0]
      await sql.query(`UPDATE "WebhookEvent" SET "venueId" = 'venue-1' WHERE id = 'legacy-trigger'`)
      const venueOnly = await sql.query(`
        SELECT status, "retryCount", "effectAttempts", "effectNextAttemptAt" IS NOT NULL AS due, "venueId"
        FROM "WebhookEvent" WHERE id = 'legacy-trigger'
      `)
      await sql.query(`UPDATE "WebhookEvent" SET status = 'RETRYING', "retryCount" = "retryCount" + 1 WHERE id = 'legacy-trigger'`)
      await sql.query(`UPDATE "WebhookEvent" SET status = 'SUCCESS' WHERE id = 'legacy-trigger'`)
      const success = await sql.query(`
        SELECT status, "retryCount", "effectAttempts", "effectNextAttemptAt" IS NULL AS terminal
        FROM "WebhookEvent" WHERE id = 'legacy-trigger'
      `)

      const explicitInvalidProjectionRejected = await rejectedCode(
        () =>
          sql.query(`
            UPDATE "WebhookEvent"
            SET status = 'FAILED', "effectAttempts" = 2, "retryCount" = 2,
                "effectNextAttemptAt" = NULL, "claimToken" = 'explicit-new-write'
            WHERE id = 'legacy-trigger'
          `),
        '23514',
      )

      const invalidProjectionUpdates = [
        `status = 'FAILED', "retryCount" = 1, "effectAttempts" = 0, "effectNextAttemptAt" = CURRENT_TIMESTAMP`,
        `status = 'SUCCESS', "retryCount" = 0, "effectAttempts" = 0, "effectNextAttemptAt" = CURRENT_TIMESTAMP`,
        `status = 'PENDING', "retryCount" = 5, "effectAttempts" = 5, "effectNextAttemptAt" = CURRENT_TIMESTAMP`,
        `status = 'PENDING', "retryCount" = 0, "effectAttempts" = 0, "effectNextAttemptAt" = NULL`,
        `status = 'RETRYING', "retryCount" = 0, "effectAttempts" = 0, "effectNextAttemptAt" = CURRENT_TIMESTAMP`,
        `status = 'RETRYING', "retryCount" = 6, "effectAttempts" = 6, "effectNextAttemptAt" = CURRENT_TIMESTAMP`,
        `status = 'FAILED', "retryCount" = 4, "effectAttempts" = 4, "effectNextAttemptAt" = NULL`,
        `status = 'FAILED', "retryCount" = 5, "effectAttempts" = 5, "effectNextAttemptAt" = CURRENT_TIMESTAMP`,
      ]
      const invalidProjectionMatrixRejected: boolean[] = []
      for (let index = 0; index < invalidProjectionUpdates.length; index++) {
        await sql.query(
          `INSERT INTO "WebhookEvent" (id, "stripeEventId", "eventType", payload)
           VALUES ($1, $2, 'invoice.paid', $3::jsonb)`,
          [
            `invalid-projection-${index}`,
            `evt_invalid_projection_${index}`,
            JSON.stringify({ id: `evt_invalid_projection_${index}`, type: 'invoice.paid' }),
          ],
        )
        invalidProjectionMatrixRejected.push(
          await rejectedCode(
            () =>
              sql.query(`
                UPDATE "WebhookEvent"
                SET ${invalidProjectionUpdates[index]},
                    "claimPhase" = 'EFFECT', "claimToken" = 'explicit-${index}', "claimedBy" = 'matrix-worker',
                    "claimedAt" = CURRENT_TIMESTAMP, "claimExpiresAt" = CURRENT_TIMESTAMP + interval '1 hour'
                WHERE id = 'invalid-projection-${index}'
              `),
            '23514',
          ),
        )
      }

      await sql.query(`
        INSERT INTO "WebhookDispatchObservation" (
          "webhookEventId", "effectAttempt", steps, "effectOutcome", "comparisonCode"
        ) VALUES (
          'legacy-trigger', 2, '[]', 'SUCCESS', 'CLASSIFICATION_PENDING'
        )
      `)
      const observationUpdateRejected = await rejectedCode(
        () =>
          sql.query(
            `UPDATE "WebhookDispatchObservation" SET "comparisonCode" = 'MATCH' WHERE "webhookEventId" = 'legacy-trigger' AND "effectAttempt" = 2`,
          ),
        '55000',
      )
      const observationDeleteRejected = await rejectedCode(
        () => sql.query(`DELETE FROM "WebhookDispatchObservation" WHERE "webhookEventId" = 'legacy-trigger' AND "effectAttempt" = 2`),
        '55000',
      )

      const migratedAlert = overBudgetAlerts.rows[0]
      await sql.query(`
        UPDATE "WebhookOperationalAlert"
        SET "deliveryAttempts" = 1, "nextAttemptAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "webhookEventId" = 'historic-retrying-6'
      `)
      const alertAuthorityUpdateRejected = await rejectedCode(
        () =>
          sql.query(`
            UPDATE "WebhookOperationalAlert" SET "terminalReason" = 'CHANGED'
            WHERE "webhookEventId" = 'historic-retrying-6'
          `),
        '55000',
      )
      const alertDeleteRejected = await rejectedCode(
        () => sql.query(`DELETE FROM "WebhookOperationalAlert" WHERE "webhookEventId" = 'historic-retrying-6'`),
        '55000',
      )

      const triggerNames = await sql.query(`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid IN ('"WebhookEvent"'::regclass, '"WebhookDispatchObservation"'::regclass,
                          '"WebhookOperationalAlert"'::regclass) AND NOT tgisinternal
        ORDER BY tgname
      `)
      const constraint = await sql.query(`
        SELECT conname FROM pg_constraint
        WHERE conrelid = '"WebhookEvent"'::regclass AND conname = 'WebhookEvent_effect_projection_v1_check'
      `)

      return {
        rows: rows.rows,
        overBudgetAlerts: overBudgetAlerts.rows,
        databaseLimit: databaseLimit.rows[0].value,
        firstFailure: firstFailure.rows[0],
        laterFailure: laterFailure.rows[0],
        dueBeforeVenue,
        venueOnly: venueOnly.rows[0],
        success: success.rows[0],
        explicitInvalidProjectionRejected,
        invalidProjectionMatrixRejected,
        observationUpdateRejected,
        observationDeleteRejected,
        migratedAlert,
        alertAuthorityUpdateRejected,
        alertDeleteRejected,
        triggerNames: triggerNames.rows.map(row => row.tgname),
        constraintPresent: constraint.rowCount === 1,
      }
    })

    expect(proof.result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'historic-success', status: 'SUCCESS', retryCount: 2, effectAttempts: 2, effectNextAttemptAt: null }),
        expect.objectContaining({
          id: 'historic-pending',
          status: 'PENDING',
          retryCount: 0,
          effectAttempts: 0,
          effectNextAttemptAt: expect.any(Date),
        }),
        expect.objectContaining({
          id: 'historic-failed-4',
          status: 'FAILED',
          retryCount: 4,
          effectAttempts: 4,
          effectNextAttemptAt: expect.any(Date),
        }),
        expect.objectContaining({ id: 'historic-failed-5', status: 'FAILED', retryCount: 5, effectAttempts: 5, effectNextAttemptAt: null }),
        expect.objectContaining({
          id: 'historic-retrying-5',
          status: 'RETRYING',
          retryCount: 5,
          effectAttempts: 5,
          effectNextAttemptAt: expect.any(Date),
        }),
        expect.objectContaining({
          id: 'historic-retrying-6',
          status: 'FAILED',
          retryCount: 6,
          effectAttempts: 6,
          effectNextAttemptAt: null,
        }),
      ]),
    )
    expect(proof.result.overBudgetAlerts).toHaveLength(1)
    expect(proof.result.overBudgetAlerts[0]).toMatchObject({
      webhookEventId: 'historic-retrying-6',
      phase: 'EFFECT',
      terminalReason: 'LEGACY_EFFECT_ATTEMPTS_OVER_BUDGET',
      attempt: 6,
    })
    expect(Number(proof.result.databaseLimit)).toBe(PLATFORM_WEBHOOK_LIMITS.maxAttempts)
    expect(proof.result.firstFailure).toEqual({ status: 'FAILED', retryCount: 1, effectAttempts: 1, due: true })
    expect(proof.result.laterFailure).toEqual({ status: 'FAILED', retryCount: 2, effectAttempts: 2, due: true })
    expect(proof.result.venueOnly).toEqual({ ...proof.result.dueBeforeVenue, venueId: 'venue-1' })
    expect(proof.result.success).toEqual({ status: 'SUCCESS', retryCount: 3, effectAttempts: 3, terminal: true })
    expect(proof.result).toMatchObject({
      explicitInvalidProjectionRejected: true,
      observationUpdateRejected: true,
      observationDeleteRejected: true,
      alertAuthorityUpdateRejected: true,
      alertDeleteRejected: true,
      constraintPresent: true,
    })
    expect(proof.result.invalidProjectionMatrixRejected).toEqual(Array(8).fill(true))
    expect(proof.result.triggerNames).toEqual(
      expect.arrayContaining([
        'webhook_dispatch_observation_append_only',
        'webhook_event_legacy_effect_projection_v1',
        'webhook_operational_alert_delivery_only',
      ]),
    )
    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
  })

  it('accepts only the frozen legacy transition matrix and rejects budget rewinds, jumps and terminal reopening', async () => {
    const proof = await withOrchestratorPrimitivesDatabase(async ({ sql, applyA1cMigration }) => {
      await applyA1cMigration()

      const insertEvent = async (id: string, status: 'PENDING' | 'FAILED' | 'RETRYING' | 'SUCCESS', attempt: number) => {
        await sql.query(
          `INSERT INTO "WebhookEvent" (
             id, "stripeEventId", "eventType", payload, status, "retryCount", "effectAttempts", "effectNextAttemptAt"
           ) VALUES ($1, $2, 'invoice.upcoming', $3::jsonb, $4::"WebhookEventStatus", $5, $5,
             CASE WHEN $4 = 'SUCCESS' OR ($4 = 'FAILED' AND $5 >= 5) THEN NULL ELSE CURRENT_TIMESTAMP END)`,
          [id, `evt_${id}`, JSON.stringify({ id: `evt_${id}`, type: 'invoice.upcoming', data: { object: {} } }), status, attempt],
        )
      }

      const rejectedMessage = async (statement: string) => {
        try {
          await sql.query(statement)
          return null
        } catch (error) {
          return String((error as Error).message)
        }
      }

      await insertEvent('legacy-decrement', 'FAILED', 4)
      await insertEvent('legacy-jump', 'FAILED', 2)
      await insertEvent('legacy-success-reopen', 'SUCCESS', 2)
      await insertEvent('legacy-terminal-reopen', 'FAILED', 5)
      await insertEvent('legacy-unknown-pending', 'PENDING', 1)
      await insertEvent('legacy-over-budget', 'FAILED', 5)

      const invalidMessages = {
        decrement: await rejectedMessage(`UPDATE "WebhookEvent" SET "retryCount" = 3 WHERE id = 'legacy-decrement'`),
        jump: await rejectedMessage(`UPDATE "WebhookEvent" SET status = 'RETRYING', "retryCount" = 4 WHERE id = 'legacy-jump'`),
        successReopen: await rejectedMessage(`UPDATE "WebhookEvent" SET status = 'FAILED' WHERE id = 'legacy-success-reopen'`),
        terminalReopen: await rejectedMessage(`UPDATE "WebhookEvent" SET status = 'RETRYING' WHERE id = 'legacy-terminal-reopen'`),
        unknownPending: await rejectedMessage(
          `UPDATE "WebhookEvent" SET status = 'PENDING', "retryCount" = 2 WHERE id = 'legacy-unknown-pending'`,
        ),
        overBudget: await rejectedMessage(
          `UPDATE "WebhookEvent" SET status = 'RETRYING', "retryCount" = 6 WHERE id = 'legacy-over-budget'`,
        ),
      }

      const permitted = [
        { id: 'allowed-pending-retrying', oldStatus: 'PENDING', oldAttempt: 0, status: 'RETRYING', attempt: 1 },
        { id: 'allowed-failed-retrying', oldStatus: 'FAILED', oldAttempt: 1, status: 'RETRYING', attempt: 2 },
        { id: 'allowed-retrying-retrying', oldStatus: 'RETRYING', oldAttempt: 2, status: 'RETRYING', attempt: 3 },
        { id: 'allowed-pending-failed', oldStatus: 'PENDING', oldAttempt: 0, status: 'FAILED', attempt: 1 },
        { id: 'allowed-retrying-failed', oldStatus: 'RETRYING', oldAttempt: 3, status: 'FAILED', attempt: 3 },
        { id: 'allowed-pending-success', oldStatus: 'PENDING', oldAttempt: 0, status: 'SUCCESS', attempt: 0 },
        { id: 'allowed-retrying-success', oldStatus: 'RETRYING', oldAttempt: 4, status: 'SUCCESS', attempt: 4 },
        { id: 'allowed-failed-error-only', oldStatus: 'FAILED', oldAttempt: 2, status: 'FAILED', attempt: 2 },
      ] as const

      for (const transition of permitted) {
        await insertEvent(transition.id, transition.oldStatus, transition.oldAttempt)
        await sql.query(
          `UPDATE "WebhookEvent"
           SET status = $2::"WebhookEventStatus", "retryCount" = $3, "errorMessage" = 'legacy writer'
           WHERE id = $1`,
          [transition.id, transition.status, transition.attempt],
        )
      }

      const allowedRows = await sql.query(
        `SELECT id, status, "retryCount", "effectAttempts", "effectNextAttemptAt" IS NULL AS terminal
         FROM "WebhookEvent" WHERE id LIKE 'allowed-%' ORDER BY id`,
      )
      const invalidRows = await sql.query(
        `SELECT id, status, "retryCount", "effectAttempts"
         FROM "WebhookEvent" WHERE id LIKE 'legacy-%' ORDER BY id`,
      )

      return { invalidMessages, allowedRows: allowedRows.rows, invalidRows: invalidRows.rows }
    })

    expect(proof.result.invalidMessages).toEqual({
      decrement: expect.stringContaining('AVQ_WEBHOOK_LEGACY_TRANSITION_INVALID'),
      jump: expect.stringContaining('AVQ_WEBHOOK_LEGACY_TRANSITION_INVALID'),
      successReopen: expect.stringContaining('AVQ_WEBHOOK_LEGACY_TRANSITION_INVALID'),
      terminalReopen: expect.stringContaining('AVQ_WEBHOOK_LEGACY_TRANSITION_INVALID'),
      unknownPending: expect.stringContaining('AVQ_WEBHOOK_LEGACY_TRANSITION_INVALID'),
      overBudget: expect.stringContaining('AVQ_WEBHOOK_EFFECT_BUDGET_EXHAUSTED'),
    })
    expect(proof.result.invalidRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'legacy-decrement', status: 'FAILED', retryCount: 4, effectAttempts: 4 }),
        expect.objectContaining({ id: 'legacy-jump', status: 'FAILED', retryCount: 2, effectAttempts: 2 }),
        expect.objectContaining({ id: 'legacy-success-reopen', status: 'SUCCESS', retryCount: 2, effectAttempts: 2 }),
        expect.objectContaining({ id: 'legacy-terminal-reopen', status: 'FAILED', retryCount: 5, effectAttempts: 5 }),
      ]),
    )
    expect(proof.result.allowedRows).toEqual(
      expect.arrayContaining([
        { id: 'allowed-pending-retrying', status: 'RETRYING', retryCount: 1, effectAttempts: 1, terminal: false },
        { id: 'allowed-failed-retrying', status: 'RETRYING', retryCount: 2, effectAttempts: 2, terminal: false },
        { id: 'allowed-retrying-retrying', status: 'RETRYING', retryCount: 3, effectAttempts: 3, terminal: false },
        { id: 'allowed-pending-failed', status: 'FAILED', retryCount: 1, effectAttempts: 1, terminal: false },
        { id: 'allowed-retrying-failed', status: 'FAILED', retryCount: 3, effectAttempts: 3, terminal: false },
        { id: 'allowed-pending-success', status: 'SUCCESS', retryCount: 0, effectAttempts: 0, terminal: true },
        { id: 'allowed-retrying-success', status: 'SUCCESS', retryCount: 4, effectAttempts: 4, terminal: true },
        { id: 'allowed-failed-error-only', status: 'FAILED', retryCount: 2, effectAttempts: 2, terminal: false },
      ]),
    )
    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
  })

  it('claims ordered batches without overlap and enforces shared leases, attempt-five terminalization and durable alerts', async () => {
    const proof = await withOrchestratorPrimitivesDatabase(async ({ first, second, sql, applyA1cMigration }) => {
      await applyA1cMigration()
      const base = new Date()
      for (let index = 0; index < 40; index++) {
        const due = new Date(base.getTime() + index * 1_000)
        await sql.query(
          `INSERT INTO "WebhookEvent" (id, "stripeEventId", "eventType", payload, "createdAt", "effectNextAttemptAt", "classificationNextAttemptAt")
           VALUES ($1, $2, 'invoice.paid', $3::jsonb, $4, $4, $4)`,
          [
            `batch-${String(index).padStart(2, '0')}`,
            `evt_batch_${index}`,
            JSON.stringify({ id: `evt_batch_${index}`, type: 'invoice.paid' }),
            due,
          ],
        )
      }
      const claimAt = new Date(base.getTime() + 60_000)
      const workerA = createPlatformWebhookInboxService({
        repository: createPrismaPlatformWebhookRepository(first),
        workerId: 'worker-a',
        now: () => claimAt,
        newClaimToken: () => 'batch-a',
      })
      const workerB = createPlatformWebhookInboxService({
        repository: createPrismaPlatformWebhookRepository(second),
        workerId: 'worker-b',
        now: () => claimAt,
        newClaimToken: () => 'batch-b',
      })

      const [batchA, batchB] = await Promise.all([workerA.acquireBatch('EFFECT'), workerB.acquireBatch('EFFECT')])
      const idsA = batchA.map(row => row.eventId)
      const idsB = batchB.map(row => row.eventId)

      await sql.query(`
        INSERT INTO "WebhookEvent" (
          id, "stripeEventId", "eventType", payload, status, "retryCount", "effectAttempts", "effectNextAttemptAt",
          "classificationNextAttemptAt"
        ) VALUES (
          'attempt-five', 'evt_attempt_five', 'invoice.paid', '{"id":"evt_attempt_five","type":"invoice.paid"}',
          'FAILED', 4, 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `)
      const fifth = await workerA.acquire('attempt-five', 'EFFECT', { manual: true })
      const otherPhaseBlocked = await workerB.acquire('attempt-five', 'CLASSIFICATION', { manual: true })
      await workerA.retry(fifth!, { code: 'DISPATCH_FAILED', message: 'closed code only' })
      const terminal = await sql.query(`
        SELECT status, "retryCount", "effectAttempts", "effectNextAttemptAt", "claimPhase"
        FROM "WebhookEvent" WHERE id = 'attempt-five'
      `)
      const terminalAlerts = await sql.query(`
        SELECT "webhookEventId", phase, "terminalReason", attempt, payload
        FROM "WebhookOperationalAlert" WHERE "webhookEventId" = 'attempt-five'
      `)
      const observationCreated = await workerA.recordDispatchObservation({
        webhookEventId: 'attempt-five',
        effectAttempt: 5,
        steps: [{ step: 'COMMERCIAL_ADAPTER', outcome: 'NOT_MATCHED' }],
        effectOutcome: 'FAILED',
        failureStep: 'COMMERCIAL_ADAPTER',
        comparisonCode: 'CLASSIFICATION_PENDING',
      })
      const observationExisting = await workerB.recordDispatchObservation({
        webhookEventId: 'attempt-five',
        effectAttempt: 5,
        steps: [{ step: 'COMMERCIAL_ADAPTER', outcome: 'NOT_MATCHED' }],
        effectOutcome: 'FAILED',
        failureStep: 'COMMERCIAL_ADAPTER',
        comparisonCode: 'CLASSIFICATION_PENDING',
      })
      let observationConflict = false
      try {
        await workerB.recordDispatchObservation({
          webhookEventId: 'attempt-five',
          effectAttempt: 5,
          steps: [],
          effectOutcome: 'SUCCESS',
          comparisonCode: 'MATCH',
        })
      } catch {
        observationConflict = true
      }
      const observationCount = await sql.query(`
        SELECT count(*)::integer AS count FROM "WebhookDispatchObservation"
        WHERE "webhookEventId" = 'attempt-five' AND "effectAttempt" = 5
      `)

      await sql.query(`
        INSERT INTO "WebhookEvent" (
          id, "stripeEventId", "eventType", payload, status, "retryCount", "effectAttempts", "effectNextAttemptAt",
          "classificationAttempts", "classificationNextAttemptAt"
        ) VALUES (
          'classification-terminal', 'evt_class_terminal', 'invoice.paid', '{"id":"evt_class_terminal","type":"invoice.paid"}',
          'PENDING', 0, 0, CURRENT_TIMESTAMP, 5, CURRENT_TIMESTAMP
        )
      `)
      const liveEffect = await workerA.acquire('classification-terminal', 'EFFECT', { manual: true })
      const classificationTerminal = await workerB.terminalizeExhausted('CLASSIFICATION', 'classification-terminal')
      const preservedOtherLease = await sql.query(`
        SELECT "classificationState", "classificationNextAttemptAt", "claimPhase", "claimToken"
        FROM "WebhookEvent" WHERE id = 'classification-terminal'
      `)

      const alerts = await workerB.claimOperationalAlerts()
      const attemptAlert = alerts.find(row => row.webhookEventId === 'attempt-five')!
      await workerB.acknowledgeOperationalAlert(attemptAlert)
      const delivered = await sql.query(
        `
        SELECT "deliveredAt", "claimToken" FROM "WebhookOperationalAlert"
        WHERE "webhookEventId" = $1 AND phase = $2::"WebhookClaimPhase" AND "terminalReason" = $3
      `,
        [attemptAlert.webhookEventId, attemptAlert.phase, attemptAlert.terminalReason],
      )

      return {
        idsA,
        idsB,
        batchALength: batchA.length,
        batchBLength: batchB.length,
        otherPhaseBlocked,
        terminal: terminal.rows[0],
        terminalAlerts: terminalAlerts.rows,
        observationCreated: observationCreated.status,
        observationExisting: observationExisting.status,
        observationConflict,
        observationCount: observationCount.rows[0].count,
        classificationTerminal,
        liveEffect,
        preservedOtherLease: preservedOtherLease.rows[0],
        delivered: delivered.rows[0],
      }
    })

    expect(proof.result.batchALength).toBeLessThanOrEqual(25)
    expect(proof.result.batchBLength).toBeLessThanOrEqual(25)
    expect(new Set([...proof.result.idsA, ...proof.result.idsB]).size).toBe(40)
    expect(proof.result.idsA.some(id => proof.result.idsB.includes(id))).toBe(false)
    expect([proof.result.batchALength, proof.result.batchBLength].sort((a, b) => a - b)).toEqual([15, 25])
    expect(proof.result.idsA).toEqual([...proof.result.idsA].sort())
    expect(proof.result.idsB).toEqual([...proof.result.idsB].sort())
    expect(proof.result.otherPhaseBlocked).toBeNull()
    expect(proof.result.terminal).toEqual({
      status: 'FAILED',
      retryCount: 5,
      effectAttempts: 5,
      effectNextAttemptAt: null,
      claimPhase: null,
    })
    expect(proof.result.terminalAlerts).toHaveLength(1)
    expect(proof.result.terminalAlerts[0]).toMatchObject({
      webhookEventId: 'attempt-five',
      phase: 'EFFECT',
      terminalReason: 'EFFECT_ATTEMPTS_EXHAUSTED',
      attempt: 5,
    })
    expect(proof.result).toMatchObject({
      observationCreated: 'CREATED',
      observationExisting: 'EXISTING',
      observationConflict: true,
      observationCount: 1,
    })
    expect(proof.result.classificationTerminal).toHaveLength(1)
    expect(proof.result.preservedOtherLease).toMatchObject({
      classificationState: 'UNRESOLVED',
      classificationNextAttemptAt: null,
      claimPhase: 'EFFECT',
      claimToken: proof.result.liveEffect?.claimToken,
    })
    expect(proof.result.delivered).toMatchObject({ deliveredAt: expect.any(Date), claimToken: null })
    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
  })

  it('aborts the concurrent sixth legacy replay before dispatch and creates one terminal alert only after the fifth owner fails', async () => {
    const proof = await withOrchestratorPrimitivesDatabase(async ({ first, second, sql, applyA1cMigration }) => {
      await applyA1cMigration()
      await sql.query(`
        INSERT INTO "WebhookEvent" (
          id, "stripeEventId", "eventType", payload, status, "retryCount", "effectAttempts", "effectNextAttemptAt"
        ) VALUES (
          'legacy-race', 'evt_legacy_race', 'invoice.paid', '{"id":"evt_legacy_race","type":"invoice.paid"}',
          'FAILED', 4, 4, CURRENT_TIMESTAMP
        )
      `)

      let readers = 0
      let releaseReaders!: () => void
      const bothRead = new Promise<void>(resolve => {
        releaseReaders = resolve
      })
      let dispatches = 0

      async function legacyReplay(client: typeof first) {
        const row = await client.webhookEvent.findUniqueOrThrow({ where: { id: 'legacy-race' }, select: { retryCount: true } })
        expect(row.retryCount).toBe(4)
        readers++
        if (readers === 2) releaseReaders()
        await bothRead
        await client.webhookEvent.update({
          where: { id: 'legacy-race' },
          data: { status: 'RETRYING', retryCount: { increment: 1 } },
        })
        dispatches++
      }

      const outcomes = await Promise.allSettled([legacyReplay(first), legacyReplay(second)])
      const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult
      const beforeOwnerFailure = await sql.query(`
        SELECT status, "retryCount", "effectAttempts", "effectNextAttemptAt", "claimPhase"
        FROM "WebhookEvent" WHERE id = 'legacy-race'
      `)
      const alertsBeforeFailure = await sql.query(
        `SELECT count(*)::integer AS count FROM "WebhookOperationalAlert" WHERE "webhookEventId" = 'legacy-race'`,
      )

      await first.webhookEvent.update({ where: { id: 'legacy-race' }, data: { status: 'FAILED', errorMessage: 'owner failed' } })
      const afterOwnerFailure = await sql.query(`
        SELECT status, "retryCount", "effectAttempts", "effectNextAttemptAt"
        FROM "WebhookEvent" WHERE id = 'legacy-race'
      `)
      const alertsAfterFailure = await sql.query(`
        SELECT "terminalReason", attempt FROM "WebhookOperationalAlert" WHERE "webhookEventId" = 'legacy-race'
      `)

      return {
        fulfilled: outcomes.filter(result => result.status === 'fulfilled').length,
        rejectedMessage: String(rejected?.reason?.message ?? rejected?.reason),
        dispatches,
        beforeOwnerFailure: beforeOwnerFailure.rows[0],
        alertsBeforeFailure: alertsBeforeFailure.rows[0].count,
        afterOwnerFailure: afterOwnerFailure.rows[0],
        alertsAfterFailure: alertsAfterFailure.rows,
      }
    })

    expect(proof.result.fulfilled).toBe(1)
    expect(proof.result.dispatches).toBe(1)
    expect(proof.result.rejectedMessage).toContain('AVQ_WEBHOOK_EFFECT_BUDGET_EXHAUSTED')
    expect(proof.result.beforeOwnerFailure).toEqual({
      status: 'RETRYING',
      retryCount: 5,
      effectAttempts: 5,
      effectNextAttemptAt: expect.any(Date),
      claimPhase: null,
    })
    expect(proof.result.alertsBeforeFailure).toBe(0)
    expect(proof.result.afterOwnerFailure).toEqual({ status: 'FAILED', retryCount: 5, effectAttempts: 5, effectNextAttemptAt: null })
    expect(proof.result.alertsAfterFailure).toEqual([{ terminalReason: 'EFFECT_ATTEMPTS_EXHAUSTED', attempt: 5 }])
    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
  })

  it('runs the real replay export and Superadmin caller concurrently without letting the budget loser overwrite SUCCESS', async () => {
    const proof = await withOrchestratorPrimitivesDatabase(
      async ({ second, sql, databaseUrl, applyA1cMigration, applyA1cCManualRetryMigration }) => {
        await applyA1cMigration()
        await applyA1cCManualRetryMigration()
        await sql.query(`
          CREATE TABLE "ReplayDispatchProbe" ("webhookEventId" TEXT PRIMARY KEY);
          CREATE FUNCTION record_real_replay_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            INSERT INTO "ReplayDispatchProbe" ("webhookEventId") VALUES (NEW.id) ON CONFLICT DO NOTHING;
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER record_real_replay_dispatch
          AFTER UPDATE ON "WebhookEvent"
          FOR EACH ROW
          WHEN (OLD.status = 'RETRYING' AND NEW.status = 'SUCCESS')
          EXECUTE FUNCTION record_real_replay_dispatch();

          INSERT INTO "WebhookEvent" (
            id, "stripeEventId", "eventType", payload, status, "retryCount", "effectAttempts", "effectNextAttemptAt"
          ) VALUES (
            'real-replay-race', 'evt_real_replay_race', 'invoice.upcoming',
            '{"id":"evt_real_replay_race","type":"invoice.upcoming","created":1787522400,"data":{"object":{}}}',
            'FAILED', 4, 4, CURRENT_TIMESTAMP
          );
        `)

        const previousDatabaseUrl = process.env.DATABASE_URL
        let runtimePrisma: any

        try {
          process.env.DATABASE_URL = databaseUrl
          jest.resetModules()
          runtimePrisma = (await import('@/utils/prismaClient')).default
          const { replayStripeWebhookEvent } = await import('@/services/stripe.webhook.service')
          const { retryWebhookEvent } = await import('@/services/superadmin/webhook.superadmin.service')

          const superadminOutcome = retryWebhookEvent('real-replay-race', {
            actorId: 'staff-root',
            reason: 'Carrera controlada replay contra Superadmin',
          }).then(
            value => ({ status: 'fulfilled' as const, value }),
            reason => ({ status: 'rejected' as const, reason }),
          )
          const directOutcome = replayStripeWebhookEvent('real-replay-race').then(
            value => ({ status: 'fulfilled' as const, value }),
            reason => ({ status: 'rejected' as const, reason }),
          )

          const [direct, superadmin] = await Promise.all([directOutcome, superadminOutcome])
          const final = await second.webhookEvent.findUniqueOrThrow({
            where: { id: 'real-replay-race' },
            select: {
              status: true,
              retryCount: true,
              effectAttempts: true,
              effectNextAttemptAt: true,
              processedAt: true,
            },
          })
          const alerts = await sql.query(
            `SELECT count(*)::integer AS count FROM "WebhookOperationalAlert" WHERE "webhookEventId" = 'real-replay-race'`,
          )
          const dispatches = await sql.query(
            `SELECT count(*)::integer AS count FROM "ReplayDispatchProbe" WHERE "webhookEventId" = 'real-replay-race'`,
          )

          return {
            directStatus: direct.status,
            directValue: direct.status === 'fulfilled' ? direct.value : null,
            superadminStatus: superadmin.status,
            superadminValue: superadmin.status === 'fulfilled' ? superadmin.value : null,
            superadminError: superadmin.status === 'rejected' ? String((superadmin.reason as Error).message ?? superadmin.reason) : null,
            superadminErrorCode: superadmin.status === 'rejected' ? ((superadmin.reason as { code?: string }).code ?? null) : null,
            final,
            alerts: alerts.rows[0].count,
            dispatches: dispatches.rows[0].count,
          }
        } finally {
          await runtimePrisma?.$disconnect()
          if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
          else process.env.DATABASE_URL = previousDatabaseUrl
          jest.resetModules()
        }
      },
    )

    expect(proof.result).toMatchObject({
      directStatus: 'fulfilled',
      final: {
        status: 'SUCCESS',
        retryCount: 5,
        effectAttempts: 5,
        effectNextAttemptAt: null,
        processedAt: expect.any(Date),
      },
      alerts: 0,
      dispatches: 1,
    })
    const replayWon = proof.result.directValue?.replayed === true
    const superadminWon = proof.result.superadminStatus === 'fulfilled' && proof.result.superadminValue?.success === true
    expect(Number(replayWon) + Number(superadminWon)).toBe(1)
    if (proof.result.superadminStatus === 'rejected') {
      expect(['WEBHOOK_LEASE_BUSY', 'WEBHOOK_EFFECT_NOT_RETRYABLE']).toContain(proof.result.superadminErrorCode)
      expect(proof.result.superadminError).not.toContain('TypeError')
    } else if (!superadminWon) {
      expect(proof.result.superadminValue).toMatchObject({ success: false })
    }
    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
  })

  it('recovers expired claims without ABA, handles fifth-attempt success/crash and re-delivers an alert after log-before-ack crash', async () => {
    const proof = await withOrchestratorPrimitivesDatabase(async ({ first, second, sql, applyA1cMigration }) => {
      await applyA1cMigration()
      const base = new Date()
      let clockA = base
      let clockB = base
      let tokenA = 0
      let tokenB = 0
      const workerA = createPlatformWebhookInboxService({
        repository: createPrismaPlatformWebhookRepository(first),
        workerId: 'worker-a',
        now: () => clockA,
        newClaimToken: () => `a-${++tokenA}`,
      })
      const workerB = createPlatformWebhookInboxService({
        repository: createPrismaPlatformWebhookRepository(second),
        workerId: 'worker-b',
        now: () => clockB,
        newClaimToken: () => `b-${++tokenB}`,
      })

      await sql.query(
        `INSERT INTO "WebhookEvent" (id, "stripeEventId", "eventType", payload, status, "retryCount", "effectAttempts", "effectNextAttemptAt")
         VALUES
          ('aba-event', 'evt_aba', 'invoice.paid', '{"id":"evt_aba","type":"invoice.paid"}', 'FAILED', 1, 1, $1),
          ('fifth-success', 'evt_fifth_success', 'invoice.paid', '{"id":"evt_fifth_success","type":"invoice.paid"}', 'FAILED', 4, 4, $1),
          ('fifth-crash', 'evt_fifth_crash', 'invoice.paid', '{"id":"evt_fifth_crash","type":"invoice.paid"}', 'FAILED', 4, 4, $1),
          ('two-terminalizers', 'evt_two_terminalizers', 'invoice.paid', '{"id":"evt_two_terminalizers","type":"invoice.paid"}', 'RETRYING', 5, 5, $1),
          ('effect-after-classified', 'evt_effect_after_classified', 'invoice.paid', '{"id":"evt_effect_after_classified","type":"invoice.paid"}', 'PENDING', 0, 0, $1),
          ('classification-after-success', 'evt_class_after_success', 'invoice.paid', '{"id":"evt_class_after_success","type":"invoice.paid"}', 'SUCCESS', 0, 0, NULL)
        `,
        [base],
      )
      await sql.query(
        `
        UPDATE "WebhookEvent"
        SET "classificationState" = 'IGNORED',
            "classificationNextAttemptAt" = NULL,
            "classificationResolvedAt" = $1,
            "classificationErrorCode" = 'NOT_OWNED',
            "classificationErrorMessage" = 'not owned'
        WHERE id = 'effect-after-classified'
      `,
        [base],
      )

      const firstLease = await workerA.acquire('aba-event', 'EFFECT', { manual: true })
      const heartbeat = await workerA.heartbeat(firstLease!)
      clockA = new Date(heartbeat.claimExpiresAt.getTime() + 1)
      clockB = clockA
      const secondLease = await workerB.acquire('aba-event', 'EFFECT', { manual: true })
      let staleCompletion = false
      try {
        await workerA.completeEffect(firstLease!)
      } catch (error) {
        staleCompletion = error instanceof StaleWebhookLeaseError
      }

      clockA = base
      const successLease = await workerA.acquire('fifth-success', 'EFFECT', { manual: true })
      await workerA.completeEffect(successLease!)

      const crashLease = await workerA.acquire('fifth-crash', 'EFFECT', { manual: true })
      clockB = new Date(crashLease!.claimExpiresAt.getTime() - 1)
      const terminalBeforeExpiry = await workerB.terminalizeExhausted('EFFECT', 'fifth-crash')
      clockB = new Date(crashLease!.claimExpiresAt.getTime() + 1)
      const terminalAfterExpiry = await workerB.terminalizeExhausted('EFFECT', 'fifth-crash')

      const [terminalA, terminalB] = await Promise.all([
        workerA.terminalizeExhausted('EFFECT', 'two-terminalizers'),
        workerB.terminalizeExhausted('EFFECT', 'two-terminalizers'),
      ])

      clockA = base
      const effectAfterClassification = await workerA.acquire('effect-after-classified', 'EFFECT', { manual: true })
      await workerA.release(effectAfterClassification!)
      const classificationAfterEffect = await workerA.acquire('classification-after-success', 'CLASSIFICATION', { manual: true })

      clockB = new Date(clockB.getTime() + 1)
      const firstAlertClaims = await workerB.claimOperationalAlerts()
      const crashAlertFirst = firstAlertClaims.find(row => row.webhookEventId === 'fifth-crash')!
      clockB = new Date(crashAlertFirst.claimExpiresAt.getTime() + 1)
      const secondAlertClaims = await workerB.claimOperationalAlerts()
      const crashAlertSecond = secondAlertClaims.find(row => row.webhookEventId === 'fifth-crash')!
      await workerB.retryOperationalAlert(crashAlertSecond)
      const notDueAfterBackoff = await workerB.claimOperationalAlerts()
      clockB = new Date(clockB.getTime() + 10_000)
      const thirdAlertClaims = await workerB.claimOperationalAlerts()
      const crashAlertThird = thirdAlertClaims.find(row => row.webhookEventId === 'fifth-crash')!
      await workerB.acknowledgeOperationalAlert(crashAlertThird)

      const states = await sql.query(`
        SELECT id, status, "effectAttempts", "effectNextAttemptAt", "classificationState", "classificationAttempts",
               "claimPhase", "claimToken"
        FROM "WebhookEvent"
        WHERE id IN ('aba-event', 'fifth-success', 'fifth-crash', 'two-terminalizers',
                     'effect-after-classified', 'classification-after-success')
        ORDER BY id
      `)
      const alerts = await sql.query(`
        SELECT "webhookEventId", "terminalReason", count(*)::integer AS count,
               max("deliveryAttempts")::integer AS "deliveryAttempts", max("deliveredAt") AS "deliveredAt"
        FROM "WebhookOperationalAlert"
        WHERE "webhookEventId" IN ('fifth-success', 'fifth-crash', 'two-terminalizers')
        GROUP BY "webhookEventId", "terminalReason" ORDER BY "webhookEventId"
      `)

      return {
        firstLease,
        heartbeat,
        secondLease,
        staleCompletion,
        terminalBeforeExpiry,
        terminalAfterExpiry,
        concurrentTerminalLengths: [terminalA.length, terminalB.length].sort(),
        classificationAfterEffect,
        firstAlertDeliveryAttempt: crashAlertFirst.deliveryAttempt,
        secondAlertDeliveryAttempt: crashAlertSecond.deliveryAttempt,
        thirdAlertDeliveryAttempt: crashAlertThird.deliveryAttempt,
        notDueAfterBackoffHasCrash: notDueAfterBackoff.some(row => row.webhookEventId === 'fifth-crash'),
        states: states.rows,
        alerts: alerts.rows,
      }
    })

    expect(proof.result.heartbeat.claimExpiresAt.getTime()).toBeGreaterThan(proof.result.firstLease!.claimExpiresAt.getTime())
    expect(proof.result.secondLease?.claimToken).not.toBe(proof.result.firstLease?.claimToken)
    expect(proof.result.secondLease?.attempt).toBe(3)
    expect(proof.result.staleCompletion).toBe(true)
    expect(proof.result.terminalBeforeExpiry).toEqual([])
    expect(proof.result.terminalAfterExpiry).toHaveLength(1)
    expect(proof.result.concurrentTerminalLengths).toEqual([0, 1])
    expect(proof.result.classificationAfterEffect).toMatchObject({ phase: 'CLASSIFICATION', attempt: 1 })
    expect(proof.result.firstAlertDeliveryAttempt).toBe(1)
    expect(proof.result.secondAlertDeliveryAttempt).toBe(2)
    expect(proof.result.thirdAlertDeliveryAttempt).toBe(3)
    expect(proof.result.notDueAfterBackoffHasCrash).toBe(false)
    expect(proof.result.states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'fifth-success', status: 'SUCCESS', effectAttempts: 5, effectNextAttemptAt: null }),
        expect.objectContaining({ id: 'fifth-crash', status: 'FAILED', effectAttempts: 5, effectNextAttemptAt: null, claimPhase: null }),
        expect.objectContaining({ id: 'two-terminalizers', status: 'FAILED', effectAttempts: 5, effectNextAttemptAt: null }),
        expect.objectContaining({
          id: 'classification-after-success',
          status: 'SUCCESS',
          classificationAttempts: 1,
          claimPhase: 'CLASSIFICATION',
        }),
      ]),
    )
    expect(proof.result.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          webhookEventId: 'fifth-crash',
          terminalReason: 'EFFECT_ATTEMPTS_EXHAUSTED',
          count: 1,
          deliveryAttempts: 3,
          deliveredAt: expect.any(Date),
        }),
        expect.objectContaining({ webhookEventId: 'two-terminalizers', terminalReason: 'EFFECT_ATTEMPTS_EXHAUSTED', count: 1 }),
      ]),
    )
    expect(proof.result.alerts.some((row: { webhookEventId: string }) => row.webhookEventId === 'fifth-success')).toBe(false)
    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
  })

  it('commits effect state, observation and terminal alert atomically or rolls all of them back', async () => {
    const proof = await withOrchestratorPrimitivesDatabase(async ({ first, second, sql, applyA1cMigration }) => {
      await applyA1cMigration()
      const base = new Date()
      let clockA = base
      let clockB = base
      const repositoryA = createPrismaPlatformWebhookRepository(first)
      const workerA = createPlatformWebhookInboxService({
        repository: repositoryA,
        workerId: 'atomic-a',
        now: () => clockA,
        newClaimToken: () => `atomic-a-${clockA.getTime()}`,
      })
      const workerB = createPlatformWebhookInboxService({
        repository: createPrismaPlatformWebhookRepository(second),
        workerId: 'atomic-b',
        now: () => clockB,
        newClaimToken: () => `atomic-b-${clockB.getTime()}`,
      })
      await sql.query(
        `INSERT INTO "WebhookEvent" (
          id, "stripeEventId", "eventType", payload, status, "retryCount", "effectAttempts", "effectNextAttemptAt"
        ) VALUES
          ('atomic-success', 'evt_atomic_success', 'invoice.paid', '{"id":"evt_atomic_success","type":"invoice.paid"}', 'PENDING', 0, 0, $1),
          ('atomic-failure', 'evt_atomic_failure', 'invoice.paid', '{"id":"evt_atomic_failure","type":"invoice.paid"}', 'PENDING', 0, 0, $1),
          ('atomic-terminal', 'evt_atomic_terminal', 'invoice.paid', '{"id":"evt_atomic_terminal","type":"invoice.paid"}', 'FAILED', 4, 4, $1),
          ('atomic-identical', 'evt_atomic_identical', 'invoice.paid', '{"id":"evt_atomic_identical","type":"invoice.paid"}', 'PENDING', 0, 0, $1),
          ('atomic-concurrent', 'evt_atomic_concurrent', 'invoice.paid', '{"id":"evt_atomic_concurrent","type":"invoice.paid"}', 'PENDING', 0, 0, $1),
          ('atomic-stale', 'evt_atomic_stale', 'invoice.paid', '{"id":"evt_atomic_stale","type":"invoice.paid"}', 'PENDING', 0, 0, $1),
          ('atomic-conflict', 'evt_atomic_conflict', 'invoice.paid', '{"id":"evt_atomic_conflict","type":"invoice.paid"}', 'PENDING', 0, 0, $1),
          ('atomic-rollback', 'evt_atomic_rollback', 'invoice.paid', '{"id":"evt_atomic_rollback","type":"invoice.paid"}', 'PENDING', 0, 0, $1)`,
        [base],
      )

      const observation = (eventId: string, attempt: number, outcome: 'SUCCESS' | 'FAILED') => ({
        webhookEventId: eventId,
        effectAttempt: attempt,
        steps: outcome === 'SUCCESS' ? [{ step: 'COMMERCIAL_ADAPTER', outcome: 'NOT_MATCHED' }] : [],
        effectOutcome: outcome,
        ...(outcome === 'FAILED' ? { failureStep: 'COMMERCIAL_ADAPTER' } : {}),
        comparisonCode: 'CLASSIFICATION_PENDING',
      })

      const successLease = await workerA.acquire('atomic-success', 'EFFECT', { manual: true })
      await workerA.finalizeEffectWithObservation(successLease!, observation('atomic-success', successLease!.attempt, 'SUCCESS'), {
        outcome: 'SUCCESS',
        processingTime: 11,
      })

      const failureLease = await workerA.acquire('atomic-failure', 'EFFECT', { manual: true })
      await workerA.finalizeEffectWithObservation(failureLease!, observation('atomic-failure', failureLease!.attempt, 'FAILED'), {
        outcome: 'FAILED',
        error: { code: 'DISPATCH_FAILED', message: 'closed error' },
        processingTime: 12,
      })

      const terminalLease = await workerA.acquire('atomic-terminal', 'EFFECT', { manual: true })
      await workerA.finalizeEffectWithObservation(terminalLease!, observation('atomic-terminal', terminalLease!.attempt, 'FAILED'), {
        outcome: 'FAILED',
        error: { code: 'DISPATCH_FAILED', message: 'last closed error' },
        processingTime: 13,
      })

      const identicalLease = await workerA.acquire('atomic-identical', 'EFFECT', { manual: true })
      const identicalObservation = observation('atomic-identical', identicalLease!.attempt, 'SUCCESS')
      await sql.query(
        `INSERT INTO "WebhookDispatchObservation" (
          "webhookEventId", "effectAttempt", steps, "effectOutcome", "failureStep", "comparisonCode", "createdAt"
        ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
        [
          identicalObservation.webhookEventId,
          identicalObservation.effectAttempt,
          JSON.stringify(identicalObservation.steps),
          identicalObservation.effectOutcome,
          null,
          identicalObservation.comparisonCode,
          base,
        ],
      )
      await workerA.finalizeEffectWithObservation(identicalLease!, identicalObservation, {
        outcome: 'SUCCESS',
        processingTime: 14,
      })

      const concurrentLease = await workerA.acquire('atomic-concurrent', 'EFFECT', { manual: true })
      const concurrentObservation = observation('atomic-concurrent', concurrentLease!.attempt, 'SUCCESS')
      const concurrentResults = await Promise.allSettled([
        workerA.finalizeEffectWithObservation(concurrentLease!, concurrentObservation, {
          outcome: 'SUCCESS',
          processingTime: 15,
        }),
        workerB.finalizeEffectWithObservation(concurrentLease!, concurrentObservation, {
          outcome: 'SUCCESS',
          processingTime: 15,
        }),
      ])

      const staleLease = await workerA.acquire('atomic-stale', 'EFFECT', { manual: true })
      clockB = new Date(staleLease!.claimExpiresAt.getTime() + 1)
      await workerB.acquire('atomic-stale', 'EFFECT', { manual: true })
      clockA = clockB
      let staleRejected = false
      try {
        await workerA.finalizeEffectWithObservation(staleLease!, observation('atomic-stale', staleLease!.attempt, 'SUCCESS'), {
          outcome: 'SUCCESS',
        })
      } catch (error) {
        staleRejected = error instanceof StaleWebhookLeaseError
      }

      const conflictLease = await workerA.acquire('atomic-conflict', 'EFFECT', { manual: true })
      await sql.query(
        `INSERT INTO "WebhookDispatchObservation" (
          "webhookEventId", "effectAttempt", steps, "effectOutcome", "comparisonCode"
         ) VALUES ('atomic-conflict', $1, '[]', 'FAILED', 'CLASSIFICATION_PENDING')`,
        [conflictLease!.attempt],
      )
      let conflictRejected = false
      try {
        await workerA.finalizeEffectWithObservation(conflictLease!, observation('atomic-conflict', conflictLease!.attempt, 'SUCCESS'), {
          outcome: 'SUCCESS',
        })
      } catch {
        conflictRejected = true
      }

      const rollbackLease = await workerA.acquire('atomic-rollback', 'EFFECT', { manual: true })
      let rollbackRejected = false
      try {
        await workerA.finalizeEffectWithObservation(
          rollbackLease!,
          {
            ...observation('atomic-rollback', rollbackLease!.attempt, 'SUCCESS'),
          },
          // Exceeds PostgreSQL INTEGER after the CTE reaches the state update;
          // the whole observation+state statement must roll back atomically.
          { outcome: 'SUCCESS', processingTime: 3_000_000_000 },
        )
      } catch {
        rollbackRejected = true
      }

      const state = await sql.query(`
        SELECT id, status, "effectAttempts", "effectNextAttemptAt", "claimPhase", "claimToken", "processingTime"
        FROM "WebhookEvent" WHERE id LIKE 'atomic-%' ORDER BY id
      `)
      const observations = await sql.query(`
        SELECT "webhookEventId", "effectAttempt", "effectOutcome", "comparisonCode"
        FROM "WebhookDispatchObservation" WHERE "webhookEventId" LIKE 'atomic-%' ORDER BY "webhookEventId"
      `)
      const alerts = await sql.query(`
        SELECT "webhookEventId", phase, "terminalReason", attempt
        FROM "WebhookOperationalAlert" WHERE "webhookEventId" LIKE 'atomic-%' ORDER BY "webhookEventId"
      `)

      return {
        staleRejected,
        conflictRejected,
        rollbackRejected,
        concurrentFulfilled: concurrentResults.filter(result => result.status === 'fulfilled').length,
        concurrentRejected: concurrentResults.filter(result => result.status === 'rejected').length,
        state: state.rows,
        observations: observations.rows,
        alerts: alerts.rows,
      }
    })

    expect(proof.result).toMatchObject({
      staleRejected: true,
      conflictRejected: true,
      rollbackRejected: true,
      concurrentFulfilled: 2,
      concurrentRejected: 0,
    })
    expect(proof.result.state).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'atomic-success',
          status: 'SUCCESS',
          effectAttempts: 1,
          effectNextAttemptAt: null,
          claimPhase: null,
          processingTime: 11,
        }),
        expect.objectContaining({
          id: 'atomic-failure',
          status: 'FAILED',
          effectAttempts: 1,
          effectNextAttemptAt: expect.any(Date),
          claimPhase: null,
          processingTime: 12,
        }),
        expect.objectContaining({
          id: 'atomic-terminal',
          status: 'FAILED',
          effectAttempts: 5,
          effectNextAttemptAt: null,
          claimPhase: null,
          processingTime: 13,
        }),
        expect.objectContaining({
          id: 'atomic-identical',
          status: 'SUCCESS',
          effectAttempts: 1,
          effectNextAttemptAt: null,
          claimPhase: null,
          processingTime: 14,
        }),
        expect.objectContaining({
          id: 'atomic-concurrent',
          status: 'SUCCESS',
          effectAttempts: 1,
          effectNextAttemptAt: null,
          claimPhase: null,
          processingTime: 15,
        }),
        expect.objectContaining({ id: 'atomic-stale', status: 'RETRYING', effectAttempts: 2, claimPhase: 'EFFECT' }),
        expect.objectContaining({ id: 'atomic-conflict', status: 'RETRYING', effectAttempts: 1, claimPhase: 'EFFECT' }),
        expect.objectContaining({ id: 'atomic-rollback', status: 'RETRYING', effectAttempts: 1, claimPhase: 'EFFECT' }),
      ]),
    )
    expect(proof.result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ webhookEventId: 'atomic-success', effectAttempt: 1, effectOutcome: 'SUCCESS' }),
        expect.objectContaining({ webhookEventId: 'atomic-failure', effectAttempt: 1, effectOutcome: 'FAILED' }),
        expect.objectContaining({ webhookEventId: 'atomic-terminal', effectAttempt: 5, effectOutcome: 'FAILED' }),
        expect.objectContaining({ webhookEventId: 'atomic-identical', effectAttempt: 1, effectOutcome: 'SUCCESS' }),
        expect.objectContaining({ webhookEventId: 'atomic-concurrent', effectAttempt: 1, effectOutcome: 'SUCCESS' }),
        expect.objectContaining({ webhookEventId: 'atomic-conflict', effectAttempt: 1, effectOutcome: 'FAILED' }),
      ]),
    )
    expect(proof.result.observations.some((row: { webhookEventId: string }) => row.webhookEventId === 'atomic-stale')).toBe(false)
    expect(proof.result.observations.some((row: { webhookEventId: string }) => row.webhookEventId === 'atomic-rollback')).toBe(false)
    expect(proof.result.alerts).toEqual([
      { webhookEventId: 'atomic-terminal', phase: 'EFFECT', terminalReason: 'EFFECT_ATTEMPTS_EXHAUSTED', attempt: 5 },
    ])
    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
  })
})
