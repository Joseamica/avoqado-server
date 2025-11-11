import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../errors/AppError'
import { generateAccessToken, generateRefreshToken, verifyToken } from '../../security'
import { v4 as uuidv4 } from 'uuid'

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
          posType: true,
          posStatus: true,
          logo: true,
        },
      },
    },
  })

  if (!staffVenue) {
    // ⚠️ SECURITY: Use generic error message to prevent PIN enumeration
    throw new NotFoundError('Pin Incorrecto')
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
    orgId: staffVenue.venueId, // Using venueId as orgId for consistency
    role: staffVenue.role,
    permissions: staffVenue.permissions,
    correlationId,
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
  const { sub: userId, venueId, orgId } = decoded

  // Verify user still exists and is active
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      staffId: userId,
      venueId: venueId,
      active: true,
      staff: {
        active: true,
      },
    },
    include: {
      staff: {
        select: {
          id: true,
          active: true,
        },
      },
    },
  })

  if (!staffVenue) {
    throw new UnauthorizedError('User no longer active or not authorized for this venue')
  }

  // Generate new access token with same permissions
  const correlationId = uuidv4()
  const tokenPayload = {
    userId: staffVenue.staffId,
    staffId: staffVenue.staffId,
    venueId: staffVenue.venueId,
    orgId: orgId || staffVenue.venueId,
    role: staffVenue.role,
    permissions: staffVenue.permissions,
    correlationId,
  }

  const newAccessToken = generateAccessToken(tokenPayload)

  logger.info('Access token refreshed successfully', {
    userId: staffVenue.staffId,
    venueId: staffVenue.venueId,
    correlationId,
  })

  return {
    accessToken: newAccessToken,
    expiresIn: 3600, // 1 hour in seconds
    tokenType: 'Bearer',
    correlationId,
    issuedAt: new Date().toISOString(),
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
