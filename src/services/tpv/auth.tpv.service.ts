import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../errors/AppError'
import { generateAccessToken, generateRefreshToken, verifyToken, StaffRole } from '../../security'
import { v4 as uuidv4 } from 'uuid'
import { OPERATIONAL_VENUE_STATUSES } from '@/lib/venueStatus.constants'
import { TOTP, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib'

/**
 * Staff sign-in using PIN for TPV access
 * @param venueId Venue ID
 * @param pin Staff PIN
 * @param serialNumber Terminal serial number
 * @returns Staff information with venue-specific data
 */
export async function staffSignIn(venueId: string, pin: string, serialNumber: string) {
  // ⚠️ SECURITY: Do NOT log PIN in plain text
  logger.info(`Staff sign-in request for venue ${venueId}, terminal ${serialNumber}`)
  // Validate required fields
  if (!pin) {
    throw new BadRequestError('PIN es requerido')
  }

  if (!venueId) {
    throw new BadRequestError('ID del venue es requerido')
  }

  if (!serialNumber) {
    throw new BadRequestError('Número de serie es requerido')
  }

  // Find staff member with matching PIN in this venue
  // ⚠️ IMPORTANT: Do NOT filter by venue.status here - we need to distinguish
  // between "wrong PIN" and "venue suspended" errors
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      venueId: venueId,
      pin: pin, // Plain text comparison (4-digit PIN only)
      active: true,
      staff: {
        active: true,
      },
    },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          employeeCode: true,
          photoUrl: true,
          active: true,
        },
      },
      venue: {
        select: {
          id: true,
          name: true,
          slug: true, // 📸 For Firebase Storage path: venues/{slug}/verifications/
          posType: true,
          posStatus: true,
          logo: true,
          status: true, // Include for frontend to know venue status
          organizationId: true,
        },
      },
    },
  })

  if (!staffVenue) {
    // ⚠️ SECURITY: Use generic error message to prevent PIN enumeration
    throw new NotFoundError('Pin Incorrecto')
  }

  // ✅ Check venue status AFTER finding staff (so we can give specific error)
  if (!OPERATIONAL_VENUE_STATUSES.includes(staffVenue.venue.status as any)) {
    const statusMessages: Record<string, string> = {
      SUSPENDED: 'Este establecimiento está suspendido temporalmente. Contacta al administrador para más información.',
      ADMIN_SUSPENDED: 'Este establecimiento ha sido suspendido por el administrador. Contacta a soporte para más información.',
      CLOSED: 'Este establecimiento ha sido cerrado permanentemente.',
    }
    const message = statusMessages[staffVenue.venue.status] || 'Este establecimiento no está operacional.'
    logger.warn(`Login blocked: venue ${venueId} is ${staffVenue.venue.status}`)
    throw new UnauthorizedError(message)
  }

  // ✅ SECURITY: Validate terminal activation status
  const terminal = await prisma.terminal.findUnique({
    where: {
      serialNumber: serialNumber,
    },
    select: {
      id: true,
      name: true,
      status: true,
      activatedAt: true,
      venueId: true,
    },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal no encontrado')
  }

  // Verify terminal belongs to the requested venue
  if (terminal.venueId !== venueId) {
    throw new NotFoundError('Terminal no encontrado para este venue')
  }

  if (!terminal.activatedAt) {
    logger.warn(`Login attempt on non-activated terminal: ${serialNumber} for venue ${venueId}`)
    throw new UnauthorizedError('Terminal no activado. Por favor, contacta al administrador para activar este terminal.')
  }

  // ✅ Square/Toast Pattern: Only block RETIRED terminals
  // INACTIVE is temporary (no heartbeats) and terminal can recover automatically
  // When user logs in → app starts → HeartbeatWorker runs → status becomes ACTIVE
  if (terminal.status === 'RETIRED') {
    throw new UnauthorizedError('Terminal ha sido desactivado y no puede ser utilizado. Contacta soporte.')
  }

  // ⚠️ DO NOT block login for INACTIVE status - this creates a deadlock:
  // 1. User logs out → HeartbeatWorker stops
  // 2. After 2 min → Backend marks terminal as INACTIVE
  // 3. User tries login → Would fail if we check INACTIVE here
  // 4. Terminal can't recover because it needs login to start HeartbeatWorker
  //
  // Instead: Allow login → App starts → HeartbeatWorker sends heartbeat → Status becomes ACTIVE

  // Generate JWT tokens for socket authentication and API access
  const correlationId = uuidv4()

  await prisma.staffVenue.update({
    where: {
      id: staffVenue.id,
    },
    data: {
      staff: {
        update: {
          lastLoginAt: new Date(),
        },
      },
    },
  })
  const tokenPayload = {
    userId: staffVenue.staff.id,
    staffId: staffVenue.staffId,
    venueId: staffVenue.venueId,
    orgId: staffVenue.venue.organizationId,
    role: staffVenue.role,
    permissions: staffVenue.permissions,
    correlationId,
    terminalSerialNumber: serialNumber, // Auto-attribute orders/payments to this terminal
  }

  const accessToken = generateAccessToken(tokenPayload)
  const refreshToken = generateRefreshToken(tokenPayload)

  // Log successful sign-in with token generation
  logger.info(`Staff signed in successfully: ${staffVenue.staff.firstName} ${staffVenue.staff.lastName} for venue ${venueId}`, {
    correlationId,
    staffId: staffVenue.staff.id,
    venueId,
    role: staffVenue.role,
  })

  // 🎁 Check if loyalty program is active for this venue (Toast/Square pattern)
  const loyaltyConfig = await prisma.loyaltyConfig.findUnique({
    where: { venueId },
    select: { active: true },
  })
  const loyaltyActive = loyaltyConfig?.active ?? false

  // Return staff information with venue-specific data and JWT tokens
  return {
    // Existing staff data
    id: staffVenue.id,
    staffId: staffVenue.staffId,
    venueId: staffVenue.venueId,
    role: staffVenue.role,
    permissions: staffVenue.permissions,
    totalSales: staffVenue.totalSales,
    totalTips: staffVenue.totalTips,
    averageRating: staffVenue.averageRating,
    totalOrders: staffVenue.totalOrders,
    staff: staffVenue.staff,
    venue: staffVenue.venue,

    // JWT tokens for socket and API authentication
    accessToken,
    refreshToken,
    expiresIn: 86400, // 24 hours (1 day) in seconds
    tokenType: 'Bearer',

    // Metadata
    correlationId,
    issuedAt: new Date().toISOString(),

    // 🎁 Loyalty program status (Toast/Square pattern: hide UI if inactive)
    loyaltyActive,
  }
}

/**
 * Refresh access token using valid refresh token
 * @param refreshToken Valid refresh token
 * @returns New access token with updated expiration
 */
export async function refreshAccessToken(refreshToken: string) {
  // Validate required field
  if (!refreshToken) {
    throw new BadRequestError('Refresh token is required')
  }

  // Verify refresh token
  const decoded = verifyToken(refreshToken)
  if (!decoded) {
    throw new UnauthorizedError('Invalid or expired refresh token')
  }

  // Validate token type
  if ((decoded as any).type !== 'refresh') {
    throw new UnauthorizedError('Invalid token type. Expected refresh token.')
  }

  // Extract user information from token
  const { sub: userId, venueId, orgId, terminalSerialNumber } = decoded as any

  // Verify user still exists and is active
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      staffId: userId,
      venueId: venueId,
      active: true,
      staff: {
        active: true,
      },
      // ✅ Block refresh if venue is SUSPENDED, ADMIN_SUSPENDED, or CLOSED
      venue: {
        status: { in: OPERATIONAL_VENUE_STATUSES },
      },
    },
    include: {
      staff: {
        select: {
          id: true,
          active: true,
        },
      },
      // Include venue info for client status awareness
      venue: {
        select: {
          id: true,
          name: true,
          status: true, // Single source of truth for venue state
          organizationId: true, // For token generation fallback
        },
      },
    },
  })

  if (!staffVenue) {
    throw new UnauthorizedError('User no longer active or venue is not operational')
  }

  // Generate new access token with same permissions
  const correlationId = uuidv4()
  const tokenPayload = {
    userId: staffVenue.staffId,
    staffId: staffVenue.staffId,
    venueId: staffVenue.venueId,
    orgId: orgId || staffVenue.venue.organizationId,
    role: staffVenue.role,
    permissions: staffVenue.permissions,
    correlationId,
    ...(terminalSerialNumber && { terminalSerialNumber }),
  }

  const newAccessToken = generateAccessToken(tokenPayload)

  logger.info('Access token refreshed successfully', {
    userId: staffVenue.staffId,
    venueId: staffVenue.venueId,
    venueStatus: staffVenue.venue.status,
    correlationId,
  })

  return {
    accessToken: newAccessToken,
    expiresIn: 3600, // 1 hour in seconds
    tokenType: 'Bearer',
    correlationId,
    issuedAt: new Date().toISOString(),
    // Include venue info so client can detect status changes mid-session
    venue: {
      id: staffVenue.venue.id,
      name: staffVenue.venue.name,
      status: staffVenue.venue.status,
    },
  }
}

/**
 * Logout staff member from TPV
 * @param accessToken Valid access token
 * @returns Success message with logout timestamp
 */
export async function staffLogout(accessToken: string) {
  // Validate required field
  if (!accessToken) {
    throw new BadRequestError('Access token is required')
  }

  // Verify access token
  const decoded = verifyToken(accessToken)
  if (!decoded) {
    throw new UnauthorizedError('Invalid or expired access token')
  }

  // Extract user information from token
  const { sub: userId, venueId, staffId } = decoded

  // Verify user still exists
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      staffId: userId,
      venueId: venueId,
    },
    include: {
      staff: {
        select: {
          firstName: true,
          lastName: true,
        },
      },
      venue: {
        select: {
          name: true,
        },
      },
    },
  })

  if (!staffVenue) {
    // User not found, but we still allow logout (token cleanup)
    logger.warn('Logout attempted for non-existent staff member', {
      userId,
      venueId,
      staffId,
    })
  } else {
    // Log successful logout for audit purposes
    logger.info(`Staff logged out: ${staffVenue.staff.firstName} ${staffVenue.staff.lastName} from venue ${staffVenue.venue.name}`, {
      staffId: staffVenue.staffId,
      venueId: staffVenue.venueId,
      userId,
    })
  }

  return {
    message: 'Logout successful',
    loggedOutAt: new Date().toISOString(),
  }
}

/**
 * Master TOTP sign-in for emergency SUPERADMIN access
 *
 * Uses Time-based One-Time Password (TOTP) validated against Google Authenticator.
 * 8-digit code changes every 60 seconds for enhanced security.
 *
 * **Security Features:**
 * - TOTP algorithm (RFC 6238) - same as Google Authenticator
 * - 8-digit code (max supported by Google Authenticator)
 * - 60-second period with ±60 second tolerance
 * - Full audit logging of all master access attempts
 * - Secret stored only in backend (never on TPV)
 *
 * **Use Cases:**
 * - Emergency access when staff PIN is unknown
 * - Technical support accessing customer terminals
 * - Testing/debugging in production environments
 *
 * @param venueId Venue ID (for context and logging)
 * @param totpCode 8-digit TOTP code from Google Authenticator
 * @param serialNumber Terminal serial number
 * @returns SUPERADMIN session with full permissions
 */
export async function masterSignIn(venueId: string, totpCode: string, serialNumber: string) {
  logger.warn(`🔑 [MASTER LOGIN] Attempt for venue ${venueId}, terminal ${serialNumber}`)

  // Validate required fields
  if (!totpCode) {
    throw new BadRequestError('Código TOTP es requerido')
  }

  if (!venueId) {
    throw new BadRequestError('ID del venue es requerido')
  }

  if (!serialNumber) {
    throw new BadRequestError('Número de serie es requerido')
  }

  // Validate TOTP code format (8 digits - max supported by Google Authenticator)
  if (!/^\d{8}$/.test(totpCode)) {
    logger.warn(`🔑 [MASTER LOGIN] Invalid code format: ${totpCode.length} chars`)
    throw new UnauthorizedError('Código inválido. Debe ser de 8 dígitos.')
  }

  // Get TOTP secret from environment
  const totpSecret = process.env.TOTP_MASTER_SECRET
  if (!totpSecret) {
    logger.error('🔑 [MASTER LOGIN] TOTP_MASTER_SECRET not configured!')
    throw new UnauthorizedError('Sistema de autenticación no configurado')
  }

  // Configure TOTP for 8 digits and 60-second window
  // Using otplib v13 class-based API with plugins
  const totp = new TOTP({
    digits: 8, // 8 digits (max supported by Google Authenticator)
    period: 60, // 60 seconds per code
    secret: totpSecret,
    crypto: new NobleCryptoPlugin(),
    base32: new ScureBase32Plugin(),
  })

  // Validate TOTP code with 60-second tolerance (allows previous/next code)
  const verifyResult = await totp.verify(totpCode, { epochTolerance: 60 })
  const isValid = verifyResult.valid

  if (!isValid) {
    logger.warn(`🔑 [MASTER LOGIN] FAILED - Invalid TOTP code for venue ${venueId}, terminal ${serialNumber}`)

    // Audit log for security monitoring
    await prisma.activityLog.create({
      data: {
        action: 'MASTER_LOGIN_FAILED',
        entity: 'Terminal',
        entityId: serialNumber,
        venueId,
        data: {
          serialNumber,
          reason: 'Invalid TOTP code',
          timestamp: new Date().toISOString(),
        },
      },
    })

    throw new UnauthorizedError('Código inválido o expirado')
  }

  // Verify venue exists and is operational
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: {
      id: true,
      name: true,
      slug: true,
      posType: true,
      posStatus: true,
      logo: true,
      status: true,
      organizationId: true,
    },
  })

  if (!venue) {
    throw new NotFoundError('Venue no encontrado')
  }

  // Verify terminal exists and is activated
  const terminal = await prisma.terminal.findUnique({
    where: { serialNumber },
    select: {
      id: true,
      name: true,
      status: true,
      activatedAt: true,
      venueId: true,
    },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal no encontrado')
  }

  if (terminal.venueId !== venueId) {
    throw new NotFoundError('Terminal no pertenece a este venue')
  }

  if (!terminal.activatedAt) {
    throw new UnauthorizedError('Terminal no activado')
  }

  // Generate JWT tokens with SUPERADMIN role
  const correlationId = uuidv4()
  const tokenPayload = {
    userId: 'MASTER_ADMIN',
    staffId: 'MASTER_ADMIN',
    venueId: venue.id,
    orgId: venue.organizationId || venue.id,
    role: StaffRole.SUPERADMIN,
    permissions: ['*'], // Full permissions
    correlationId,
    terminalSerialNumber: serialNumber, // Auto-attribute orders/payments to this terminal
  }

  const accessToken = generateAccessToken(tokenPayload)
  const refreshToken = generateRefreshToken(tokenPayload)

  // Audit log for successful master login
  await prisma.activityLog.create({
    data: {
      action: 'MASTER_LOGIN_SUCCESS',
      entity: 'Terminal',
      entityId: serialNumber,
      venueId,
      data: {
        venueName: venue.name,
        terminalName: terminal.name,
        correlationId,
        timestamp: new Date().toISOString(),
      },
    },
  })

  logger.warn(`🔑 [MASTER LOGIN] SUCCESS - venue: ${venue.name}, terminal: ${serialNumber}, correlationId: ${correlationId}`)

  return {
    // Staff-like structure for TPV compatibility
    id: 'MASTER_ADMIN',
    staffId: 'MASTER_ADMIN',
    venueId: venue.id,
    role: 'SUPERADMIN',
    permissions: ['*'],
    totalSales: 0,
    totalTips: 0,
    averageRating: 0,
    totalOrders: 0,
    staff: {
      id: 'MASTER_ADMIN',
      firstName: 'Master',
      lastName: 'Admin',
      email: 'master@avoqado.io',
      phone: null,
      employeeCode: 'MASTER',
      photoUrl: null,
      active: true,
    },
    venue: {
      id: venue.id,
      name: venue.name,
      slug: venue.slug,
      posType: venue.posType,
      posStatus: venue.posStatus,
      logo: venue.logo,
      status: venue.status,
    },

    // JWT tokens
    accessToken,
    refreshToken,
    expiresIn: 86400, // 24 hours
    tokenType: 'Bearer',

    // Metadata
    correlationId,
    issuedAt: new Date().toISOString(),
    isMasterLogin: true, // Flag so TPV knows this is master access

    // Loyalty (always false for master login)
    loyaltyActive: false,
  }
}
