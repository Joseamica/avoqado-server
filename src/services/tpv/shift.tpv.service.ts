import { Shift } from '@prisma/client'
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
    diagnostics?: any
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

/**
 * Get current active shift for a venue
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @param posName POS name (optional)
 * @returns Current active shift or null
 */
export async function getCurrentShift(venueId: string, _orgId?: string, _posName?: string): Promise<Shift | null> {
  // Look up shift in database
  const shift = await prisma.shift.findFirst({
    where: {
      venueId: venueId,
      endTime: null, // Shift must still be open (endTime es DateTime?)
      // ✅ Removemos startTime: { not: null } porque startTime es requerido
    },
    orderBy: {
      startTime: 'desc', // Get the most recent open shift
    },
  })

  return shift
}

/**
 * Get shifts for a venue with pagination and filtering
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @param pageSize Number of items per page
 * @param pageNumber Page number
 * @param filters Filter options
 * @returns Paginated shift results
 */
export async function getShifts(
  venueId: string,
  pageSize: number,
  pageNumber: number,
  filters: ShiftFilters = {},
  _orgId?: string,
): Promise<PaginationResponse<any>> {
  const { staffId, startTime, endTime } = filters

  // Parse date filters once for reuse
  let parsedStartTime: Date | undefined
  let parsedEndTime: Date | undefined

  if (startTime) {
    parsedStartTime = new Date(startTime)
    if (isNaN(parsedStartTime.getTime())) {
      throw new BadRequestError(`Invalid startTime: ${startTime}`)
    }
  }

  if (endTime) {
    parsedEndTime = new Date(endTime)
    if (isNaN(parsedEndTime.getTime())) {
      throw new BadRequestError(`Invalid endTime: ${endTime}`)
    }
  }

  // Build payment filter for date range
  const paymentDateFilter: any = {}
  if (parsedStartTime || parsedEndTime) {
    paymentDateFilter.createdAt = {}
    if (parsedStartTime) {
      paymentDateFilter.createdAt.gte = parsedStartTime
    }
    if (parsedEndTime) {
      paymentDateFilter.createdAt.lte = parsedEndTime
    }
  }

  // Build the base query filters for shifts
  const whereClause: any = {
    venueId: venueId,
  }

  // If date filters are provided, include shifts that:
  // 1. Were active during the period
  // 2. Have payments in the period
  if (parsedStartTime || parsedEndTime) {
    whereClause.OR = [
      // Include open shifts (they might have today's payments)
      { endTime: null },
      // Include closed shifts that overlap with the date range
      {
        // Shift was active during this period
        AND: [
          parsedStartTime ? { startTime: { lte: parsedEndTime || parsedStartTime } } : {},
          parsedEndTime
            ? {
                OR: [{ endTime: null }, { endTime: { gte: parsedStartTime || parsedEndTime } }],
              }
            : {},
        ].filter(obj => Object.keys(obj).length > 0),
      },
      // Or shift has payments in this period
      {
        payments: {
          some: paymentDateFilter,
        },
      },
    ]
  }

  // Calculate pagination values
  const skip = (pageNumber - 1) * pageSize

  // Get the shifts with related data
  const [shifts, totalCount] = await prisma.$transaction([
    prisma.shift.findMany({
      where: whereClause,
      include: {
        orders: {
          include: {
            payments: {
              where: {
                ...(staffId ? { processedById: staffId } : {}),
                // Filter payments by date range if provided
                ...(parsedStartTime || parsedEndTime
                  ? {
                      createdAt: {
                        ...(parsedStartTime ? { gte: parsedStartTime } : {}),
                        ...(parsedEndTime ? { lte: parsedEndTime } : {}),
                      },
                    }
                  : {}),
              },
              include: {
                allocations: true,
              },
            },
          },
          // Filter orders by date if date range is provided
          where:
            parsedStartTime || parsedEndTime
              ? {
                  createdAt: {
                    ...(parsedStartTime ? { gte: parsedStartTime } : {}),
                    ...(parsedEndTime ? { lte: parsedEndTime } : {}),
                  },
                }
              : undefined,
        },
        payments: {
          where: {
            ...(staffId ? { processedById: staffId } : {}),
            // Filter payments by date range if provided
            ...(parsedStartTime || parsedEndTime
              ? {
                  createdAt: {
                    ...(parsedStartTime ? { gte: parsedStartTime } : {}),
                    ...(parsedEndTime ? { lte: parsedEndTime } : {}),
                  },
                }
              : {}),
          },
        },
        staff: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: pageSize,
    }),
    prisma.shift.count({
      where: whereClause,
    }),
  ])

  // Calculate the sum of tips and payments for each shift
  const shiftsWithCalculations = shifts.map(shift => {
    // Calculate payment totals from orders
    const orderPayments = shift.orders.flatMap(order => order.payments)
    const allPayments = [...orderPayments, ...shift.payments]

    // Calculate tip sum from payment allocations and tipAmount
    const tipSum = allPayments.reduce((sum, payment) => {
      const tipAmount = Number(payment.tipAmount || 0)
      return sum + tipAmount
    }, 0)

    // Calculate payment sum
    const paymentSum = allPayments.reduce((sum, payment) => {
      const paymentAmount = Number(payment.amount || 0)
      return sum + paymentAmount
    }, 0)

    // Calculate average tip percentage
    const avgTipPercentage = paymentSum > 0 ? (tipSum / paymentSum) * 100 : 0

    return {
      ...shift,
      // Remove the detailed data to make response cleaner
      orders: undefined,
      payments: undefined,
      // Add calculated values
      tipsSum: tipSum,
      tipsCount: allPayments.filter(p => Number(p.tipAmount || 0) > 0).length,
      paymentSum: paymentSum,
      avgTipPercentage: Number(avgTipPercentage.toFixed(2)),
      // Include staff information if filtered by staffId
      staffInfo: staffId
        ? {
            staffId: staffId,
            tipsCount: allPayments.filter(p => Number(p.tipAmount || 0) > 0).length,
            tipsSum: tipSum,
            avgTipPercentage: Number(avgTipPercentage.toFixed(2)),
          }
        : undefined,
    }
  })

  // Calculate pagination metadata
  const totalPages = Math.ceil(totalCount / pageSize)

  const response: PaginationResponse<any> = {
    data: shiftsWithCalculations,
    meta: {
      totalCount,
      pageSize,
      currentPage: pageNumber,
      totalPages,
      hasNextPage: pageNumber < totalPages,
      hasPrevPage: pageNumber > 1,
    },
  }

  // Add diagnostic information if no results
  if (totalCount === 0) {
    const totalVenueShifts = await prisma.shift.count({
      where: { venueId },
    })

    const diagnosticInfo: any = {
      venueExists: (await prisma.venue.findUnique({ where: { id: venueId } })) !== null,
      totalVenueShifts,
      filters: {
        dateRange: startTime || endTime ? true : false,
        staffId: staffId ? true : false,
      },
    }

    // Try to get the most recent shift for this venue
    const latestShift = await prisma.shift.findFirst({
      where: { venueId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    })

    if (latestShift) {
      diagnosticInfo.latestShiftDate = latestShift.createdAt
    }

    // If staffId was provided, check if staff member exists
    if (staffId) {
      const staffMember = await prisma.staff.findFirst({
        where: {
          id: staffId,
          venues: {
            some: {
              venueId: venueId,
            },
          },
        },
      })

      diagnosticInfo.staffExists = !!staffMember
      if (staffMember) {
        diagnosticInfo.staffInfo = {
          id: staffMember.id,
          firstName: staffMember.firstName,
          lastName: staffMember.lastName,
        }
      }
    }

    response.meta.diagnostics = diagnosticInfo
  }

  return response
}

/**
 * Get shift summary with totals and waiter breakdown
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @param filters Filter options
 * @returns Shift summary data
 */
export async function getShiftsSummary(venueId: string, filters: ShiftFilters = {}, _orgId?: string): Promise<ShiftSummaryResponse> {
  const { staffId, startTime, endTime } = filters

  // Parse date filters once for reuse
  let parsedStartTime: Date | undefined
  let parsedEndTime: Date | undefined

  if (startTime) {
    parsedStartTime = new Date(startTime)
    if (isNaN(parsedStartTime.getTime())) {
      throw new BadRequestError(`Invalid startTime: ${startTime}`)
    }
  }

  if (endTime) {
    parsedEndTime = new Date(endTime)
    if (isNaN(parsedEndTime.getTime())) {
      throw new BadRequestError(`Invalid endTime: ${endTime}`)
    }
  }

  // Build payment filter for date range
  const paymentDateFilter: any = {}
  if (parsedStartTime || parsedEndTime) {
    paymentDateFilter.createdAt = {}
    if (parsedStartTime) {
      paymentDateFilter.createdAt.gte = parsedStartTime
    }
    if (parsedEndTime) {
      paymentDateFilter.createdAt.lte = parsedEndTime
    }
  }

  // Build the base query filters for shifts
  const whereClause: any = {
    venueId: venueId,
    // Include all shifts that are open OR have payments in the date range
    OR: [
      // Include open shifts (they might have today's payments)
      { endTime: null },
      // Include closed shifts that overlap with the date range
      ...(parsedStartTime || parsedEndTime
        ? [
            {
              // Shift was active during this period
              AND: [
                parsedStartTime ? { startTime: { lte: parsedEndTime || parsedStartTime } } : {},
                parsedEndTime
                  ? {
                      OR: [{ endTime: null }, { endTime: { gte: parsedStartTime || parsedEndTime } }],
                    }
                  : {},
              ].filter(obj => Object.keys(obj).length > 0),
            },
            // Or shift has payments in this period
            {
              payments: {
                some: paymentDateFilter,
              },
            },
          ]
        : []),
    ],
  }

  // Get shifts with related data
  const shifts = await prisma.shift.findMany({
    where: whereClause,
    include: {
      orders: {
        select: {
          id: true,
          total: true,
        },
        // Filter orders by date if date range is provided
        where:
          parsedStartTime || parsedEndTime
            ? {
                createdAt: {
                  ...(parsedStartTime ? { gte: parsedStartTime } : {}),
                  ...(parsedEndTime ? { lte: parsedEndTime } : {}),
                },
              }
            : undefined,
      },
      payments: {
        select: {
          id: true,
          amount: true,
          tipAmount: true,
          processedById: true,
          createdAt: true,
          processedBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        where: {
          ...(staffId ? { processedById: staffId } : {}),
          // Filter payments by date range if provided
          ...(parsedStartTime || parsedEndTime
            ? {
                createdAt: {
                  ...(parsedStartTime ? { gte: parsedStartTime } : {}),
                  ...(parsedEndTime ? { lte: parsedEndTime } : {}),
                },
              }
            : {}),
        },
      },
    },
  })

  // Calculate summary data
  let totalTips = 0
  let totalSales = 0
  let totalOrders = 0
  let totalRatings = 0

  // Create a map to track tips per staff member
  const staffTipsMap: Map<string, { name: string; amount: number; count: number }> = new Map()

  // Process all shifts
  for (const shift of shifts) {
    // Count orders
    totalOrders += shift.orders.length

    // Process payments
    for (const payment of shift.payments) {
      // Add to total sales
      const paymentAmount = Number(payment.amount || 0)
      const tipAmount = Number(payment.tipAmount || 0)

      if (!isNaN(paymentAmount)) {
        totalSales += paymentAmount
      }

      if (!isNaN(tipAmount)) {
        totalTips += tipAmount

        // Track tips per staff member
        const staffId = payment.processedById
        const staffName = payment.processedBy ? `${payment.processedBy.firstName} ${payment.processedBy.lastName}` : 'Unknown'

        if (staffId) {
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
    }
  }

  // Get review count for these shifts
  try {
    const reviewWhereClause: any = {
      venueId,
    }

    if (startTime) {
      reviewWhereClause.createdAt = { gte: new Date(startTime) }
    }
    if (endTime) {
      reviewWhereClause.createdAt = {
        ...reviewWhereClause.createdAt,
        lte: new Date(endTime),
      }
    }

    totalRatings = await prisma.review.count({
      where: reviewWhereClause,
    })
  } catch (error) {
    logger.warn('Error counting reviews:', error)
    // Continue without review count
  }

  // Calculate average tip percentage
  const averageTipPercentage = totalSales > 0 ? (totalTips / totalSales) * 100 : 0

  // Convert staff tips map to sorted array
  const waiterTips = Array.from(staffTipsMap.entries())
    .map(([id, data]) => ({
      staffId: id,
      name: data.name,
      amount: data.amount,
      count: data.count,
    }))
    .sort((a, b) => b.amount - a.amount) // Sort by highest amount first

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
