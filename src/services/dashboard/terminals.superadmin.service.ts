import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { generateActivationCode as generateActivationCodeUtil } from './terminal-activation.service'
import { notifyAffectedTerminals } from '../superadmin/merchantAccount.service'
import { tpvCommandQueueService } from '../tpv/command-queue.service'

/**
 * Get All Terminals (Cross-Venue)
 *
 * Returns all terminals across all venues with optional filters.
 * Used by superadmin dashboard.
 *
 * @param filters Optional filters: venueId, status, type
 * @returns List of terminals with venue info
 */
export async function getAllTerminals(filters?: { venueId?: string; status?: string; type?: string }) {
  logger.info('Fetching all terminals with filters:', filters)

  const where: any = {}

  if (filters?.venueId) {
    where.venueId = filters.venueId
  }

  if (filters?.status) {
    where.status = filters.status
  }

  if (filters?.type) {
    where.type = filters.type
  }

  const terminals = await prisma.terminal.findMany({
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
    orderBy: {
      createdAt: 'desc',
    },
  })

  logger.info(`Fetched ${terminals.length} terminals`)

  return terminals
}

/**
 * Get Terminal by ID
 *
 * @param terminalId Terminal ID (CUID)
 * @returns Terminal with venue info
 */
export async function getTerminalById(terminalId: string) {
  logger.info(`Fetching terminal: ${terminalId}`)

  const terminal = await prisma.terminal.findUnique({
    where: { id: terminalId },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal not found')
  }

  return terminal
}

/**
 * Create Terminal
 *
 * Creates a new terminal with optional merchant account assignments.
 * Optionally generates activation code immediately.
 *
 * @param data Terminal creation data
 * @returns Created terminal with activation code (if requested)
 */
export async function createTerminal(data: {
  venueId: string
  serialNumber: string
  name: string
  type: string
  brand?: string
  model?: string
  assignedMerchantIds?: string[]
  generateActivationCode?: boolean
  staffId?: string
}) {
  logger.info('Creating terminal:', {
    venueId: data.venueId,
    serialNumber: data.serialNumber,
    name: data.name,
  })

  // Validate venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: data.venueId },
  })

  if (!venue) {
    throw new BadRequestError('Venue not found')
  }

  // Check if serial number is unique
  const existingTerminal = await prisma.terminal.findFirst({
    where: {
      serialNumber: {
        equals: data.serialNumber,
        mode: 'insensitive',
      },
    },
  })

  if (existingTerminal) {
    throw new BadRequestError(`Terminal with serial number ${data.serialNumber} already exists`)
  }

  // Validate merchant accounts exist (if assigned)
  if (data.assignedMerchantIds && data.assignedMerchantIds.length > 0) {
    const merchantCount = await prisma.merchantAccount.count({
      where: {
        id: { in: data.assignedMerchantIds },
      },
    })

    if (merchantCount !== data.assignedMerchantIds.length) {
      throw new BadRequestError('One or more merchant accounts not found')
    }
  }

  // Create terminal
  const terminal = await prisma.terminal.create({
    data: {
      venueId: data.venueId,
      serialNumber: data.serialNumber,
      name: data.name,
      type: data.type as any,
      brand: data.brand,
      model: data.model,
      status: 'INACTIVE', // Default status (will become ACTIVE after activation)
      assignedMerchantIds: data.assignedMerchantIds || [],
    },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  })

  logger.info(`Terminal created successfully: ${terminal.id}`)

  // Auto-attach existing merchant accounts with matching serial number
  // Note: Terminal serialNumber may have prefix (e.g., "AVQD-2841548417") while
  // MerchantAccount.blumonSerialNumber has raw serial ("2841548417")
  let autoAttachedMerchants: Array<{ id: string; displayName: string | null }> = []

  if (data.serialNumber) {
    // Extract raw serial by removing common prefixes (AVQD-, AVQ-, etc.)
    const rawSerial = data.serialNumber.replace(/^(AVQD-|AVQ-|AVO-)/i, '')
    logger.info('[Terminal Create] Searching for merchants to auto-attach', {
      terminalSerial: data.serialNumber,
      rawSerial,
    })

    const matchingMerchants = await prisma.merchantAccount.findMany({
      where: {
        OR: [
          { blumonSerialNumber: data.serialNumber }, // Exact match
          { blumonSerialNumber: rawSerial }, // Match raw serial
        ],
        active: true,
      },
      select: {
        id: true,
        displayName: true,
      },
    })

    if (matchingMerchants.length > 0) {
      // Filter out merchants that were already passed in assignedMerchantIds
      const existingIds = new Set(data.assignedMerchantIds || [])
      const newMerchants = matchingMerchants.filter(m => !existingIds.has(m.id))

      if (newMerchants.length > 0) {
        // Update terminal with additional merchants
        const updatedTerminal = await prisma.terminal.update({
          where: { id: terminal.id },
          data: {
            assignedMerchantIds: {
              push: newMerchants.map(m => m.id),
            },
          },
        })

        autoAttachedMerchants = newMerchants

        // Notify terminals about the new merchants
        for (const merchant of newMerchants) {
          await notifyAffectedTerminals(merchant.id, merchant.displayName || `Blumon ${data.serialNumber}`, 'MERCHANT_ADDED', false)
        }

        logger.info(`[Terminal Create] Auto-attached ${newMerchants.length} merchant(s) to terminal`, {
          terminalId: terminal.id,
          merchantIds: newMerchants.map(m => m.id),
        })

        // Update terminal object with new assignedMerchantIds for return
        terminal.assignedMerchantIds = updatedTerminal.assignedMerchantIds
      }
    } else {
      logger.info('[Terminal Create] No existing merchants found with matching serial for auto-attach', {
        serialNumber: data.serialNumber,
      })
    }
  }

  // Generate activation code if requested
  let activationCodeData = null
  if (data.generateActivationCode && data.staffId) {
    activationCodeData = await generateActivationCodeUtil(terminal.id, data.staffId)
    logger.info(`Activation code generated for terminal ${terminal.id}: ${activationCodeData.activationCode}`)
  }

  return {
    terminal,
    activationCode: activationCodeData,
    autoAttachedMerchants,
  }
}

/**
 * Update Terminal
 *
 * Updates terminal metadata (name, status, assignedMerchantIds, etc.)
 *
 * @param terminalId Terminal ID (CUID)
 * @param data Update data
 * @returns Updated terminal
 */
export async function updateTerminal(
  terminalId: string,
  data: {
    name?: string
    status?: string
    assignedMerchantIds?: string[]
    brand?: string
    model?: string
  },
) {
  logger.info(`Updating terminal ${terminalId}:`, data)

  // Verify terminal exists
  const terminal = await prisma.terminal.findUnique({
    where: { id: terminalId },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal not found')
  }

  // Validate merchant accounts if being updated
  if (data.assignedMerchantIds && data.assignedMerchantIds.length > 0) {
    const merchants = await prisma.merchantAccount.findMany({
      where: {
        id: { in: data.assignedMerchantIds },
      },
      select: { id: true, displayName: true },
    })

    logger.info(`Validation: Requested ${data.assignedMerchantIds.length} merchants, found ${merchants.length}`)
    logger.info('Requested IDs:', data.assignedMerchantIds)
    logger.info(
      'Found merchants:',
      merchants.map(m => ({ id: m.id, name: m.displayName })),
    )

    if (merchants.length !== data.assignedMerchantIds.length) {
      const foundIds = merchants.map(m => m.id)
      const missingIds = data.assignedMerchantIds.filter(id => !foundIds.includes(id))
      logger.error('Missing merchant IDs:', missingIds)
      throw new BadRequestError(`Merchant accounts not found: ${missingIds.join(', ')}`)
    }
  }

  // Update terminal
  const updatedTerminal = await prisma.terminal.update({
    where: { id: terminalId },
    data: {
      ...(data.name && { name: data.name }),
      ...(data.status && { status: data.status as any }),
      ...(data.assignedMerchantIds !== undefined && { assignedMerchantIds: data.assignedMerchantIds }),
      ...(data.brand && { brand: data.brand }),
      ...(data.model && { model: data.model }),
    },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  })

  logger.info(`Terminal ${terminalId} updated successfully`)

  return updatedTerminal
}

/**
 * Generate Activation Code for Terminal (Wrapper)
 *
 * Generates a 6-character activation code for a terminal.
 *
 * @param terminalId Terminal ID (CUID)
 * @param staffId Staff ID who is generating the code
 * @returns Activation code data
 */
export async function generateActivationCodeForTerminal(terminalId: string, staffId: string) {
  logger.info(`Generating activation code for terminal ${terminalId} by staff ${staffId}`)

  return generateActivationCodeUtil(terminalId, staffId)
}

/**
 * Delete Terminal
 *
 * Deletes a terminal (only if not activated or RETIRED status).
 *
 * @param terminalId Terminal ID (CUID)
 */
export async function deleteTerminal(terminalId: string) {
  logger.info(`Deleting terminal: ${terminalId}`)

  const terminal = await prisma.terminal.findUnique({
    where: { id: terminalId },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal not found')
  }

  // Prevent deletion of ACTIVE terminals (must be retired first)
  if (terminal.status === 'ACTIVE' && terminal.activatedAt) {
    throw new BadRequestError('Cannot delete active terminal. Set status to RETIRED first.')
  }

  await prisma.terminal.delete({
    where: { id: terminalId },
  })

  logger.info(`Terminal ${terminalId} deleted successfully`)

  return { success: true }
}

/**
 * Send Remote Activation Command
 *
 * Sends a REMOTE_ACTIVATE command to a pre-registered terminal.
 * The terminal must have a serialNumber and must have sent at least one heartbeat.
 * Only SUPERADMIN can use this function.
 *
 * @param terminalId Terminal ID (CUID)
 * @param staffId Staff ID (SUPERADMIN) who is sending the command
 * @returns Command queue result
 */
export async function sendRemoteActivation(terminalId: string, staffId: string) {
  logger.info(`Sending remote activation command to terminal ${terminalId} by staff ${staffId}`)

  // Fetch terminal with venue info
  const terminal = await prisma.terminal.findUnique({
    where: { id: terminalId },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
          timezone: true,
        },
      },
    },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal not found')
  }

  // Validate terminal is not already activated
  if (terminal.activatedAt) {
    throw new BadRequestError('Terminal is already activated')
  }

  // Validate terminal has a serial number (required for identification)
  if (!terminal.serialNumber) {
    throw new BadRequestError('Terminal must have a serial number for remote activation')
  }

  // Check if terminal has ever sent a heartbeat (proof of physical device)
  if (!terminal.lastHeartbeat) {
    throw new BadRequestError(
      'Terminal must send at least one heartbeat before remote activation. ' +
        'Please ensure the physical terminal is powered on and connected to the internet.',
    )
  }

  // Validate terminal status - should be INACTIVE
  if (terminal.status === 'RETIRED') {
    throw new BadRequestError('Cannot activate a retired terminal')
  }

  // Get staff info for audit trail
  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    select: { id: true, firstName: true, lastName: true, email: true },
  })

  const staffName = staff ? `${staff.firstName} ${staff.lastName}`.trim() : 'SUPERADMIN'

  // Queue the REMOTE_ACTIVATE command with venue info payload
  const result = await tpvCommandQueueService.queueCommand({
    terminalId: terminal.id,
    venueId: terminal.venueId,
    commandType: 'REMOTE_ACTIVATE',
    payload: {
      venueId: terminal.venue.id,
      venueName: terminal.venue.name,
      venueSlug: terminal.venue.slug,
      venueTimezone: terminal.venue.timezone,
      terminalId: terminal.id,
      terminalName: terminal.name,
      serialNumber: terminal.serialNumber,
    },
    priority: 'HIGH',
    requestedBy: staffId,
    requestedByName: staffName,
    source: 'DASHBOARD',
  })

  logger.info(`Remote activation command queued for terminal ${terminalId}`, {
    commandId: result.commandId,
    correlationId: result.correlationId,
    status: result.status,
  })

  return {
    ...result,
    terminal: {
      id: terminal.id,
      name: terminal.name,
      serialNumber: terminal.serialNumber,
      venue: terminal.venue,
    },
  }
}
