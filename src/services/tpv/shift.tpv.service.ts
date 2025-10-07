import { Shift, ShiftStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { publishCommand } from '../../communication/rabbitmq/publisher'

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
  paymentMethods: Array<{
    method: string
    total: number
    percentage: number
  }>
  salesTrend: Array<{
    label: string
    value: number
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
          method: true,
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

  // Create maps for payment methods and time-series data
  const paymentMethodMap: Map<string, number> = new Map()
  const allPayments: Array<{ createdAt: Date; amount: number }> = []

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

        // Track payment method
        const method = payment.method || 'OTHER'
        paymentMethodMap.set(method, (paymentMethodMap.get(method) || 0) + paymentAmount)

        // Store for time-series data
        allPayments.push({
          createdAt: payment.createdAt,
          amount: paymentAmount,
        })
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

  // Convert payment method map to array
  const paymentMethodBreakdown = Array.from(paymentMethodMap.entries()).map(([method, total]) => ({
    method: method,
    total: Number(total.toFixed(2)),
    percentage: totalSales > 0 ? Number(((total / totalSales) * 100).toFixed(2)) : 0,
  }))

  // Generate time-series sales data based on date range
  const salesTrend = generateSalesTrend(allPayments, parsedStartTime, parsedEndTime)

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
    paymentMethods: paymentMethodBreakdown,
    salesTrend: salesTrend,
  }
}

/**
 * Generate time-series sales data based on payment timestamps
 */
function generateSalesTrend(
  payments: Array<{ createdAt: Date; amount: number }>,
  startTime?: Date,
  endTime?: Date,
): Array<{ label: string; value: number }> {
  if (payments.length === 0) {
    return []
  }

  const now = new Date()
  const start = startTime || new Date(Math.min(...payments.map(p => p.createdAt.getTime())))
  const end = endTime || now

  const diffMs = end.getTime() - start.getTime()
  const diffDays = diffMs / (1000 * 60 * 60 * 24)

  // Determine granularity based on date range
  if (diffDays <= 1) {
    // Hourly for single day
    return generateHourlySalesTrend(payments)
  } else if (diffDays <= 7) {
    // Daily for week
    return generateDailySalesTrend(payments)
  } else if (diffDays <= 31) {
    // Weekly for month
    return generateWeeklySalesTrend(payments)
  } else {
    // Monthly for longer periods
    return generateMonthlySalesTrend(payments)
  }
}

function generateHourlySalesTrend(payments: Array<{ createdAt: Date; amount: number }>): Array<{ label: string; value: number }> {
  const hourlyMap: Map<string, number> = new Map()

  payments.forEach(payment => {
    const hour = payment.createdAt.getHours()
    const label = `${hour.toString().padStart(2, '0')}:00`
    hourlyMap.set(label, (hourlyMap.get(label) || 0) + payment.amount)
  })

  return Array.from(hourlyMap.entries())
    .map(([label, value]) => ({ label, value: Number(value.toFixed(2)) }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

function generateDailySalesTrend(payments: Array<{ createdAt: Date; amount: number }>): Array<{ label: string; value: number }> {
  const dailyMap: Map<string, number> = new Map()
  const days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']

  payments.forEach(payment => {
    const dayOfWeek = payment.createdAt.getDay()
    const label = days[dayOfWeek]
    dailyMap.set(label, (dailyMap.get(label) || 0) + payment.amount)
  })

  return Array.from(dailyMap.entries()).map(([label, value]) => ({ label, value: Number(value.toFixed(2)) }))
}

function generateWeeklySalesTrend(payments: Array<{ createdAt: Date; amount: number }>): Array<{ label: string; value: number }> {
  const weeklyMap: Map<string, number> = new Map()

  payments.forEach(payment => {
    const weekNumber = Math.floor((payment.createdAt.getDate() - 1) / 7) + 1
    const label = `Sem ${weekNumber}`
    weeklyMap.set(label, (weeklyMap.get(label) || 0) + payment.amount)
  })

  return Array.from(weeklyMap.entries())
    .map(([label, value]) => ({ label, value: Number(value.toFixed(2)) }))
    .sort((a, b) => {
      const weekA = parseInt(a.label.split(' ')[1])
      const weekB = parseInt(b.label.split(' ')[1])
      return weekA - weekB
    })
}

function generateMonthlySalesTrend(payments: Array<{ createdAt: Date; amount: number }>): Array<{ label: string; value: number }> {
  const monthlyMap: Map<string, number> = new Map()
  const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

  payments.forEach(payment => {
    const monthIndex = payment.createdAt.getMonth()
    const label = months[monthIndex]
    monthlyMap.set(label, (monthlyMap.get(label) || 0) + payment.amount)
  })

  return Array.from(monthlyMap.entries()).map(([label, value]) => ({ label, value: Number(value.toFixed(2)) }))
}

/**
 * Interface for shift closing data
 */
interface ShiftCloseData {
  cashDeclared: number
  cardDeclared: number
  vouchersDeclared: number
  otherDeclared: number
  notes?: string
}

/**
 * Open a new shift for a venue
 * Works with both integrated POS (SOFTRESTAURANT) and standalone (NONE) mode
 * @param venueId Venue ID
 * @param staffId Staff ID who is opening the shift
 * @param startingCash Starting cash amount
 * @param stationId POS station ID (optional)
 * @param orgId Organization ID for authorization
 * @returns Created shift object
 */
export async function openShiftForVenue(
  venueId: string,
  staffId: string,
  startingCash: number,
  stationId?: string,
  _orgId?: string,
): Promise<Shift> {
  logger.info('Opening new shift for venue', {
    venueId,
    staffId,
    startingCash,
    stationId,
  })

  // Verify venue exists and get its POS configuration
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: {
      id: true,
      name: true,
      posType: true,
      posStatus: true,
    },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found')
  }

  // Check if there's already an open shift for this venue
  const existingOpenShift = await prisma.shift.findFirst({
    where: {
      venueId: venueId,
      endTime: null, // Open shift
    },
  })

  if (existingOpenShift) {
    throw new BadRequestError('There is already an open shift for this venue. Please close it before opening a new one.')
  }

  // Verify staff member exists and belongs to venue
  // Find staff and their venue association
  const staffWithVenue = await prisma.staffVenue.findFirst({
    where: {
      staffId: staffId,
      venueId: venueId,
    },
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

  if (!staffWithVenue) {
    throw new NotFoundError('Staff member not found or not associated with this venue')
  }

  const posStaffId = staffWithVenue.posStaffId || staffId

  // Determine if we should send command to POS
  const isIntegratedPOS = venue.posType === 'SOFTRESTAURANT' && venue.posStatus === 'CONNECTED'

  let shiftExternalId: string | null = null

  if (isIntegratedPOS) {
    // INTEGRATED MODE: Send command to Windows service to open shift in POS
    try {
      // Generate a temporary shift ID for tracking
      const tempShiftId = `SHIFT_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`

      logger.info('Sending shift open command to POS', {
        venueId,
        tempShiftId,
        staffPosId: posStaffId,
      })

      await publishCommand(`command.softrestaurant.${venueId}`, {
        entity: 'Shift',
        action: 'OPEN',
        payload: {
          tempShiftId,
          posStaffId: posStaffId,
          startingCash: startingCash || 0,
          stationId: stationId || 'AVOQADO',
        },
      })

      // The Windows service will process this command and create the shift in POS
      // The shift will be synced back via the posSyncShift service
      // For now, we'll create the shift record with a marker that it's pending POS confirmation
      shiftExternalId = tempShiftId
    } catch (error) {
      logger.error('Failed to send shift open command to POS', error)
      throw new BadRequestError('Failed to open shift in POS system. Please try again.')
    }
  }

  // Create shift record in database
  const shift = await prisma.shift.create({
    data: {
      venueId: venueId,
      staffId: staffId,
      startTime: new Date(),
      endTime: null,
      status: 'OPEN' as ShiftStatus,
      startingCash: startingCash || 0,
      endingCash: null,
      cashDeclared: null,
      cardDeclared: null,
      vouchersDeclared: null,
      otherDeclared: null,
      totalSales: 0,
      totalTips: 0,
      notes: null,
      externalId: shiftExternalId,
      posRawData: stationId ? { stationId } : undefined,
    },
  })

  logger.info('Shift opened successfully', {
    shiftId: shift.id,
    venueId,
    staffId,
    isIntegratedPOS,
  })

  return shift
}

/**
 * Close an existing shift for a venue
 * Works with both integrated POS (SOFTRESTAURANT) and standalone (NONE) mode
 * @param venueId Venue ID
 * @param shiftId Shift ID to close
 * @param closeData Cash reconciliation and closing data
 * @param orgId Organization ID for authorization
 * @returns Updated shift object
 */
export async function closeShiftForVenue(venueId: string, shiftId: string, closeData: ShiftCloseData, _orgId?: string): Promise<Shift> {
  logger.info('Closing shift for venue', {
    venueId,
    shiftId,
    closeData,
  })

  // Verify shift exists and belongs to the venue
  const shift = await prisma.shift.findFirst({
    where: {
      id: shiftId,
      venueId: venueId,
    },
    include: {
      venue: {
        select: {
          posType: true,
          posStatus: true,
        },
      },
    },
  })

  if (!shift) {
    throw new NotFoundError('Shift not found or does not belong to this venue')
  }

  if (shift.endTime !== null) {
    throw new BadRequestError('Shift is already closed')
  }

  // Calculate shift totals from orders
  const shiftOrders = await prisma.order.findMany({
    where: {
      shiftId: shiftId,
      status: {
        in: ['COMPLETED'],
      },
    },
  })

  // Also get payments for shift totals
  const shiftPayments = await prisma.payment.findMany({
    where: {
      shiftId: shiftId,
      status: 'COMPLETED',
    },
  })

  let totalSales = new Decimal(0)
  let totalTips = new Decimal(0)

  shiftOrders.forEach(order => {
    totalSales = totalSales.add(order.total)
  })

  shiftPayments.forEach(payment => {
    if (payment.tipAmount) {
      totalTips = totalTips.add(payment.tipAmount)
    }
  })

  // Determine if we should send command to POS
  const isIntegratedPOS = shift.venue.posType === 'SOFTRESTAURANT' && shift.venue.posStatus === 'CONNECTED'

  if (isIntegratedPOS && shift.externalId) {
    // INTEGRATED MODE: Send command to Windows service to close shift in POS
    try {
      logger.info('Sending shift close command to POS', {
        venueId,
        shiftId,
        externalShiftId: shift.externalId,
      })

      await publishCommand(`command.softrestaurant.${venueId}`, {
        entity: 'Shift',
        action: 'CLOSE',
        payload: {
          shiftId: shift.externalId,
          cashDeclared: closeData.cashDeclared,
          cardDeclared: closeData.cardDeclared,
          vouchersDeclared: closeData.vouchersDeclared,
          otherDeclared: closeData.otherDeclared,
        },
      })

      // The Windows service will process this command and close the shift in POS
      // Archival operations will happen in the POS database
    } catch (error) {
      logger.error('Failed to send shift close command to POS', error)
      // Continue with local shift close even if POS command fails
      // The shift can be manually closed in POS if needed
    }
  }

  // Update shift record in database
  const updatedShift = await prisma.shift.update({
    where: { id: shiftId },
    data: {
      endTime: new Date(),
      status: 'CLOSED' as ShiftStatus,
      endingCash: new Decimal(shift.startingCash || 0).add(new Decimal(closeData.cashDeclared || 0)),
      cashDeclared: closeData.cashDeclared,
      cardDeclared: closeData.cardDeclared,
      vouchersDeclared: closeData.vouchersDeclared,
      otherDeclared: closeData.otherDeclared,
      totalSales: totalSales,
      totalTips: totalTips,
      notes: closeData.notes,
    },
  })

  logger.info('Shift closed successfully', {
    shiftId,
    venueId,
    totalSales,
    totalTips,
    isIntegratedPOS,
  })

  return updatedShift
}
