import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

interface ShiftFilters {
  staffId?: string
  startTime?: string
  endTime?: string
}

interface PaginationResponse<T> {
  data: T[]
  meta: {
    totalCount: number
    pageSize: number
    currentPage: number
    totalPages: number
    hasNextPage: boolean
    hasPrevPage: boolean
  }
}

interface ShiftSummaryResponse {
  dateRange: {
    startTime: Date | null
    endTime: Date | null
  }
  summary: {
    totalSales: number
    totalTips: number
    ordersCount: number
    averageTipPercentage: number
    ratingsCount: number
  }
  waiterTips: Array<{
    staffId: string
    name: string
    amount: number
    count: number
  }>
}

export async function getShifts(
  venueId: string,
  page: number,
  pageSize: number,
  filters: ShiftFilters = {},
): Promise<PaginationResponse<any>> {
  const { staffId, startTime, endTime } = filters

  const whereClause: any = {
    venueId: venueId,
  }

  if (startTime || endTime) {
    whereClause.startTime = {}

    if (startTime) {
      const parsedStartTime = new Date(startTime)
      if (!isNaN(parsedStartTime.getTime())) {
        whereClause.startTime.gte = parsedStartTime
      } else {
        throw new BadRequestError(`Invalid startTime: ${startTime}`)
      }
    }

    if (endTime) {
      const parsedEndTime = new Date(endTime)
      if (!isNaN(parsedEndTime.getTime())) {
        whereClause.startTime.lte = parsedEndTime
      } else {
        throw new BadRequestError(`Invalid endTime: ${endTime}`)
      }
    }

    if (Object.keys(whereClause.startTime).length === 0) {
      delete whereClause.startTime
    }
  }

  if (staffId) {
    whereClause.staffId = staffId
  }

  const skip = (page - 1) * pageSize

  const [shifts, totalCount] = await prisma.$transaction([
    prisma.shift.findMany({
      where: whereClause,
      include: {
        staff: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        venue: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: {
        startTime: 'desc',
      },
      skip,
      take: pageSize,
    }),
    prisma.shift.count({
      where: whereClause,
    }),
  ])

  const shiftsWithCalculations = shifts.map(shift => {
    // Determine effective status based on time logic
    const now = new Date()
    const effectiveStatus = shift.endTime && shift.endTime < now ? 'CLOSED' : shift.status

    return {
      id: shift.id,
      venueId: shift.venueId,
      staffId: shift.staffId,
      startTime: shift.startTime,
      endTime: shift.endTime,
      startingCash: Number(shift.startingCash),
      endingCash: shift.endingCash ? Number(shift.endingCash) : null,
      cashDifference: shift.cashDifference ? Number(shift.cashDifference) : null,
      totalSales: Number(shift.totalSales),
      totalTips: Number(shift.totalTips),
      totalOrders: shift.totalOrders,
      status: effectiveStatus,
      staff: shift.staff,
      venue: shift.venue,
    }
  })

  const totalPages = Math.ceil(totalCount / pageSize)

  return {
    data: shiftsWithCalculations,
    meta: {
      totalCount,
      pageSize,
      currentPage: page,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  }
}

export async function getShiftById(venueId: string, shiftId: string): Promise<any | null> {
  const shift = await prisma.shift.findFirst({
    where: {
      id: shiftId,
      venueId: venueId,
    },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
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

  if (!shift) {
    return null
  }

  // Determine effective status based on time logic
  const now = new Date()
  const effectiveStatus = shift.endTime && shift.endTime < now ? 'CLOSED' : shift.status

  return {
    id: shift.id,
    venueId: shift.venueId,
    staffId: shift.staffId,
    startTime: shift.startTime,
    endTime: shift.endTime,
    startingCash: Number(shift.startingCash),
    endingCash: shift.endingCash ? Number(shift.endingCash) : null,
    cashDifference: shift.cashDifference ? Number(shift.cashDifference) : null,
    totalSales: Number(shift.totalSales),
    totalTips: Number(shift.totalTips),
    totalOrders: shift.totalOrders,
    status: effectiveStatus,
    staff: shift.staff,
    venue: shift.venue,
  }
}

export async function getShiftsSummary(venueId: string, filters: ShiftFilters = {}): Promise<ShiftSummaryResponse> {
  const { staffId, startTime, endTime } = filters

  const whereClause: any = {
    venueId: venueId,
  }

  if (startTime || endTime) {
    whereClause.startTime = {}

    if (startTime) {
      const parsedStartTime = new Date(startTime)
      if (!isNaN(parsedStartTime.getTime())) {
        whereClause.startTime.gte = parsedStartTime
      } else {
        throw new BadRequestError(`Invalid startTime: ${startTime}`)
      }
    }

    if (endTime) {
      const parsedEndTime = new Date(endTime)
      if (!isNaN(parsedEndTime.getTime())) {
        whereClause.startTime.lte = parsedEndTime
      } else {
        throw new BadRequestError(`Invalid endTime: ${endTime}`)
      }
    }

    if (Object.keys(whereClause.startTime).length === 0) {
      delete whereClause.startTime
    }
  }

  if (staffId) {
    whereClause.staffId = staffId
  }

  const shifts = await prisma.shift.findMany({
    where: whereClause,
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  let totalSales = 0
  let totalTips = 0
  let totalOrders = 0

  const staffTipsMap: Map<string, { name: string; amount: number; count: number }> = new Map()

  for (const shift of shifts) {
    totalSales += Number(shift.totalSales)
    totalTips += Number(shift.totalTips)
    totalOrders += shift.totalOrders

    const staffId = shift.staffId
    const staffName = shift.staff ? `${shift.staff.firstName} ${shift.staff.lastName}` : 'Unknown'
    const tipAmount = Number(shift.totalTips)

    if (staffId && tipAmount > 0) {
      if (staffTipsMap.has(staffId)) {
        const staffData = staffTipsMap.get(staffId)!
        staffData.amount += tipAmount
        staffData.count += 1
      } else {
        staffTipsMap.set(staffId, {
          name: staffName,
          amount: tipAmount,
          count: 1,
        })
      }
    }
  }

  let totalRatings = 0
  try {
    const reviewWhereClause: any = {
      venueId,
    }

    if (startTime || endTime) {
      reviewWhereClause.createdAt = {}

      if (startTime) {
        reviewWhereClause.createdAt.gte = new Date(startTime)
      }
      if (endTime) {
        reviewWhereClause.createdAt.lte = new Date(endTime)
      }
    }

    totalRatings = await prisma.review.count({
      where: reviewWhereClause,
    })
  } catch (error) {
    logger.warn('Error counting reviews:', error)
  }

  const averageTipPercentage = totalSales > 0 ? (totalTips / totalSales) * 100 : 0

  const waiterTips = Array.from(staffTipsMap.entries())
    .map(([id, data]) => ({
      staffId: id,
      name: data.name,
      amount: data.amount,
      count: data.count,
    }))
    .sort((a, b) => b.amount - a.amount)

  return {
    dateRange: {
      startTime: startTime ? new Date(startTime) : null,
      endTime: endTime ? new Date(endTime) : null,
    },
    summary: {
      totalSales: totalSales,
      totalTips: totalTips,
      ordersCount: totalOrders,
      averageTipPercentage: Number(averageTipPercentage.toFixed(2)),
      ratingsCount: totalRatings,
    },
    waiterTips: waiterTips,
  }
}

/**
 * Delete a shift by ID
 * @param venueId Venue ID
 * @param shiftId Shift ID to delete
 * @returns boolean indicating if shift was deleted
 */
export async function deleteShift(venueId: string, shiftId: string): Promise<boolean> {
  try {
    logger.info('Deleting shift', { venueId, shiftId })

    // First check if shift exists and belongs to the venue
    const existingShift = await prisma.shift.findFirst({
      where: {
        id: shiftId,
        venueId: venueId,
      },
    })

    if (!existingShift) {
      logger.warn('Shift not found for deletion', { venueId, shiftId })
      return false
    }

    // Check if shift is still open using time-based logic
    const now = new Date()
    const effectiveStatus = existingShift.endTime && existingShift.endTime < now ? 'CLOSED' : existingShift.status

    if (effectiveStatus === 'OPEN') {
      logger.warn('Cannot delete open shift', { venueId, shiftId, status: existingShift.status, effectiveStatus })
      throw new BadRequestError('Cannot delete an open shift. Please close the shift first.')
    }

    // Delete the shift
    await prisma.shift.delete({
      where: {
        id: shiftId,
      },
    })

    logger.info('Shift deleted successfully', { venueId, shiftId })
    return true
  } catch (error) {
    logger.error('Error deleting shift', { venueId, shiftId, error })
    throw error
  }
}
