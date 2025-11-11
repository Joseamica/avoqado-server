import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { generateActivationCode as generateActivationCodeUtil } from './terminal-activation.service'

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

  // Generate activation code if requested
  let activationCodeData = null
  if (data.generateActivationCode && data.staffId) {
    activationCodeData = await generateActivationCodeUtil(terminal.id, data.staffId)
    logger.info(`Activation code generated for terminal ${terminal.id}: ${activationCodeData.activationCode}`)
  }

  return {
    terminal,
    activationCode: activationCodeData,
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
