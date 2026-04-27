import { NextFunction, Request, Response } from 'express'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'

export async function getActiveStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const active = req.query.active !== 'false'

    const staffVenues = await prisma.staffVenue.findMany({
      where: {
        venueId,
        ...(active ? { active: true } : {}),
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
            photoUrl: true,
            active: true,
          },
        },
      },
      orderBy: {
        startDate: 'asc',
      },
    })

    res.status(200).json({
      success: true,
      data: staffVenues.map(staffVenue => ({
        id: staffVenue.staffId,
        firstName: staffVenue.staff.firstName,
        lastName: staffVenue.staff.lastName,
        email: staffVenue.staff.email,
        photoUrl: staffVenue.staff.photoUrl,
        role: staffVenue.role,
        active: staffVenue.active && staffVenue.staff.active,
      })),
    })
  } catch (error) {
    logger.error('Error in getActiveStaff controller:', error)
    next(error)
  }
}
