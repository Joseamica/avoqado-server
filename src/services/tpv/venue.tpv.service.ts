import prisma from '../../utils/prismaClient'
import { Venue, VenueSettings } from '@prisma/client'
import { NotFoundError, UnauthorizedError } from '../../errors/AppError'
import logger from '@/config/logger'
import { getDeviceReceiptPayload, type DeviceReceiptPayload } from '../dashboard/receiptLayout/devicePayload.service'
// import { mentaApiService } from './menta.api.service' // 🚫 Disabled: Not using Menta integration

/**
 * Get venue by ID for TPV usage
 *
 * NOTE: TPV Settings (showReviewScreen, showTipScreen, etc.) are now per-terminal.
 * Use GET /tpv/terminals/:serialNumber/config to fetch terminal-specific settings.
 *
 * @param orgId optional Organization ID (for future authorization)
 * @param venueId Venue ID
 * @returns Venue with staff, settings, and related data
 */
export async function getVenueById(
  venueId: string,
  _orgId?: string,
): Promise<Venue & { settings: VenueSettings | null } & DeviceReceiptPayload> {
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
      settings: true, // Include venue settings (non-TPV settings only)
      // Add other necessary relations based on TPV needs
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Encabezado y diseño del ticket (spec § 7.3). EL MISMO constructor que usa el endpoint de
  // mobile: si cada lado armara lo suyo, la PAX y las tablets imprimirían distinto y los casos
  // dorados no lo cazarían (prueban el intérprete, no el transporte).
  //
  // 🔴 Aditivo y tolerante: si falla, los campos se omiten y el venue sale igual. Gson ignora
  // lo que no conoce, así que una PAX vieja no se entera de que existen.
  const receiptPayload = await getDeviceReceiptPayload(venueId).catch(error => {
    logger.error('No se pudo resolver el ticket para el venue de la PAX; se devuelve sin esos campos', { venueId, error })
    return {} as DeviceReceiptPayload
  })

  return { ...venue, ...receiptPayload }
}

/**
 * Get terminal information including venue ID from terminal serial number
 *
 * **Terminal Identification:**
 * - Uses serial number directly as terminalId (no Menta integration)
 * - Validates terminal activation status before returning info
 *
 * @param serialNumber Terminal serial number (e.g., "AVQD-6D52CB5103BB42DC")
 * @returns Object containing terminal information (venueId, terminalId = serialNumber, status, etc.)
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

  // ✅ CASE-INSENSITIVE: Android may send lowercase, DB stores uppercase
  const terminal = await prisma.terminal.findFirst({
    where: {
      serialNumber: {
        equals: serialNumber,
        mode: 'insensitive', // Case-insensitive matching
      },
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
      mentaTerminalId: true, // Cached Menta UUID (legacy, not used anymore)
      mentaLastSync: true, // Last sync timestamp (legacy, not used anymore)
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

  // 🚫 MENTA INTEGRATION DISABLED (2025-01-05)
  // We are not using Menta payment gateway anymore.
  // Keeping this code commented in case we integrate with Menta in the future.
  //
  // Original logic: Fetch Menta terminal UUID and cache it in terminal.mentaTerminalId
  // Now: Use serial number as terminal identifier instead
  //
  // if (!terminal.mentaTerminalId) {
  //   logger.info(`🔄 No cached Menta terminal ID found, querying Menta API...`)
  //
  //   try {
  //     const mentaTerminal = await mentaApiService.findTerminalBySerialCode(serialNumber)
  //
  //     if (mentaTerminal) {
  //       logger.info(`✅ Found Menta terminal: ${mentaTerminal.id}`)
  //
  //       // Cache the Menta terminal ID for future use
  //       await prisma.terminal.update({
  //         where: { id: terminal.id },
  //         data: {
  //           mentaTerminalId: mentaTerminal.id,
  //           mentaLastSync: new Date(),
  //         },
  //       })
  //
  //       terminal.mentaTerminalId = mentaTerminal.id
  //       terminal.mentaLastSync = new Date()
  //
  //       logger.info(`💾 Cached Menta terminal ID: ${mentaTerminal.id} for serial: ${serialNumber}`)
  //     } else {
  //       logger.error(`❌ Terminal not found in Menta system: ${serialNumber}`)
  //       throw new NotFoundError(
  //         `Terminal ${serialNumber} not found in Menta system. Please register the terminal in Menta dashboard first.`,
  //       )
  //     }
  //   } catch (error) {
  //     logger.error(`❌ Failed to fetch terminal from Menta:`, error)
  //
  //     if (error instanceof NotFoundError) {
  //       throw error
  //     }
  //
  //     // Fallback: Use serial number as terminal ID
  //     const fallbackTerminalId = `fallback-${serialNumber}`
  //
  //     await prisma.terminal.update({
  //       where: { id: terminal.id },
  //       data: {
  //         mentaTerminalId: fallbackTerminalId,
  //         mentaLastSync: new Date(),
  //       },
  //     })
  //
  //     terminal.mentaTerminalId = fallbackTerminalId
  //     terminal.mentaLastSync = new Date()
  //
  //     logger.info(`💾 Using fallback Menta terminal ID: ${fallbackTerminalId} for serial: ${serialNumber}`)
  //   }
  // } else {
  //   logger.info(`✅ Using cached Menta terminal ID: ${terminal.mentaTerminalId}`)
  //   logger.debug(`📅 Last synced: ${terminal.mentaLastSync}`)
  // }

  // ✅ NEW SIMPLIFIED LOGIC: Use serial number directly as terminal ID
  // No Menta integration needed
  logger.info(`✅ Using serial number as terminal ID: ${serialNumber}`)

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
    terminalId: terminal.serialNumber || terminal.id, // Use serial if available, fallback to ID
    serialCode: terminal.serialNumber || '', // Hardware serial for identification (empty if not activated)
    status: terminal.status,
    model: terminalTypeMapping[terminal.type] || terminal.type,
    hardwareVersion: terminal.version || '1.0',
    features: features,
  }
}
