/**
 * RabbitMQ consumer for the `gcal.pull` routing key (Phase 1 — Task 17).
 *
 * Webhook handler + connection-commit hook publish `{ connectionId }` messages
 * on `POS_COMMANDS_EXCHANGE` with this routing key. The consumer fans out to
 * `pullConnection` which holds the per-connection advisory lock.
 *
 * Bound on a dedicated queue (`gcal_pull_queue`) so a slow/failing pull does
 * NOT block POS event processing on `AVOQADO_EVENTS_QUEUE`. The queue has its
 * own DLX wiring.
 *
 * Idempotency: messages are tagged with the connectionId; the worker
 * short-circuits if another pull is in flight (advisory lock). Duplicates
 * (Google replays, sweeper races) are absorbed at the lock layer.
 */
import { ConsumeMessage } from 'amqplib'

import logger from '@/config/logger'
import { GCAL_PULL_ROUTING_KEY, pullConnection } from '@/services/google-calendar/pull.service'
import { getRabbitMQChannel, POS_COMMANDS_EXCHANGE } from './connection'

const GCAL_PULL_QUEUE = 'gcal_pull_queue'
const DEAD_LETTER_EXCHANGE = 'dead_letter_exchange'

interface PullPayload {
  connectionId?: string
}

async function handlePullMessage(msg: ConsumeMessage | null): Promise<void> {
  if (!msg) return

  const channel = getRabbitMQChannel()
  try {
    const payload = JSON.parse(msg.content.toString()) as PullPayload
    if (!payload?.connectionId) {
      logger.warn('gcal-pull-consumer: message missing connectionId, acking')
      channel.ack(msg)
      return
    }

    await pullConnection(payload.connectionId)
    channel.ack(msg)
  } catch (err) {
    logger.error('gcal-pull-consumer: handler threw — DLQ', { err })
    // Send to DLQ rather than blocking the queue on a poison message.
    channel.nack(msg, false, false)
  }
}

export async function startGcalPullConsumer(): Promise<void> {
  try {
    const channel = getRabbitMQChannel()

    await channel.assertQueue(GCAL_PULL_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
        'x-dead-letter-routing-key': 'dead-letter',
      },
    })
    await channel.bindQueue(GCAL_PULL_QUEUE, POS_COMMANDS_EXCHANGE, GCAL_PULL_ROUTING_KEY)

    // One in-flight pull per consumer instance — pulls touch the DB heavily and
    // serialize via advisory lock anyway, so a higher prefetch buys nothing.
    channel.prefetch(1)

    logger.info('gcal-pull-consumer: listening on queue', { queue: GCAL_PULL_QUEUE })
    channel.consume(GCAL_PULL_QUEUE, handlePullMessage)
  } catch (err) {
    logger.warn('gcal-pull-consumer: failed to start (sweeper will still drive pulls)', { err })
  }
}
