import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'

/**
 * Staff sign-in using PIN for TPV access
 * @param venueId Venue ID
 * @param pin Staff PIN
 * @returns Staff information with venue-specific data
 */
export async function staffSignIn(venueId: string, pin: string) {
  // Validate required fields
  if (!pin) {
    throw new BadRequestError('PIN is required')
  }

  if (!venueId) {
    throw new BadRequestError('Venue ID is required')
  }

  // Find staff member with the given PIN who has access to the venue
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      venueId,
      active: true,
      staff: {
        pin,
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

  // Log successful sign-in
  logger.info(`Staff signed in successfully: ${staffVenue.staff.firstName} ${staffVenue.staff.lastName} for venue ${venueId}`)

  // Return staff information with venue-specific data
  return {
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
  }
}
