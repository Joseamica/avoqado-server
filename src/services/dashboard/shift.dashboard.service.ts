import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from './activity-log.service'

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
          timezone: true,
        },
      },
      // Include payments with processor data for card brand breakdown
      payments: {
        where: {
          status: 'COMPLETED',
        },
        select: {
          id: true,
          amount: true,
          tipAmount: true,
          method: true,
          cardBrand: true,
          maskedPan: true,
          processorData: true,
          processedById: true,
          processedBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
          orderId: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      },
      // Include orders with items for product breakdown
      orders: {
        where: {
          status: {
            in: ['COMPLETED', 'CONFIRMED'],
          },
        },
        select: {
          id: true,
          orderNumber: true,
          total: true,
          subtotal: true,
          status: true,
          table: {
            select: {
              id: true,
              number: true,
            },
          },
          createdAt: true,
          servedById: true,
          servedBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
          items: {
            select: {
              id: true,
              quantity: true,
              unitPrice: true,
              product: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
          payments: {
            where: {
              status: 'COMPLETED',
            },
            select: {
              id: true,
              method: true,
              cardBrand: true,
              maskedPan: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
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

  // ============================================================
  // Calculate Payment Method Breakdown
  // ============================================================
  const paymentMethodMap = new Map<string, { total: number; tips: number; count: number }>()
  const cardBrandMap = new Map<string, { total: number; count: number }>()

  let calculatedTotalSales = 0
  let calculatedTotalTips = 0

  for (const payment of shift.payments) {
    const amount = Number(payment.amount || 0)
    const tipAmount = Number(payment.tipAmount || 0)

    calculatedTotalSales += amount
    calculatedTotalTips += tipAmount

    // Group by payment method (CASH vs CARD)
    const methodKey = payment.method === 'CASH' ? 'CASH' : 'CARD'
    if (paymentMethodMap.has(methodKey)) {
      const existing = paymentMethodMap.get(methodKey)!
      existing.total += amount
      existing.tips += tipAmount
      existing.count += 1
    } else {
      paymentMethodMap.set(methodKey, { total: amount, tips: tipAmount, count: 1 })
    }

    // Group by card brand (only for card payments)
    if (payment.method !== 'CASH') {
      // Get card brand from cardBrand field or processorData
      const cardBrand =
        payment.cardBrand || (payment.processorData as any)?.cardBrand || (payment.processorData as any)?.card_brand || 'OTHER'

      const normalizedBrand = cardBrand.toUpperCase()

      if (cardBrandMap.has(normalizedBrand)) {
        const existing = cardBrandMap.get(normalizedBrand)!
        existing.total += amount
        existing.count += 1
      } else {
        cardBrandMap.set(normalizedBrand, { total: amount, count: 1 })
      }
    }
  }

  // Convert payment method map to array with percentages
  const totalPayments = calculatedTotalSales || 1 // Avoid division by zero
  const paymentMethodBreakdown = Array.from(paymentMethodMap.entries())
    .map(([method, data]) => ({
      method,
      total: Number(data.total.toFixed(2)),
      tips: Number(data.tips.toFixed(2)),
      count: data.count,
      percentage: Number(((data.total / totalPayments) * 100).toFixed(1)),
    }))
    .sort((a, b) => b.total - a.total)

  // Convert card brand map to array with percentages
  const totalCardPayments = paymentMethodMap.get('CARD')?.total || 1
  const cardBrandBreakdown = Array.from(cardBrandMap.entries())
    .map(([brand, data]) => ({
      brand,
      total: Number(data.total.toFixed(2)),
      count: data.count,
      percentage: Number(((data.total / totalCardPayments) * 100).toFixed(1)),
    }))
    .sort((a, b) => b.total - a.total)

  // ============================================================
  // Calculate Staff Breakdown (sales per employee)
  // ============================================================
  const staffMap = new Map<
    string,
    {
      staffId: string
      name: string
      sales: number
      tips: number
      ordersCount: number
      paymentsCount: number
    }
  >()

  // Process payments to get sales and tips per staff
  for (const payment of shift.payments) {
    const staffId = payment.processedById
    if (!staffId) continue

    const staffName = payment.processedBy ? `${payment.processedBy.firstName} ${payment.processedBy.lastName}` : 'Sin asignar'
    const amount = Number(payment.amount || 0)
    const tipAmount = Number(payment.tipAmount || 0)

    if (staffMap.has(staffId)) {
      const existing = staffMap.get(staffId)!
      existing.sales += amount
      existing.tips += tipAmount
      existing.paymentsCount += 1
    } else {
      staffMap.set(staffId, {
        staffId,
        name: staffName,
        sales: amount,
        tips: tipAmount,
        ordersCount: 0,
        paymentsCount: 1,
      })
    }
  }

  // Process orders to get order count per staff
  for (const order of shift.orders) {
    const staffId = order.servedById
    if (!staffId) continue

    const staffName = order.servedBy ? `${order.servedBy.firstName} ${order.servedBy.lastName}` : 'Sin asignar'

    if (staffMap.has(staffId)) {
      const existing = staffMap.get(staffId)!
      existing.ordersCount += 1
    } else {
      staffMap.set(staffId, {
        staffId,
        name: staffName,
        sales: 0,
        tips: 0,
        ordersCount: 1,
        paymentsCount: 0,
      })
    }
  }

  const staffBreakdown = Array.from(staffMap.values())
    .map(staff => ({
      ...staff,
      sales: Number(staff.sales.toFixed(2)),
      tips: Number(staff.tips.toFixed(2)),
      tipPercentage: staff.sales > 0 ? Number(((staff.tips / staff.sales) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.sales - a.sales)

  // ============================================================
  // Calculate Top Products
  // ============================================================
  const productMap = new Map<string, { name: string; quantity: number; revenue: number }>()

  for (const order of shift.orders) {
    for (const item of order.items) {
      const productName = item.product?.name || 'Unknown Product'
      const quantity = item.quantity || 1
      const price = Number(item.unitPrice || 0)

      if (productMap.has(productName)) {
        const existing = productMap.get(productName)!
        existing.quantity += quantity
        existing.revenue += price * quantity
      } else {
        productMap.set(productName, {
          name: productName,
          quantity,
          revenue: price * quantity,
        })
      }
    }
  }

  const topProducts = Array.from(productMap.values())
    .map(product => ({
      ...product,
      revenue: Number(product.revenue.toFixed(2)),
    }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 20) // Top 20 products

  // ============================================================
  // Format orders for response (with payment method info)
  // ============================================================
  const formattedOrders = shift.orders.slice(0, 50).map(order => {
    const orderPayment = order.payments[0] // Get first payment for display
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      total: Number(order.total || 0),
      subtotal: Number(order.subtotal || 0),
      tableName: order.table?.number ? `${order.table.number}` : null,
      staffName: order.servedBy ? `${order.servedBy.firstName} ${order.servedBy.lastName}` : null,
      staffId: order.servedById,
      paymentMethod: orderPayment?.method || null,
      cardBrand: orderPayment?.cardBrand || null,
      cardLast4: orderPayment?.maskedPan ? orderPayment.maskedPan.slice(-4) : null,
      createdAt: order.createdAt,
      itemsCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
      items: order.items.map(item => ({
        name: item.product?.name || 'Unknown Product',
        quantity: item.quantity,
        price: Number(item.unitPrice || 0),
      })),
    }
  })

  // ============================================================
  // Format payments for response
  // ============================================================
  const formattedPayments = shift.payments.map(payment => ({
    id: payment.id,
    amount: Number(payment.amount || 0),
    tipAmount: Number(payment.tipAmount || 0),
    total: Number(payment.amount || 0) + Number(payment.tipAmount || 0),
    method: payment.method,
    cardBrand: payment.cardBrand || (payment.processorData as any)?.cardBrand || null,
    cardLast4: payment.maskedPan ? payment.maskedPan.slice(-4) : null,
    staffName: payment.processedBy ? `${payment.processedBy.firstName} ${payment.processedBy.lastName}` : null,
    staffId: payment.processedById,
    orderId: payment.orderId,
    createdAt: payment.createdAt,
  }))

  // Use calculated totals if they're more accurate than stored values
  const finalTotalSales = calculatedTotalSales > 0 ? calculatedTotalSales : Number(shift.totalSales)
  const finalTotalTips = calculatedTotalTips > 0 ? calculatedTotalTips : Number(shift.totalTips)

  return {
    id: shift.id,
    venueId: shift.venueId,
    staffId: shift.staffId,
    turnId: (shift as any).turnId,
    startTime: shift.startTime,
    endTime: shift.endTime,
    startingCash: Number(shift.startingCash),
    endingCash: shift.endingCash ? Number(shift.endingCash) : null,
    cashDifference: shift.cashDifference ? Number(shift.cashDifference) : null,
    totalSales: finalTotalSales,
    totalTips: finalTotalTips,
    totalOrders: shift.orders.length,
    status: effectiveStatus,
    staff: shift.staff,
    venue: shift.venue,
    createdAt: (shift as any).createdAt,
    updatedAt: (shift as any).updatedAt,
    // NEW: Detailed breakdowns
    payments: formattedPayments,
    orders: formattedOrders,
    paymentMethodBreakdown,
    cardBrandBreakdown,
    staffBreakdown,
    topProducts,
    // Summary stats
    stats: {
      totalPayments: shift.payments.length,
      totalOrders: shift.orders.length,
      totalProducts: topProducts.reduce((sum, p) => sum + p.quantity, 0),
      avgOrderValue: shift.orders.length > 0 ? Number((finalTotalSales / shift.orders.length).toFixed(2)) : 0,
      avgTipPercentage: finalTotalSales > 0 ? Number(((finalTotalTips / finalTotalSales) * 100).toFixed(1)) : 0,
    },
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

    logAction({
      venueId,
      action: 'SHIFT_DELETED',
      entity: 'Shift',
      entityId: shiftId,
    })

    return true
  } catch (error) {
    logger.error('Error deleting shift', { venueId, shiftId, error })
    throw error
  }
}

/**
 * Update shift data interface
 */
export interface UpdateShiftData {
  startTime?: Date
  endTime?: Date | null
  startingCash?: number
  endingCash?: number | null
  totalSales?: number
  totalTips?: number
  totalOrders?: number
  status?: 'OPEN' | 'CLOSED'
  staffId?: string
}

/**
 * Update a shift by ID (SUPERADMIN only)
 * @param venueId Venue ID
 * @param shiftId Shift ID to update
 * @param data Update data
 * @returns Updated shift
 */
export async function updateShift(venueId: string, shiftId: string, data: UpdateShiftData): Promise<any> {
  logger.info('Updating shift', { venueId, shiftId, fields: Object.keys(data) })

  // First check if shift exists and belongs to the venue
  const existingShift = await prisma.shift.findFirst({
    where: {
      id: shiftId,
      venueId: venueId,
    },
  })

  if (!existingShift) {
    logger.warn('Shift not found for update', { venueId, shiftId })
    return null
  }

  // Build update data object, only including provided fields
  const updateData: any = {}

  if (data.startTime !== undefined) {
    updateData.startTime = data.startTime
  }
  if (data.endTime !== undefined) {
    updateData.endTime = data.endTime
  }
  if (data.startingCash !== undefined) {
    updateData.startingCash = data.startingCash
  }
  if (data.endingCash !== undefined) {
    updateData.endingCash = data.endingCash
  }
  if (data.totalSales !== undefined) {
    updateData.totalSales = data.totalSales
  }
  if (data.totalTips !== undefined) {
    updateData.totalTips = data.totalTips
  }
  if (data.totalOrders !== undefined) {
    updateData.totalOrders = data.totalOrders
  }
  if (data.status !== undefined) {
    updateData.status = data.status
  }
  if (data.staffId !== undefined) {
    updateData.staffId = data.staffId
  }

  // Calculate cash difference if both startingCash and endingCash are available
  const effectiveStartingCash = data.startingCash !== undefined ? data.startingCash : Number(existingShift.startingCash)
  const effectiveEndingCash =
    data.endingCash !== undefined ? data.endingCash : existingShift.endingCash ? Number(existingShift.endingCash) : null

  if (effectiveEndingCash !== null) {
    updateData.cashDifference = effectiveEndingCash - effectiveStartingCash
  }

  // Update the shift
  const updatedShift = await prisma.shift.update({
    where: {
      id: shiftId,
    },
    data: updateData,
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

  // Determine effective status based on time logic
  const now = new Date()
  const effectiveStatus = updatedShift.endTime && updatedShift.endTime < now ? 'CLOSED' : updatedShift.status

  logger.info('Shift updated successfully', { venueId, shiftId })

  logAction({
    venueId,
    action: 'SHIFT_UPDATED',
    entity: 'Shift',
    entityId: shiftId,
  })

  return {
    id: updatedShift.id,
    venueId: updatedShift.venueId,
    staffId: updatedShift.staffId,
    startTime: updatedShift.startTime,
    endTime: updatedShift.endTime,
    startingCash: Number(updatedShift.startingCash),
    endingCash: updatedShift.endingCash ? Number(updatedShift.endingCash) : null,
    cashDifference: updatedShift.cashDifference ? Number(updatedShift.cashDifference) : null,
    totalSales: Number(updatedShift.totalSales),
    totalTips: Number(updatedShift.totalTips),
    totalOrders: updatedShift.totalOrders,
    status: effectiveStatus,
    staff: updatedShift.staff,
    venue: updatedShift.venue,
  }
}
