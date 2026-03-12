import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'
import { createMessage } from '../tpv/tpv-message.service'
import { broadcastTpvMessage } from '../../communication/sockets'

interface BroadcastOrgMessageParams {
  type: 'ANNOUNCEMENT' | 'SURVEY' | 'ACTION'
  title: string
  body: string
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
  requiresAck?: boolean
  surveyOptions?: string[]
  surveyMultiSelect?: boolean
  actionLabel?: string
  actionType?: string
  actionPayload?: any
  targetType: 'ALL_TERMINALS' | 'SPECIFIC_TERMINALS'
  targetTerminalIds?: string[]
  expiresAt?: string
  createdBy: string
  createdByName: string
}

/**
 * Broadcast a message to ALL terminals across ALL active venues in an organization.
 * Creates one TpvMessage per venue, each with delivery records for its terminals,
 * then broadcasts each via Socket.IO.
 */
export async function broadcastOrgMessage(orgId: string, data: BroadcastOrgMessageParams) {
  // 1. Get all active venues in the org
  const venues = await prisma.venue.findMany({
    where: { organizationId: orgId, status: 'ACTIVE' },
    select: { id: true, name: true },
  })

  if (venues.length === 0) {
    throw new BadRequestError('No active venues found in this organization')
  }

  logger.info(`Broadcasting org message "${data.title}" to ${venues.length} venues`, {
    orgId,
    type: data.type,
    targetType: data.targetType,
    venueCount: venues.length,
    createdBy: data.createdBy,
  })

  // 2. For each venue, create the message using the existing service
  const results: { venueId: string; venueName: string; message: any; error?: string }[] = []

  for (const venue of venues) {
    try {
      const message = await createMessage({
        venueId: venue.id,
        type: data.type,
        title: data.title,
        body: data.body,
        priority: data.priority,
        requiresAck: data.requiresAck,
        surveyOptions: data.surveyOptions,
        surveyMultiSelect: data.surveyMultiSelect,
        actionLabel: data.actionLabel,
        actionType: data.actionType,
        actionPayload: data.actionPayload,
        targetType: data.targetType,
        targetTerminalIds: data.targetTerminalIds,
        expiresAt: data.expiresAt,
        createdBy: data.createdBy,
        createdByName: data.createdByName,
      })

      // 3. Broadcast via Socket.IO
      broadcastTpvMessage(venue.id, message)

      results.push({ venueId: venue.id, venueName: venue.name, message })
    } catch (error) {
      // Log but don't fail the entire broadcast if one venue has no terminals
      const errMessage = error instanceof Error ? error.message : 'Unknown error'
      logger.warn(`Failed to broadcast to venue ${venue.id} (${venue.name}): ${errMessage}`, {
        orgId,
        venueId: venue.id,
        error: errMessage,
      })
      results.push({ venueId: venue.id, venueName: venue.name, message: null, error: errMessage })
    }
  }

  const successCount = results.filter(r => !r.error).length
  const messageCount = results
    .filter(r => r.message)
    .reduce((acc, r) => {
      return acc + (r.message?.deliveries?.length || 0)
    }, 0)

  logger.info(`Org broadcast complete: ${successCount}/${venues.length} venues, ${messageCount} terminal deliveries`, {
    orgId,
    successCount,
    venueCount: venues.length,
    messageCount,
  })

  return {
    venueCount: venues.length,
    successCount,
    messageCount,
    results,
  }
}
