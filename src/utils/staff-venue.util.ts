import type { Prisma } from '@prisma/client'
import logger from '../config/logger'
import { BadRequestError } from '../errors/AppError'
import prisma from './prismaClient'

/**
 * Validate that a staff member belongs to a venue and is active.
 *
 * If `staffId` is omitted, `userId` is used as a fallback and is validated
 * through the same StaffVenue check. Numeric legacy staff ids are mapped to
 * active StaffVenue rows using the existing Android compatibility behavior.
 *
 * `db`: inside a money transaction, pass ITS client (`tx`). The global client there asks for a SECOND connection while the transaction
 * holds its own; with as many concurrent transactions as pool connections, all of them stall (S10 r2, Codex r2 P2-a).
 */
export async function validateStaffVenue(
  staffId: string | undefined,
  venueId: string,
  userId?: string,
  db: Pick<Prisma.TransactionClient, 'staffVenue'> = prisma,
): Promise<string | undefined> {
  let actualStaffId = staffId || userId

  if (!actualStaffId) {
    return undefined
  }

  // TEMP FIX: Handle numeric staffId from older Android clients (e.g., "1", "2", "3").
  if (/^\d+$/.test(actualStaffId)) {
    logger.warn('[StaffVenue] Received numeric staffId from client', { staffId: actualStaffId, venueId })

    try {
      const staffVenues = await db.staffVenue.findMany({
        where: {
          venueId,
          active: true,
        },
        include: {
          staff: true,
        },
        orderBy: {
          startDate: 'asc',
        },
      })

      if (staffVenues.length === 0) {
        throw new BadRequestError(`No active staff found for venue ${venueId}`)
      }

      const staffIndex = parseInt(actualStaffId, 10) - 1
      if (staffIndex < 0 || staffIndex >= staffVenues.length) {
        logger.error('[StaffVenue] Invalid staff index', { staffId: actualStaffId, staffIndex, availableStaff: staffVenues.length })
        throw new BadRequestError(`Invalid staff index ${actualStaffId}. Available staff: 1-${staffVenues.length}`)
      }

      actualStaffId = staffVenues[staffIndex].staffId
      logger.info('[StaffVenue] Mapped numeric staffId to CUID', {
        originalStaffId: staffId,
        fallbackUserId: userId,
        mappedStaffId: actualStaffId,
        staffName: `${staffVenues[staffIndex].staff?.firstName || 'Unknown'} ${staffVenues[staffIndex].staff?.lastName || 'Staff'}`,
      })
    } catch (error) {
      logger.error('[StaffVenue] Failed to map numeric staffId', { staffId: actualStaffId, venueId, error })
      throw new BadRequestError(`Failed to resolve staff ID ${actualStaffId} for venue ${venueId}`)
    }
  }

  const staffVenue = await db.staffVenue.findFirst({
    where: {
      staffId: actualStaffId,
      venueId,
      active: true,
    },
    include: {
      staff: true,
    },
  })

  if (!staffVenue) {
    throw new BadRequestError(`Staff ${actualStaffId} is not assigned to venue ${venueId} or is inactive`)
  }

  return staffVenue.staffId
}
