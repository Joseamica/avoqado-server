import prisma from '../../utils/prismaClient'
import { TpvMessageStatus, TpvMessageTarget, TpvMessageDeliveryStatus } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import logger from '../../config/logger'

// ===========================
// Interfaces
// ===========================

interface CreateMessageParams {
  venueId: string
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
  scheduledFor?: string
  expiresAt?: string
  createdBy: string
  createdByName: string
}

interface GetMessagesParams {
  venueId: string
  status?: TpvMessageStatus
  type?: string
  limit?: number
  offset?: number
}

// ===========================
// Service Functions
// ===========================

/**
 * Create a new TPV message and generate delivery records for targeted terminals
 */
export async function createMessage(params: CreateMessageParams) {
  const {
    venueId,
    type,
    title,
    body,
    priority = 'NORMAL',
    requiresAck = false,
    surveyOptions,
    surveyMultiSelect = false,
    actionLabel,
    actionType,
    actionPayload,
    targetType,
    targetTerminalIds = [],
    scheduledFor,
    expiresAt,
    createdBy,
    createdByName,
  } = params

  // Validate survey options for SURVEY type
  if (type === 'SURVEY' && (!surveyOptions || surveyOptions.length < 2)) {
    throw new BadRequestError('Survey messages require at least 2 options')
  }

  // Validate action config for ACTION type
  if (type === 'ACTION' && !actionLabel) {
    throw new BadRequestError('Action messages require an action label')
  }

  // Get target terminals
  let terminalIds: string[]

  if (targetType === 'ALL_TERMINALS') {
    const terminals = await prisma.terminal.findMany({
      where: { venueId, status: { not: 'INACTIVE' } },
      select: { id: true },
    })
    terminalIds = terminals.map(t => t.id)
  } else {
    // Validate that specified terminals belong to this venue
    if (targetTerminalIds.length === 0) {
      throw new BadRequestError('At least one terminal must be specified for SPECIFIC_TERMINALS target type')
    }
    const terminals = await prisma.terminal.findMany({
      where: { id: { in: targetTerminalIds }, venueId },
      select: { id: true },
    })
    if (terminals.length !== targetTerminalIds.length) {
      throw new BadRequestError('Some specified terminal IDs do not belong to this venue')
    }
    terminalIds = terminals.map(t => t.id)
  }

  if (terminalIds.length === 0) {
    throw new BadRequestError('No active terminals found for this venue')
  }

  // Create message + delivery records in a transaction
  const message = await prisma.$transaction(async tx => {
    const msg = await tx.tpvMessage.create({
      data: {
        venueId,
        type,
        title,
        body,
        priority,
        requiresAck,
        surveyOptions: surveyOptions ? JSON.parse(JSON.stringify(surveyOptions)) : undefined,
        surveyMultiSelect,
        actionLabel,
        actionType,
        actionPayload: actionPayload ? JSON.parse(JSON.stringify(actionPayload)) : undefined,
        targetType,
        targetTerminalIds,
        scheduledFor: scheduledFor ? new Date(scheduledFor) : undefined,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        createdBy,
        createdByName,
      },
      include: {
        deliveries: true,
      },
    })

    // Create delivery records for each terminal
    await tx.tpvMessageDelivery.createMany({
      data: terminalIds.map(terminalId => ({
        messageId: msg.id,
        terminalId,
      })),
    })

    // Re-fetch with deliveries
    return tx.tpvMessage.findUnique({
      where: { id: msg.id },
      include: {
        deliveries: {
          include: {
            terminal: { select: { id: true, name: true, serialNumber: true } },
          },
        },
      },
    })
  })

  logger.info(`📨 TPV message created: ${title} (${type}) → ${terminalIds.length} terminals`, {
    messageId: message!.id,
    venueId,
    type,
    targetType,
    terminalCount: terminalIds.length,
  })

  return message!
}

/**
 * Get paginated messages for a venue
 */
export async function getMessages(params: GetMessagesParams) {
  const { venueId, status, type, limit = 20, offset = 0 } = params

  const where: any = { venueId }
  if (status) where.status = status
  if (type) where.type = type

  const [messages, total] = await prisma.$transaction([
    prisma.tpvMessage.findMany({
      where,
      include: {
        deliveries: {
          select: {
            id: true,
            terminalId: true,
            status: true,
            deliveredAt: true,
            acknowledgedAt: true,
            dismissedAt: true,
          },
        },
        _count: {
          select: {
            responses: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.tpvMessage.count({ where }),
  ])

  return { messages, total, limit, offset }
}

/**
 * Get a single message with full delivery details
 */
export async function getMessageWithStatus(messageId: string, venueId: string) {
  const message = await prisma.tpvMessage.findFirst({
    where: { id: messageId, venueId },
    include: {
      deliveries: {
        include: {
          terminal: { select: { id: true, name: true, serialNumber: true, status: true } },
        },
      },
      responses: {
        include: {
          terminal: { select: { id: true, name: true, serialNumber: true } },
        },
      },
    },
  })

  if (!message) {
    throw new NotFoundError('Message not found')
  }

  return message
}

/**
 * Get survey responses for a message
 */
export async function getMessageResponses(messageId: string, venueId: string) {
  const message = await prisma.tpvMessage.findFirst({
    where: { id: messageId, venueId },
    select: { id: true, type: true, surveyOptions: true },
  })

  if (!message) {
    throw new NotFoundError('Message not found')
  }

  const responses = await prisma.tpvMessageResponse.findMany({
    where: { messageId },
    include: {
      terminal: { select: { id: true, name: true, serialNumber: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  return { message, responses }
}

/**
 * Cancel an active message
 */
export async function cancelMessage(messageId: string, venueId: string) {
  const message = await prisma.tpvMessage.findFirst({
    where: { id: messageId, venueId },
  })

  if (!message) {
    throw new NotFoundError('Message not found')
  }

  if (message.status !== 'ACTIVE') {
    throw new BadRequestError('Only active messages can be cancelled')
  }

  const updated = await prisma.tpvMessage.update({
    where: { id: messageId },
    data: { status: TpvMessageStatus.CANCELLED },
  })

  logger.info(`📨 TPV message cancelled: ${message.title}`, {
    messageId,
    venueId,
  })

  return updated
}

/**
 * Get pending messages for a terminal (used by TPV REST endpoint for offline recovery)
 */
export async function getPendingMessages(terminalId: string, venueId: string) {
  const deliveries = await prisma.tpvMessageDelivery.findMany({
    where: {
      terminalId,
      status: { in: [TpvMessageDeliveryStatus.PENDING, TpvMessageDeliveryStatus.DELIVERED] },
      message: {
        venueId,
        status: TpvMessageStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    },
    include: {
      message: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  return deliveries.map(d => d.message)
}

/**
 * Mark a message as acknowledged by a terminal
 */
export async function acknowledgeMessage(messageId: string, terminalId?: string, staffId?: string) {
  // Try compound key first, fall back to messageId-only lookup
  let delivery = terminalId
    ? await prisma.tpvMessageDelivery.findUnique({
        where: { messageId_terminalId: { messageId, terminalId } },
      })
    : null

  if (!delivery) {
    // Fallback: find any pending/delivered delivery for this message
    delivery = await prisma.tpvMessageDelivery.findFirst({
      where: {
        messageId,
        status: { in: [TpvMessageDeliveryStatus.PENDING, TpvMessageDeliveryStatus.DELIVERED] },
      },
    })
  }

  if (!delivery) {
    throw new NotFoundError('Message delivery not found for this terminal')
  }

  const updated = await prisma.tpvMessageDelivery.update({
    where: { id: delivery.id },
    data: {
      status: TpvMessageDeliveryStatus.ACKNOWLEDGED,
      acknowledgedAt: new Date(),
      acknowledgedBy: staffId,
    },
  })

  logger.info(`📨 TPV message acknowledged: ${messageId} by terminal ${terminalId || 'unknown'}`, {
    messageId,
    terminalId: terminalId || 'N/A',
    staffId,
  })

  return updated
}

/**
 * Mark a message as dismissed by a terminal
 */
export async function dismissMessage(messageId: string, terminalId?: string) {
  // Try compound key first, fall back to messageId-only lookup
  let delivery = terminalId
    ? await prisma.tpvMessageDelivery.findUnique({
        where: { messageId_terminalId: { messageId, terminalId } },
      })
    : null

  if (!delivery) {
    // Fallback: find any pending/delivered delivery for this message
    delivery = await prisma.tpvMessageDelivery.findFirst({
      where: {
        messageId,
        status: { in: [TpvMessageDeliveryStatus.PENDING, TpvMessageDeliveryStatus.DELIVERED] },
      },
    })
  }

  if (!delivery) {
    throw new NotFoundError('Message delivery not found for this terminal')
  }

  const updated = await prisma.tpvMessageDelivery.update({
    where: { id: delivery.id },
    data: {
      status: TpvMessageDeliveryStatus.DISMISSED,
      dismissedAt: new Date(),
    },
  })

  logger.info(`📨 TPV message dismissed: ${messageId} by terminal ${terminalId || 'unknown'}`, {
    messageId,
    terminalId: terminalId || 'N/A',
  })

  return updated
}

/**
 * Submit a survey response from a terminal
 */
export async function submitResponse(
  messageId: string,
  terminalId: string,
  selectedOptions: string[],
  staffId?: string,
  staffName?: string,
) {
  // Verify message is a survey
  const message = await prisma.tpvMessage.findFirst({
    where: { id: messageId, status: TpvMessageStatus.ACTIVE },
  })

  if (!message) {
    throw new NotFoundError('Message not found or not active')
  }

  if (message.type !== 'SURVEY') {
    throw new BadRequestError('Only survey messages accept responses')
  }

  // Create response (upsert to handle re-submissions)
  const response = await prisma.tpvMessageResponse.upsert({
    where: { messageId_terminalId: { messageId, terminalId } },
    update: {
      selectedOptions,
      respondedBy: staffId,
      respondedByName: staffName,
    },
    create: {
      messageId,
      terminalId,
      selectedOptions,
      respondedBy: staffId,
      respondedByName: staffName,
    },
  })

  // Also mark as acknowledged
  await prisma.tpvMessageDelivery.updateMany({
    where: { messageId, terminalId },
    data: {
      status: TpvMessageDeliveryStatus.ACKNOWLEDGED,
      acknowledgedAt: new Date(),
      acknowledgedBy: staffId,
    },
  })

  logger.info(`📨 TPV survey response: ${messageId} from terminal ${terminalId}`, {
    messageId,
    terminalId,
    selectedOptions,
  })

  return response
}

/**
 * Get all message history for a terminal (including already-handled messages)
 * Used by the TPV inbox UI to show full message history with delivery status
 */
export async function getTerminalMessageHistory(terminalId: string, venueId: string, limit: number = 50, offset: number = 0) {
  const [deliveries, total] = await prisma.$transaction([
    prisma.tpvMessageDelivery.findMany({
      where: {
        terminalId,
        message: { venueId },
      },
      include: {
        message: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.tpvMessageDelivery.count({
      where: {
        terminalId,
        message: { venueId },
      },
    }),
  ])

  const data = deliveries.map(d => ({
    ...d.message,
    deliveryStatus: d.status,
    acknowledgedAt: d.acknowledgedAt?.toISOString() ?? null,
  }))

  return { data, total, limit, offset }
}

/**
 * Mark a delivery as delivered (when socket event reaches terminal)
 */
export async function markDelivered(messageId: string, terminalId: string) {
  await prisma.tpvMessageDelivery.updateMany({
    where: {
      messageId,
      terminalId,
      status: TpvMessageDeliveryStatus.PENDING,
    },
    data: {
      status: TpvMessageDeliveryStatus.DELIVERED,
      deliveredAt: new Date(),
    },
  })
}
