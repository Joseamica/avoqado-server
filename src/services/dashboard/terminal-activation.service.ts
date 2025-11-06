import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../errors/AppError'
import crypto from 'crypto'

/**
 * Generate Activation Code for Terminal
 *
 * Similar to Square POS device activation flow.
 * Creates a 6-character alphanumeric code that expires in 7 days.
 *
 * @param terminalId Terminal ID (CUID)
 * @param staffId Staff ID who is generating the code
 * @returns Activation code, expiry info
 */
export async function generateActivationCode(terminalId: string, staffId: string) {
  logger.info(`Generating activation code for terminal ${terminalId} by staff ${staffId}`)

  // Verify terminal exists
  const terminal = await prisma.terminal.findUnique({
    where: { id: terminalId },
    include: {
      venue: {
        select: { id: true, name: true },
      },
    },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal not found')
  }

  // Prevent generating code for already activated terminals
  if (terminal.activatedAt) {
    throw new BadRequestError('Terminal already activated. To re-activate, contact support or deactivate first.')
  }

  // Generate secure 6-character alphanumeric code
  // Format: A3F9K2 (36^6 = 2.1 billion combinations)
  const code = generateSecureCode(6)

  // Set expiry to 7 days from now
  const expiryDate = new Date()
  expiryDate.setDate(expiryDate.getDate() + 7)

  // Update terminal with activation code
  await prisma.terminal.update({
    where: { id: terminalId },
    data: {
      activationCode: code,
      activationCodeExpiry: expiryDate,
      activatedBy: staffId,
      activationAttempts: 0, // Reset attempts counter
      lastActivationAttempt: null,
    },
  })

  logger.info(`Activation code generated for terminal ${terminalId}: ${code} (expires: ${expiryDate.toISOString()})`)

  return {
    activationCode: code,
    expiresAt: expiryDate.toISOString(),
    expiresIn: 7 * 24 * 60 * 60, // 7 days in seconds
    terminalId: terminal.id,
    serialNumber: terminal.serialNumber,
    venueName: terminal.venue.name,
  }
}

/**
 * Activate Terminal with Activation Code
 *
 * Validates activation code and marks terminal as activated.
 * Implements anti-brute force protection (max 5 attempts).
 *
 * @param serialNumber Device serial number (e.g., AVQD-1A2B3C4D5E6F)
 * @param activationCode 6-char alphanumeric code (case-insensitive)
 * @returns venueId, terminalId, venue info
 */
export async function activateTerminal(serialNumber: string, activationCode: string) {
  logger.info(`Terminal activation attempt: serial=${serialNumber}, code=${activationCode}`)

  // Find terminal by serial number (case-insensitive)
  // ✅ CASE-INSENSITIVE: Android may send lowercase, DB stores uppercase
  const terminal = await prisma.terminal.findFirst({
    where: {
      serialNumber: {
        equals: serialNumber,
        mode: 'insensitive', // Case-insensitive matching
      },
    },
    include: {
      venue: {
        select: { id: true, name: true, slug: true },
      },
    },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal not registered. Contact your administrator.')
  }

  // Check if already activated
  if (terminal.activatedAt) {
    logger.warn(`Terminal ${serialNumber} already activated - returning activation data for re-sync`)

    // ✅ Return activation data instead of error
    // This handles app reinstalls / data clears gracefully
    // Android needs venueId to proceed to login screen

    // IMPORTANT: Reactivate terminal if status is INACTIVE
    // This handles the case where admin deactivated but user is re-activating
    if (terminal.status !== 'ACTIVE') {
      await prisma.terminal.update({
        where: { id: terminal.id },
        data: { status: 'ACTIVE' },
      })
      logger.info(`Terminal ${serialNumber} status updated to ACTIVE`)
    }

    return {
      venueId: terminal.venueId,
      terminalId: terminal.id,
      venueName: terminal.venue.name,
      venueSlug: terminal.venue.slug,
      activatedAt: terminal.activatedAt.toISOString(),
    }
  }

  // Anti-brute force: Check if locked (>5 failed attempts)
  if (terminal.activationAttempts >= 5) {
    logger.warn(`Terminal ${serialNumber} locked due to too many failed attempts`)
    throw new UnauthorizedError('Terminal locked due to too many failed activation attempts. Contact support.')
  }

  // Check if activation code exists
  if (!terminal.activationCode) {
    throw new BadRequestError('No activation code generated for this terminal. Contact administrator.')
  }

  // Check if code expired (>7 days)
  if (terminal.activationCodeExpiry && new Date() > terminal.activationCodeExpiry) {
    logger.warn(`Activation code expired for terminal ${serialNumber}`)
    throw new BadRequestError('Activation code expired. Request a new code from administrator.')
  }

  // Validate activation code (case-insensitive)
  const isCodeValid = terminal.activationCode.toUpperCase() === activationCode.toUpperCase()

  if (!isCodeValid) {
    // Increment failed attempts
    await prisma.terminal.update({
      where: { id: terminal.id },
      data: {
        activationAttempts: terminal.activationAttempts + 1,
        lastActivationAttempt: new Date(),
      },
    })

    const remainingAttempts = 5 - (terminal.activationAttempts + 1)
    logger.warn(`Invalid activation code for terminal ${serialNumber}. Attempts remaining: ${remainingAttempts}`)

    throw new UnauthorizedError(`Invalid activation code. ${remainingAttempts} attempt(s) remaining before lockout.`)
  }

  // ✅ CODE VALID - Activate terminal
  await prisma.terminal.update({
    where: { id: terminal.id },
    data: {
      activatedAt: new Date(),
      status: 'ACTIVE', // Change from INACTIVE to ACTIVE
      activationCode: null, // Clear code (single-use)
      activationCodeExpiry: null,
      activationAttempts: 0, // Reset counter
      lastActivationAttempt: new Date(),
    },
  })

  logger.info(`Terminal ${serialNumber} activated successfully for venue ${terminal.venue.name}`)

  return {
    venueId: terminal.venueId,
    terminalId: terminal.id,
    venueName: terminal.venue.name,
    venueSlug: terminal.venue.slug,
    activatedAt: new Date().toISOString(),
  }
}

/**
 * Generate secure alphanumeric code
 * @param length Code length (default: 6)
 * @returns Uppercase alphanumeric code
 */
function generateSecureCode(length: number = 6): string {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // Exclude confusing chars (0,O,1,I)
  let code = ''

  // Use crypto.randomBytes for cryptographically secure randomness
  const randomBytes = crypto.randomBytes(length)

  for (let i = 0; i < length; i++) {
    const randomIndex = randomBytes[i] % charset.length
    code += charset[randomIndex]
  }

  return code
}
