/**
 * Webhook Monitoring Service (SUPERADMIN)
 *
 * Provides webhook event monitoring, debugging, and retry capabilities
 */

import { WebhookEventStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-10-28' as any,
})

/**
 * List webhook events with filtering and pagination
 */
export async function listWebhookEvents(filters: {
  eventType?: string
  status?: WebhookEventStatus
  venueId?: string
  startDate?: Date
  endDate?: Date
  limit?: number
  offset?: number
}) {
  const { eventType, status, venueId, startDate, endDate, limit = 50, offset = 0 } = filters

  // Build where clause
  const where: any = {}

  if (eventType) {
    where.eventType = { contains: eventType }
  }

  if (status) {
    where.status = status
  }

  if (venueId) {
    where.venueId = venueId
  }

  if (startDate || endDate) {
    where.createdAt = {}
    if (startDate) where.createdAt.gte = startDate
    if (endDate) where.createdAt.lte = endDate
  }

  // Fetch events with pagination
  const [events, total] = await Promise.all([
    prisma.webhookEvent.findMany({
      where,
      include: {
        venue: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.webhookEvent.count({ where }),
  ])

  return {
    events,
    total,
    limit,
    offset,
    hasMore: offset + events.length < total,
  }
}

/**
 * Get detailed information about a specific webhook event
 */
export async function getWebhookEventDetails(eventId: string) {
  const event = await prisma.webhookEvent.findUnique({
    where: { id: eventId },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
          stripeCustomerId: true,
        },
      },
    },
  })

  if (!event) {
    throw new Error('Webhook event not found')
  }

  return event
}

/**
 * Get webhook health metrics
 */
export async function getWebhookMetrics(timeRange: { startDate: Date; endDate: Date }) {
  const { startDate, endDate } = timeRange

  const where = {
    createdAt: {
      gte: startDate,
      lte: endDate,
    },
  }

  // Get counts by status
  const [totalEvents, successCount, failedCount, pendingCount] = await Promise.all([
    prisma.webhookEvent.count({ where }),
    prisma.webhookEvent.count({ where: { ...where, status: 'SUCCESS' } }),
    prisma.webhookEvent.count({ where: { ...where, status: 'FAILED' } }),
    prisma.webhookEvent.count({ where: { ...where, status: 'PENDING' } }),
  ])

  // Get average processing time (only successful events)
  const avgProcessingTime = await prisma.webhookEvent.aggregate({
    where: {
      ...where,
      status: 'SUCCESS',
      processingTime: { not: null },
    },
    _avg: {
      processingTime: true,
    },
  })

  // Get events by type (top 10)
  const eventsByType = await prisma.webhookEvent.groupBy({
    by: ['eventType'],
    where,
    _count: {
      id: true,
    },
    orderBy: {
      _count: {
        id: 'desc',
      },
    },
    take: 10,
  })

  // Get events with high retry counts (potential issues)
  const failingEvents = await prisma.webhookEvent.findMany({
    where: {
      ...where,
      retryCount: { gte: 3 },
      status: 'FAILED',
    },
    select: {
      id: true,
      stripeEventId: true,
      eventType: true,
      retryCount: true,
      errorMessage: true,
      createdAt: true,
    },
    orderBy: { retryCount: 'desc' },
    take: 10,
  })

  const successRate = totalEvents > 0 ? (successCount / totalEvents) * 100 : 0

  return {
    summary: {
      totalEvents,
      successCount,
      failedCount,
      pendingCount,
      successRate: Number(successRate.toFixed(2)),
      avgProcessingTime: avgProcessingTime._avg.processingTime || 0,
    },
    eventsByType: eventsByType.map(e => ({
      type: e.eventType,
      count: e._count.id,
    })),
    failingEvents,
  }
}

/**
 * Retry a failed webhook event
 *
 * Fetches the event from Stripe and reprocesses it
 */
export async function retryWebhookEvent(eventId: string) {
  // Get the webhook event from database
  const webhookEvent = await prisma.webhookEvent.findUnique({
    where: { id: eventId },
  })

  if (!webhookEvent) {
    throw new Error('Webhook event not found')
  }

  if (webhookEvent.status === 'SUCCESS') {
    throw new Error('Cannot retry successful event')
  }

  logger.info('🔄 Retrying webhook event', {
    webhookEventId: eventId,
    stripeEventId: webhookEvent.stripeEventId,
    eventType: webhookEvent.eventType,
    previousRetries: webhookEvent.retryCount,
  })

  try {
    // Mark as retrying
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: {
        status: 'RETRYING',
        retryCount: { increment: 1 },
      },
    })

    // Fetch original event from Stripe
    const stripeEvent = await stripe.events.retrieve(webhookEvent.stripeEventId)

    // Import the webhook handler
    const { handleStripeWebhookEvent } = await import('../stripe.webhook.service')

    // Reprocess the event
    await handleStripeWebhookEvent(stripeEvent)

    logger.info('✅ Webhook retry successful', {
      webhookEventId: eventId,
      stripeEventId: webhookEvent.stripeEventId,
    })

    return {
      success: true,
      message: 'Webhook event reprocessed successfully',
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    logger.error('❌ Webhook retry failed', {
      webhookEventId: eventId,
      stripeEventId: webhookEvent.stripeEventId,
      error: errorMessage,
    })

    // Update failure in database
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: {
        status: 'FAILED',
        errorMessage: errorMessage,
      },
    })

    throw new Error(`Retry failed: ${errorMessage}`)
  }
}

/**
 * Get list of unique event types for filtering
 */
export async function getEventTypes() {
  const eventTypes = await prisma.webhookEvent.groupBy({
    by: ['eventType'],
    _count: {
      id: true,
    },
    orderBy: {
      eventType: 'asc',
    },
  })

  return eventTypes.map(e => ({
    type: e.eventType,
    count: e._count.id,
  }))
}

export default {
  listWebhookEvents,
  getWebhookEventDetails,
  getWebhookMetrics,
  retryWebhookEvent,
  getEventTypes,
}
