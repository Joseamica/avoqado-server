import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { generateAccessToken, generateRefreshToken } from '../../security'
import { v4 as uuidv4 } from 'uuid'

/**
 * Staff sign-in using PIN for TPV access
 * @param venueId Venue ID
 * @param pin Staff PIN
 * @returns Staff information with venue-specific data
 */
export async function staffSignIn(venueId: string, pin: string) {
  logger.info(`Staff sign-in request for venue ${venueId} with PIN ${pin}`)
  // Validate required fields
  if (!pin) {
    throw new BadRequestError('PIN is required')
  }

  if (!venueId) {
    throw new BadRequestError('Venue ID is required')
  }

  // Find staff member with matching venue-specific PIN
  const staffVenue = await prisma.staffVenue.findUnique({
    where: {
      venueId_pin: {
        venueId: venueId,
        pin: pin,
      },
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
        },
      },
    },
  })

  if (!staffVenue) {
    throw new NotFoundError('Staff member not found or not authorized for this venue')
  }

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
    expiresIn: 3600, // 1 hour in seconds
    tokenType: 'Bearer',

    // Metadata
    correlationId,
    issuedAt: new Date().toISOString(),
  }
}
