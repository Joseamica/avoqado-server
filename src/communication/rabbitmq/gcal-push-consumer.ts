/**
 * RabbitMQ consumer for the `gcal.push` routing key (Phase 2 — Section C).
 *
 * The outbox hooks publish `{ outboxRowId }` messages right after the source
 * transaction commits; this consumer drains them and drives `processOutboxRow`,
 * which itself takes the per-syncKey advisory lock. The outbox sweeper
 * (`gcal-outbox-sweeper.job.ts`) is the safety net — if RMQ is down or the
 * worker crashes mid-flight, the sweeper picks the row up again on its next
 * tick.
 *
 * Bound on a dedicated queue (`gcal_push_queue`) so a slow Google round-trip
 * does NOT back up POS event processing on `AVOQADO_EVENTS_QUEUE`. DLX wiring
 * matches the pull consumer.
 *
 * Failure handling: `processOutboxRow` already absorbs Google failures into
 * the row's `status/attempts/lastError/scheduledAt`. We treat its execution
 * as fire-and-forget from the consumer's POV — wrap in try/catch only to
 * survive *unexpected* exceptions (e.g. DB connection lost), log them, and
 * ack the message anyway. Re-delivering wouldn't help (the row state is
 * authoritative) and would starve the queue on poison messages.
 */
import { ConsumeMessage } from 'amqplib'

import logger from '@/config/logger'
import { processOutboxRow } from '@/services/google-calendar/push.service'
import { getRabbitMQChannel, POS_COMMANDS_EXCHANGE } from './connection'

/** Routing key shared with the publisher helper + outbox hooks. */
export const GCAL_PUSH_ROUTING_KEY = 'gcal.push'

const GCAL_PUSH_QUEUE = 'gcal_push_queue'
const DEAD_LETTER_EXCHANGE = 'dead_letter_exchange'

interface PushPayload {
  outboxRowId?: string
}

async function handlePushMessage(msg: ConsumeMessage | null): Promise<void> {
  if (!msg) return

  const channel = getRabbitMQChannel()
  try {
    const payload = JSON.parse(msg.content.toString()) as PushPayload
    if (!payload?.outboxRowId) {
      // Malformed message — log + ack. The sweeper picks up any orphan row.
      logger.warn('gcal-push-consumer: message missing outboxRowId, acking')
      channel.ack(msg)
      return
    }

    // processOutboxRow swallows Google failures internally (persists them to
    // the row). We still wrap in try/catch for the truly unexpected — e.g.
    // Prisma engine crash. Either way: ack, do NOT requeue. The sweeper is
    // the retry path.
    try {
      await processOutboxRow(payload.outboxRowId)
    } catch (err) {
      logger.warn('gcal-push-consumer: processOutboxRow threw unexpectedly', {
        err,
        outboxRowId: payload.outboxRowId,
      })
    }

    channel.ack(msg)
  } catch (err) {
    // JSON.parse / other pre-processing errors. Send to DLQ so we have an
    // audit trail of poison messages instead of silently dropping them.
    logger.error('gcal-push-consumer: handler threw — DLQ', { err })
    channel.nack(msg, false, false)
  }
}

export async function startGcalPushConsumer(): Promise<void> {
  try {
    const channel = getRabbitMQChannel()

    await channel.assertQueue(GCAL_PUSH_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
        'x-dead-letter-routing-key': 'dead-letter',
      },
    })
    await channel.bindQueue(GCAL_PUSH_QUEUE, POS_COMMANDS_EXCHANGE, GCAL_PUSH_ROUTING_KEY)

    // One in-flight push per consumer instance — Google round-trips are slow
    // and the worker serializes via advisory lock anyway.
    channel.prefetch(1)

    logger.info('gcal-push-consumer: listening on queue', { queue: GCAL_PUSH_QUEUE })
    channel.consume(GCAL_PUSH_QUEUE, handlePushMessage)
  } catch (err) {
    logger.warn('gcal-push-consumer: failed to start (sweeper will still drive pushes)', { err })
  }
}

/**
 * Best-effort publish — caller wraps in `.catch()`. The outbox row is the
 * source of truth; the sweeper picks up unpublished rows on its next tick if
 * RabbitMQ is down. One message per row id so the consumer's `prefetch=1`
 * gates work to a sensible per-instance concurrency.
 *
 * Server starts WITHOUT RabbitMQ if it's down (`server.ts`); this function
 * throws in that case so the caller's `.catch` keeps the request path alive.
 */
export async function publishPushNotification(outboxRowIds: string[]): Promise<void> {
  if (!Array.isArray(outboxRowIds) || outboxRowIds.length === 0) return

  const channel = getRabbitMQChannel()
  for (const outboxRowId of outboxRowIds) {
    const payload = Buffer.from(JSON.stringify({ outboxRowId }))
    const ok = channel.publish(POS_COMMANDS_EXCHANGE, GCAL_PUSH_ROUTING_KEY, payload, {
      persistent: true,
    })
    if (!ok) {
      throw new Error('rabbitmq_publish_buffer_full')
    }
  }
}
