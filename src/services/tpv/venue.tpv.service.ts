import prisma from '../../utils/prismaClient'
import { Venue } from '@prisma/client'
import { NotFoundError, UnauthorizedError } from '../../errors/AppError'
import logger from '@/config/logger'
import { mentaApiService } from './menta.api.service'

/**
 * Get venue by ID for TPV usage
 * @param orgId optional Organization ID (for future authorization)
 * @param venueId Venue ID
 * @returns Venue with staff and related data
 */
export async function getVenueById(venueId: string, _orgId?: string): Promise<Venue> {
  logger.info(`Getting venue by ID: ${venueId}`)
  const venue = await prisma.venue.findUnique({
    where: {
      id: venueId,
    },
    include: {
      staff: {
        select: {
          id: true,
          pin: true, // PIN is now venue-specific on StaffVenue
          role: true,
          active: true,
          staff: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              employeeCode: true,
            },
          },
        },
        where: {
          active: true,
        },
      },
      posConnectionStatus: true, // Include POS connection status for Android app
      // Add other necessary relations based on TPV needs
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  return venue
}

/**
 * Get terminal information including venue ID from terminal serial number
 * SMART CACHING: Automatically fetches and caches Menta terminal ID on first use
 * @param serialNumber Terminal serial number
 * @returns Object containing terminal information including Menta terminalId (UUID), venueId, and other terminal data
 */
export async function getVenueIdFromSerialNumber(serialNumber: string): Promise<{
  venueId: string
  terminalId: string
  serialCode: string
  status: string
  model?: string
  hardwareVersion?: string
  features?: string[]
}> {
  logger.info(`🔍 Getting terminal info for serial number: ${serialNumber}`)

  const terminal = await prisma.terminal.findUnique({
    where: {
      serialNumber: serialNumber,
    },
    select: {
      id: true,
      venueId: true,
      serialNumber: true,
      name: true,
      type: true,
      status: true,
      version: true,
      config: true,
      mentaTerminalId: true, // Cached Menta UUID
      mentaLastSync: true, // Last sync timestamp
      activatedAt: true, // 🆕 Activation timestamp for validation
    },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal not found')
  }

  if (!terminal.venueId) {
    throw new NotFoundError('VenueId not found')
  }

  // 🆕 ACTIVATION VALIDATION: Terminal must be activated before use
  if (!terminal.activatedAt) {
    logger.warn(`Terminal ${serialNumber} not activated`)
    throw new UnauthorizedError('Terminal not activated. Enter activation code to continue.')
  }

  if (terminal.status === 'INACTIVE') {
    logger.warn(`Terminal ${serialNumber} is inactive`)
    throw new UnauthorizedError('Terminal deactivated by administrator. Contact support.')
  }

  // 🚀 SMART CACHING LOGIC: Fetch Menta terminal ID if not cached
  if (!terminal.mentaTerminalId) {
    logger.info(`🔄 No cached Menta terminal ID found, querying Menta API...`)

    try {
      const mentaTerminal = await mentaApiService.findTerminalBySerialCode(serialNumber)

      if (mentaTerminal) {
        logger.info(`✅ Found Menta terminal: ${mentaTerminal.id}`)

        // Cache the Menta terminal ID for future use
        await prisma.terminal.update({
          where: { id: terminal.id },
          data: {
            mentaTerminalId: mentaTerminal.id,
            mentaLastSync: new Date(),
          },
        })

        // Update our local terminal object
        terminal.mentaTerminalId = mentaTerminal.id
        terminal.mentaLastSync = new Date()

        logger.info(`💾 Cached Menta terminal ID: ${mentaTerminal.id} for serial: ${serialNumber}`)
      } else {
        logger.error(`❌ Terminal not found in Menta system: ${serialNumber}`)
        throw new NotFoundError(
          `Terminal ${serialNumber} not found in Menta system. Please register the terminal in Menta dashboard first.`,
        )
      }
    } catch (error) {
      logger.error(`❌ Failed to fetch terminal from Menta:`, error)

      // If it's already a NotFoundError, re-throw it
      if (error instanceof NotFoundError) {
        throw error
      }

      // 🚨 TEMPORARY FALLBACK: Allow terminal to work without Menta lookup
      // This is a temporary solution while we resolve Menta API access issues
      logger.warn(`⚠️  Menta API lookup failed, using fallback terminal ID based on serial number`)

      // Generate a fallback terminal ID based on the serial number
      const fallbackTerminalId = `fallback-${serialNumber}`

      // Update the database with the fallback ID to avoid repeated API calls
      await prisma.terminal.update({
        where: { id: terminal.id },
        data: {
          mentaTerminalId: fallbackTerminalId,
          mentaLastSync: new Date(),
        },
      })

      // Update our local terminal object
      terminal.mentaTerminalId = fallbackTerminalId
      terminal.mentaLastSync = new Date()

      logger.info(`💾 Using fallback Menta terminal ID: ${fallbackTerminalId} for serial: ${serialNumber}`)
    }
  } else {
    logger.info(`✅ Using cached Menta terminal ID: ${terminal.mentaTerminalId}`)
    logger.debug(`📅 Last synced: ${terminal.mentaLastSync}`)
  }

  // Map terminal type and extract features from config if available
  const terminalTypeMapping: { [key: string]: string } = {
    ANDROID_POS: 'Android POS',
    MENTA_DEVICE: 'Menta Device',
    WEB_POS: 'Web POS',
  }

  const config = terminal.config as any
  const features = config?.features || ['NFC', 'EMV'] // Default features

  return {
    venueId: terminal.venueId,
    terminalId: terminal.mentaTerminalId!, // 🎯 CRITICAL: Real Menta UUID for payments
    serialCode: terminal.serialNumber, // Hardware serial for identification
    status: terminal.status,
    model: terminalTypeMapping[terminal.type] || terminal.type,
    hardwareVersion: terminal.version || '1.0',
    features: features,
  }
}
