import prisma from '../../utils/prismaClient'
import { Venue } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import logger from '@/config/logger'

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
 * Get venue ID from terminal serial number
 * @param serialNumber Terminal serial number
 * @returns Object containing venueId
 */
export async function getVenueIdFromSerialNumber(serialNumber: string): Promise<{ venueId: string }> {
  const terminal = await prisma.terminal.findUnique({
    where: {
      serialNumber: serialNumber,
    },
    select: {
      venueId: true,
    },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal not found')
  }

  if (!terminal.venueId) {
    throw new NotFoundError('VenueId not found')
  }

  return { venueId: terminal.venueId }
}
