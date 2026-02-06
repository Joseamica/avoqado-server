import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { IncidentStatus, SettlementStatus } from '@prisma/client'
import { subDays } from 'date-fns'
import { venueStartOfDay, DEFAULT_TIMEZONE } from '../../utils/datetime'

/**
 * Settlement Incident Detection Service
 *
 * Detects when expected settlements don't arrive on time and creates incidents
 * for manual confirmation and SOFOM alerting.
 */

/**
 * Detect settlements that were expected yesterday but haven't arrived
 * This is the core "detection by absence" strategy
 */
export async function detectMissingSettlements(): Promise<{
  detected: number
  incidents: any[]
}> {
  try {
    logger.info('🔍 Starting settlement detection job...')

    // Calculate yesterday's date range
    const yesterday = venueStartOfDay(DEFAULT_TIMEZONE, subDays(new Date(), 1))
    const today = venueStartOfDay()

    logger.debug(`Looking for settlements expected on: ${yesterday.toISOString()}`)

    // Find all transactions that:
    // 1. Were expected to settle yesterday
    // 2. Don't have an actualSettlementDate yet
    // 3. Are still in PENDING status
    // 4. Don't already have an incident created
    const missingSettlements = await prisma.venueTransaction.findMany({
      where: {
        estimatedSettlementDate: {
          gte: yesterday,
          lt: today,
        },
        actualSettlementDate: null,
        status: SettlementStatus.PENDING,
        // Don't create duplicate incidents
        incidents: {
          none: {
            status: {
              in: [IncidentStatus.PENDING_CONFIRMATION, IncidentStatus.CONFIRMED_DELAY, IncidentStatus.ESCALATED],
            },
          },
        },
      },
      include: {
        payment: {
          include: {
            transactionCost: {
              include: {
                merchantAccount: {
                  include: {
                    provider: true,
                  },
                },
              },
            },
          },
        },
        venue: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    })

    logger.info(`Found ${missingSettlements.length} potentially delayed settlements`)

    if (missingSettlements.length === 0) {
      return { detected: 0, incidents: [] }
    }

    // Create incidents for each missing settlement
    const incidents = []
    for (const transaction of missingSettlements) {
      try {
        // Determine processor name and card type
        const processorName = transaction.payment.transactionCost?.merchantAccount?.provider?.name || 'Unknown'
        const cardType = transaction.payment.transactionCost?.transactionType || 'DEBIT' // Default to DEBIT if not specified

        // Create the incident
        const incident = await prisma.settlementIncident.create({
          data: {
            transactionId: transaction.id,
            venueId: transaction.venueId,
            estimatedSettlementDate: transaction.estimatedSettlementDate!,
            processorName,
            cardType,
            transactionDate: transaction.createdAt,
            amount: transaction.grossAmount,
            status: IncidentStatus.PENDING_CONFIRMATION,
            notes: `Automatically detected: Settlement expected on ${transaction.estimatedSettlementDate?.toISOString().split('T')[0]} did not arrive`,
          },
        })

        incidents.push(incident)

        logger.debug(
          `Created incident ${incident.id} for transaction ${transaction.id} (${processorName}, ${cardType}, $${transaction.grossAmount})`,
        )
      } catch (error) {
        logger.error(`Failed to create incident for transaction ${transaction.id}:`, error)
      }
    }

    logger.info(`✅ Created ${incidents.length} settlement incidents`)

    return {
      detected: incidents.length,
      incidents,
    }
  } catch (error) {
    logger.error('❌ Error detecting missing settlements:', error)
    throw error
  }
}

/**
 * Get all pending incidents that need confirmation
 */
export async function getPendingIncidents(venueId?: string) {
  const where: any = {
    status: IncidentStatus.PENDING_CONFIRMATION,
  }

  if (venueId) {
    where.venueId = venueId
  }

  return prisma.settlementIncident.findMany({
    where,
    include: {
      transaction: {
        select: {
          id: true,
          payment: {
            select: {
              id: true,
              transactionCost: {
                select: {
                  merchantAccount: {
                    select: {
                      provider: {
                        select: {
                          name: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
      confirmations: true,
    },
    orderBy: {
      detectionDate: 'desc',
    },
  })
}

/**
 * Get all active incidents (not resolved)
 */
export async function getActiveIncidents(venueId?: string) {
  const where: any = {
    status: {
      in: [IncidentStatus.PENDING_CONFIRMATION, IncidentStatus.CONFIRMED_DELAY, IncidentStatus.ESCALATED],
    },
  }

  if (venueId) {
    where.venueId = venueId
  }

  return prisma.settlementIncident.findMany({
    where,
    include: {
      transaction: true,
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
      confirmations: true,
    },
    orderBy: {
      detectionDate: 'desc',
    },
  })
}

/**
 * Confirm a settlement incident (venue confirms if money arrived)
 */
export async function confirmSettlementIncident(
  incidentId: string,
  confirmedBy: string,
  settlementArrived: boolean,
  actualDate?: Date,
  notes?: string,
) {
  // Create the confirmation record
  const incident = await prisma.settlementIncident.findUnique({
    where: { id: incidentId },
    include: { transaction: true },
  })

  if (!incident) {
    throw new Error('Incident not found')
  }

  // Create confirmation
  const confirmation = await prisma.settlementConfirmation.create({
    data: {
      incidentId,
      transactionId: incident.transactionId,
      venueId: incident.venueId,
      confirmedBy,
      settlementArrived,
      actualDate: actualDate || null,
      notes,
    },
  })

  // Update incident based on confirmation
  let newStatus = incident.status
  let delayDays = null

  if (settlementArrived && actualDate) {
    // Money arrived - resolve the incident
    newStatus = IncidentStatus.RESOLVED
    delayDays = Math.floor((actualDate.getTime() - incident.estimatedSettlementDate.getTime()) / (1000 * 60 * 60 * 24))

    // Update transaction with actual settlement date
    if (incident.transactionId) {
      await prisma.venueTransaction.update({
        where: { id: incident.transactionId },
        data: {
          actualSettlementDate: actualDate,
          settlementVarianceDays: delayDays,
          status: SettlementStatus.SETTLED,
          confirmationMethod: 'MANUAL',
        },
      })
    }
  } else if (!settlementArrived) {
    // Money didn't arrive - confirm delay
    newStatus = IncidentStatus.CONFIRMED_DELAY
  }

  // Update incident
  const updatedIncident = await prisma.settlementIncident.update({
    where: { id: incidentId },
    data: {
      status: newStatus,
      actualSettlementDate: actualDate || null,
      delayDays,
      resolutionDate: settlementArrived ? new Date() : null,
      resolvedBy: settlementArrived ? confirmedBy : null,
    },
  })

  return { incident: updatedIncident, confirmation }
}

/**
 * Escalate an incident to SuperAdmin
 */
export async function escalateIncident(incidentId: string, notes?: string) {
  return prisma.settlementIncident.update({
    where: { id: incidentId },
    data: {
      status: IncidentStatus.ESCALATED,
      notes: notes || 'Escalated to SuperAdmin for review',
    },
  })
}

/**
 * Bulk confirm multiple settlement incidents
 */
export async function bulkConfirmSettlementIncidents(
  venueId: string,
  incidentIds: string[],
  confirmedBy: string,
  settlementArrived: boolean,
  actualDate?: Date,
  notes?: string,
): Promise<{
  confirmed: number
  failed: number
  results: Array<{
    incidentId: string
    success: boolean
    error?: string
  }>
}> {
  const results: Array<{
    incidentId: string
    success: boolean
    error?: string
  }> = []

  // First, verify all incidents belong to the venue
  const incidents = await prisma.settlementIncident.findMany({
    where: {
      id: { in: incidentIds },
      venueId,
    },
    select: { id: true },
  })

  const validIncidentIds = new Set(incidents.map(i => i.id))

  // Mark invalid incident IDs as failed
  for (const incidentId of incidentIds) {
    if (!validIncidentIds.has(incidentId)) {
      results.push({
        incidentId,
        success: false,
        error: 'Incident not found or does not belong to this venue',
      })
    }
  }

  // Process valid incidents
  for (const incidentId of validIncidentIds) {
    try {
      await confirmSettlementIncident(incidentId, confirmedBy, settlementArrived, actualDate, notes)
      results.push({ incidentId, success: true })
    } catch (error) {
      logger.error(`Failed to confirm incident ${incidentId}:`, error)
      results.push({
        incidentId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  const confirmed = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length

  logger.info(`Bulk confirm completed: ${confirmed} confirmed, ${failed} failed`)

  return { confirmed, failed, results }
}

/**
 * Get incident statistics for a venue or globally
 */
export async function getIncidentStats(venueId?: string) {
  const where: any = venueId ? { venueId } : {}

  const [total, pending, delayed, resolved, escalated] = await Promise.all([
    prisma.settlementIncident.count({ where }),
    prisma.settlementIncident.count({
      where: { ...where, status: IncidentStatus.PENDING_CONFIRMATION },
    }),
    prisma.settlementIncident.count({
      where: { ...where, status: IncidentStatus.CONFIRMED_DELAY },
    }),
    prisma.settlementIncident.count({
      where: { ...where, status: IncidentStatus.RESOLVED },
    }),
    prisma.settlementIncident.count({
      where: { ...where, status: IncidentStatus.ESCALATED },
    }),
  ])

  // Calculate average delay for resolved incidents
  const resolvedIncidents = await prisma.settlementIncident.findMany({
    where: {
      ...where,
      status: IncidentStatus.RESOLVED,
      delayDays: { not: null },
    },
    select: {
      delayDays: true,
    },
  })

  const averageDelayDays =
    resolvedIncidents.length > 0
      ? resolvedIncidents.reduce((sum: number, inc) => sum + (inc.delayDays || 0), 0) / resolvedIncidents.length
      : 0

  return {
    total,
    pending,
    delayed,
    resolved,
    escalated,
    averageDelayDays,
  }
}
