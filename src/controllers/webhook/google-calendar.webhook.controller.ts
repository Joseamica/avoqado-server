/**
 * Google Calendar webhook controller (Phase 1 — Task 13).
 *
 * Receives push notifications from Google's `events.watch` channels. Validation
 * order is strict — we MUST return early with the appropriate status code BEFORE
 * doing any work that could leak signal (timing, DB state) about valid channels:
 *
 *   400  missing required headers
 *   401  unknown channel token OR token length mismatch OR resourceId mismatch
 *   404  channel id not found in DB
 *   200  ack-but-skip for: sync handshake, disconnected connection
 *   503  DB inbox INSERT failed (Google retries)
 *   200  happy path: inbox row written + best-effort pull enqueue
 *
 * Token comparison uses `crypto.timingSafeEqual` to defeat timing-side-channel
 * attacks: a naive `===` compare leaks byte-by-byte equality through response
 * latency.
 *
 * The inbox write is DURABLE and happens BEFORE returning 200 — that's the
 * at-least-once guarantee. RabbitMQ enqueue is BEST-EFFORT — the inbox sweeper
 * picks up rows the queue dropped.
 *
 * Mounted at `/api/v1/webhooks/google-calendar` BEFORE the existing
 * `/api/v1/webhooks` Stripe router (see `src/app.ts`) so Google's notifications
 * hit a wildcard raw parser (type star-slash-star) instead of Stripe's strict
 * `application/json` one.
 */
import crypto from 'crypto'
import { Request, Response } from 'express'

import logger from '@/config/logger'
import { getRabbitMQChannel, POS_COMMANDS_EXCHANGE } from '@/communication/rabbitmq/connection'
import prisma from '@/utils/prismaClient'

export const GCAL_PULL_ROUTING_KEY = 'gcal.pull'

export async function handleGoogleCalendarWebhook(req: Request, res: Response): Promise<void> {
  const channelId = req.header('X-Goog-Channel-ID')
  const token = req.header('X-Goog-Channel-Token')
  const resourceId = req.header('X-Goog-Resource-ID')
  const resourceState = req.header('X-Goog-Resource-State')
  const messageNumber = req.header('X-Goog-Message-Number')

  if (!channelId || !token || !resourceId) {
    res.status(400).end()
    return
  }

  // 1. Lookup channel — both ACTIVE and RENEWING are valid during channel rotation overlap.
  const channels = await prisma.googleCalendarChannel.findMany({
    where: { channelId, status: { in: ['ACTIVE', 'RENEWING'] } },
    include: { connection: true },
  })
  if (channels.length === 0) {
    res.status(404).end()
    return
  }

  // 2. Constant-time token comparison. Reject as a single 401 for any mismatch so we don't
  //    leak which side failed (length vs bytes).
  const channel = channels.find(c => {
    if (!c.token || c.token.length !== token.length) return false
    return crypto.timingSafeEqual(Buffer.from(c.token), Buffer.from(token))
  })
  if (!channel) {
    res.status(401).end()
    return
  }

  // 3. Cross-check resourceId — defense against header tampering.
  if (channel.resourceId !== resourceId) {
    res.status(401).end()
    return
  }

  // 4. Connection must be active (not REVOKED/DISCONNECTED). Ack-but-skip otherwise so Google
  //    doesn't retry forever — the user will reconnect through the dashboard.
  if (channel.connection.status !== 'CONNECTED') {
    res.status(200).end()
    return
  }

  // 5. Sync handshake notifications are no-ops — they just confirm Google received the watch
  //    request and can reach the webhook URL.
  if (resourceState === 'sync') {
    res.status(200).end()
    return
  }

  // 6. DURABLE write to inbox BEFORE returning 200 to Google. If this fails Google will
  //    retry with the same X-Goog-Message-Number.
  try {
    await prisma.googleCalendarWebhookInbox.create({
      data: {
        connectionId: channel.connectionId,
        channelId,
        resourceId,
        resourceState: resourceState ?? 'unknown',
        messageNumber: messageNumber ?? '0',
      },
    })
  } catch (err) {
    logger.error('gcal webhook inbox write failed', {
      err,
      channelId,
      connectionId: channel.connectionId,
    })
    res.status(503).end()
    return
  }

  // 7. Best-effort enqueue to RabbitMQ. The sweeper job picks up unprocessed inbox rows if
  //    this fails OR if RabbitMQ isn't running (server.ts:229 continues without it).
  void publishPullCommand(channel.connectionId).catch(err => {
    logger.warn('gcal webhook: failed to enqueue pull (sweeper will retry)', {
      err: err?.message,
      connectionId: channel.connectionId,
    })
  })

  res.status(200).end()
}

/**
 * Best-effort RabbitMQ enqueue for a pull. Throws on failure — the caller MUST
 * wrap this in `.catch(() => {})`. Exported so the connection commit + auth
 * paths can share the same producer surface.
 */
export async function publishPullCommand(connectionId: string): Promise<void> {
  const channel = getRabbitMQChannel() // throws if RabbitMQ never connected
  const payload = Buffer.from(JSON.stringify({ connectionId }))
  const ok = channel.publish(POS_COMMANDS_EXCHANGE, GCAL_PULL_ROUTING_KEY, payload, { persistent: true })
  if (!ok) {
    throw new Error('rabbitmq_publish_buffer_full')
  }
}
