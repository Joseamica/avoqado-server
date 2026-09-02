/**
 * Webhook Monitoring Service (SUPERADMIN)
 *
 * Provides webhook event monitoring, debugging, and retry capabilities
 */

import {
  StripeEventOwnerKind,
  StripeEventRouteKey,
  WebhookClaimPhase,
  WebhookClassificationState,
  WebhookEventStatus,
} from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { retryWebhookEvent } from './webhookManualRetry.service'

export {
  LEGACY_DASHBOARD_WEBHOOK_RETRY_REASON,
  WebhookAuditUnavailableError,
  WebhookEffectAttemptFailedError,
  WebhookEffectNotRetryableError,
  WebhookLeaseBusyError,
  WebhookNotFoundError,
  WebhookSuperadminDomainError,
  createDurableManualRetryAuditWriter,
  createWebhookManualRetryService,
  createWebhookManualRetryService as createWebhookSuperadminManualRetryService,
  isWebhookSuperadminDomainError,
  retryWebhookEvent,
} from './webhookManualRetry.service'

// NOTE: no Stripe client here anymore — `retryWebhookEvent` used to re-fetch the
// event via `stripe.events.retrieve`, but the replay now reuses the payload
// stored on the row (same as a Stripe redelivery), so the retry keeps working
// even when the Stripe API is the thing that's down.

/**
 * List webhook events with filtering and pagination
 */
export async function listWebhookEvents(filters: {
  eventType?: string
  status?: WebhookEventStatus
  classificationState?: WebhookClassificationState
  ownerKind?: StripeEventOwnerKind
  routeKey?: StripeEventRouteKey
  claimPhase?: WebhookClaimPhase
  venueId?: string
  startDate?: Date
  endDate?: Date
  limit?: number
  offset?: number
}) {
  const {
    eventType,
    status,
    classificationState,
    ownerKind,
    routeKey,
    claimPhase,
    venueId,
    startDate,
    endDate,
    limit = 50,
    offset = 0,
  } = filters

  // Build where clause
  const where: any = {}

  if (eventType) {
    where.eventType = { contains: eventType }
  }

  if (status) {
    where.status = status
  }

  if (classificationState) {
    where.classificationState = classificationState
  }

  if (ownerKind) {
    where.ownerKind = ownerKind
  }

  if (routeKey) {
    where.routeKey = routeKey
  }

  if (claimPhase) {
    where.claimPhase = claimPhase
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
      // `id` is the TIEBREAK — without it a tie group crossing a skip/take page boundary repeats a row
      // on one page and drops another for good (Asana 1217127206664238).
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
      stripeObjectBindings: true,
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
  const [eventsByType, classificationStates, effectStatuses] = await Promise.all([
    prisma.webhookEvent.groupBy({
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
    }),
    prisma.webhookEvent.groupBy({
      by: ['classificationState'],
      where,
      _count: { id: true },
      orderBy: { classificationState: 'asc' },
    }),
    prisma.webhookEvent.groupBy({
      by: ['status'],
      where,
      _count: { id: true },
      orderBy: { status: 'asc' },
    }),
  ])

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
    classificationSummary: classificationStates.map(entry => ({
      state: entry.classificationState,
      count: entry._count.id,
    })),
    effectSummary: effectStatuses.map(entry => ({
      status: entry.status,
      count: entry._count.id,
    })),
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
