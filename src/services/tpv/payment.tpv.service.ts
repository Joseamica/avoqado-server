import { Payment, PaymentMethod, SplitType, OrderSource, PaymentSource } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { generateDigitalReceipt } from './digitalReceipt.tpv.service'
import { publishCommand } from '../../communication/rabbitmq/publisher'
import { trackRecentPaymentCommand } from '../pos-sync/posSyncOrder.service'
import { socketManager } from '../../communication/sockets/managers/socketManager'
import { SocketEventType } from '../../communication/sockets/types'
import { createTransactionCost } from '../payments/transactionCost.service'
import { deductInventoryForProduct } from '../dashboard/productInventoryIntegration.service'

/**
 * Convert TPV rating strings to numeric values for database storage
 * @param tpvRating The rating string from TPV ("EXCELLENT", "GOOD", "POOR")
 * @returns Numeric rating (1-5) or null if invalid
 */
function mapTpvRatingToNumeric(tpvRating: string): number | null {
  const ratingMap: Record<string, number> = {
    EXCELLENT: 5,
    GOOD: 3,
    POOR: 1,
  }

  return ratingMap[tpvRating.toUpperCase()] || null
}

/**
 * Map payment source from Android app format to PaymentSource enum
 * @param source The source string from the app (e.g., "AVOQADO_TPV")
 * @returns Valid PaymentSource enum value
 */
function mapPaymentSource(source?: string): PaymentSource {
  if (!source) return 'OTHER'

  // Map "AVOQADO_TPV" from Android app to "TPV" enum value
  if (source === 'AVOQADO_TPV') return 'TPV'

  // Check if it's a valid PaymentSource enum value
  const validSources: PaymentSource[] = ['TPV', 'DASHBOARD_TEST', 'QR', 'WEB', 'APP', 'PHONE', 'POS', 'OTHER']
  return validSources.includes(source as PaymentSource) ? (source as PaymentSource) : 'OTHER'
}

/**
 * Update order totals directly in backend for standalone mode
 * @param orderId Order ID to update
 * @param paymentAmount Total payment amount (including tip)
 */
async function updateOrderTotalsForStandalonePayment(orderId: string, paymentAmount: number): Promise<void> {
  // Get current order with payment information
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      payments: {
        where: { status: 'COMPLETED' },
        select: { amount: true, tipAmount: true },
      },
    },
  })

  if (!order) {
    throw new Error(`Order ${orderId} not found for total update`)
  }

  // Calculate total payments made (including this new one)
  const previousPayments = order.payments.reduce(
    (sum, payment) => sum + parseFloat(payment.amount.toString()) + parseFloat(payment.tipAmount.toString()),
    0,
  )
  const totalPaid = previousPayments + paymentAmount
  const originalTotal = parseFloat(order.total.toString())

  // Calculate remaining amount
  const remainingAmount = Math.max(0, originalTotal - totalPaid)
  const isFullyPaid = remainingAmount <= 0.01 // Account for floating point precision

  // Determine new payment status
  let newPaymentStatus = order.paymentStatus
  if (isFullyPaid) {
    newPaymentStatus = 'PAID'
  } else if (totalPaid > 0) {
    newPaymentStatus = 'PARTIAL'
  }

  // Update order totals and status
  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      paymentStatus: newPaymentStatus,
      ...(isFullyPaid && {
        status: 'COMPLETED',
        completedAt: new Date(),
      }),
    },
    include: {
      items: {
        include: {
          product: true,
        },
      },
    },
  })

  logger.info('Order totals updated for standalone payment', {
    orderId,
    originalTotal,
    paymentAmount,
    totalPaid,
    remainingAmount,
    isFullyPaid,
    newPaymentStatus,
  })

  // 🔥 INVENTORY DEDUCTION: Automatically deduct stock when order is completed
  if (isFullyPaid) {
    try {
      logger.info('🎯 Starting inventory deduction for completed order', {
        orderId,
        venueId: updatedOrder.venueId,
        itemCount: updatedOrder.items.length,
      })

      // Deduct stock for each product in the order
      for (const item of updatedOrder.items) {
        try {
          await deductInventoryForProduct(updatedOrder.venueId, item.productId, item.quantity, orderId)

          logger.info('✅ Stock deducted successfully for product', {
            orderId,
            productId: item.productId,
            productName: item.product.name,
            quantity: item.quantity,
          })
        } catch (deductionError: any) {
          // Log individual product deduction errors but continue with other products
          logger.warn('⚠️ Failed to deduct stock for product - continuing with order', {
            orderId,
            productId: item.productId,
            productName: item.product.name,
            quantity: item.quantity,
            error: deductionError.message,
            reason: deductionError.message.includes('does not have a recipe')
              ? 'NO_RECIPE'
              : deductionError.message.includes('Insufficient stock')
                ? 'INSUFFICIENT_STOCK'
                : 'UNKNOWN',
          })
        }
      }

      logger.info('🎯 Inventory deduction completed for order', {
        orderId,
        totalItems: updatedOrder.items.length,
      })
    } catch (inventoryError) {
      // Log overall inventory deduction errors but don't fail the payment
      logger.error('❌ Failed to complete inventory deduction for order', {
        orderId,
        error: inventoryError,
      })
      // Payment is still successful - inventory deduction failure is logged but not critical
    }
  }
}

interface PaymentFilters {
  fromDate?: string
  toDate?: string
  staffId?: string
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

/**
 * Validate staff and venue relationship using staffId
 * @param staffId Staff ID to validate
 * @param venueId Venue ID to validate against
 * @param userId Fallback user ID if staffId is not provided
 * @returns Validated staff ID
 */
export async function validateStaffVenue(staffId: string | undefined, venueId: string, userId?: string): Promise<string | undefined> {
  // Use userId as fallback if no staffId provided
  if (!staffId) {
    return userId
  }

  let actualStaffId = staffId

  // 🔧 [TEMP FIX] Handle numeric staffId from Android app (e.g., "1", "2", "3")
  // Android app sends numeric indices instead of proper CUIDs - map to actual staffIds
  if (/^\d+$/.test(staffId)) {
    logger.warn('🔧 [TEMP FIX] Received numeric staffId from Android app', { staffId, venueId })

    try {
      // Get all staff assigned to this venue, ordered by creation date
      const staffVenues = await prisma.staffVenue.findMany({
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

      // Map numeric index to actual staffId (1-based index from Android)
      const staffIndex = parseInt(staffId) - 1
      if (staffIndex < 0 || staffIndex >= staffVenues.length) {
        logger.error('🔧 [TEMP FIX] Invalid staff index', { staffId, staffIndex, availableStaff: staffVenues.length })
        throw new BadRequestError(`Invalid staff index ${staffId}. Available staff: 1-${staffVenues.length}`)
      }

      actualStaffId = staffVenues[staffIndex].staffId
      logger.info('🔧 [TEMP FIX] Mapped numeric staffId to actual CUID', {
        originalStaffId: staffId,
        mappedStaffId: actualStaffId,
        staffName: `${staffVenues[staffIndex].staff?.firstName || 'Unknown'} ${staffVenues[staffIndex].staff?.lastName || 'Staff'}`,
      })
    } catch (error) {
      logger.error('🔧 [TEMP FIX] Failed to map numeric staffId', { staffId, venueId, error })
      throw new BadRequestError(`Failed to resolve staff ID ${staffId} for venue ${venueId}`)
    }
  }

  // Validate that staff exists and is assigned to this venue
  const staffVenue = await prisma.staffVenue.findFirst({
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

/**
 * Get payments for a venue with pagination and filtering
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @param pageSize Number of items per page
 * @param pageNumber Page number
 * @param filters Filter options
 * @returns Paginated payment results
 */
export async function getPayments(
  venueId: string,
  pageSize: number,
  pageNumber: number,
  filters: PaymentFilters = {},
  _orgId?: string,
): Promise<PaginationResponse<Payment>> {
  const { fromDate, toDate, staffId } = filters

  // Build the query filters
  const whereClause: any = {
    venueId: venueId,
  }

  // Add date range filters if provided
  if (fromDate || toDate) {
    whereClause.createdAt = {}

    if (fromDate) {
      const parsedFromDate = new Date(fromDate)
      if (!isNaN(parsedFromDate.getTime())) {
        whereClause.createdAt.gte = parsedFromDate
      } else {
        throw new BadRequestError(`Invalid fromDate: ${fromDate}`)
      }
    }

    if (toDate) {
      const parsedToDate = new Date(toDate)
      if (!isNaN(parsedToDate.getTime())) {
        whereClause.createdAt.lte = parsedToDate
      } else {
        throw new BadRequestError(`Invalid toDate: ${toDate}`)
      }
    }

    // If there are no valid date conditions, remove the empty createdAt object
    if (Object.keys(whereClause.createdAt).length === 0) {
      delete whereClause.createdAt
    }
  }

  // Handle staff filter (staffId maps to processedById in new schema)
  if (staffId) {
    // Check if the staff member exists in the venue
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

    if (!staffMember) {
      logger.warn(`Staff member with ID ${staffId} not found for venue ${venueId}`)
      throw new NotFoundError(`Staff member with ID ${staffId} not found for this venue`)
    }

    whereClause.processedById = staffId
  }

  // Calculate pagination values
  const skip = (pageNumber - 1) * pageSize

  // Check total payments for venue for diagnostics
  const totalVenuePayments = await prisma.payment.count({
    where: { venueId },
  })

  // Execute the query with pagination
  const [payments, totalCount] = await prisma.$transaction([
    prisma.payment.findMany({
      where: whereClause,
      include: {
        processedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            total: true,
            table: true,
          },
        },
        // Include allocations for tip information
        allocations: {
          select: {
            id: true,
            amount: true,
            orderItem: {
              select: {
                id: true,
                product: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: pageSize,
    }),
    prisma.payment.count({
      where: whereClause,
    }),
  ])

  // Calculate pagination metadata
  const totalPages = Math.ceil(totalCount / pageSize)

  const response: PaginationResponse<Payment> = {
    data: payments,
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
    const diagnosticInfo: any = {
      venueExists: (await prisma.venue.findUnique({ where: { id: venueId } })) !== null,
      totalVenuePayments,
      filters: {
        dateRange: fromDate || toDate ? true : false,
        staffId: staffId ? true : false,
      },
    }

    // Try to get the most recent payment for this venue
    const latestPayment = await prisma.payment.findFirst({
      where: { venueId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, processedById: true },
    })

    if (latestPayment) {
      diagnosticInfo.latestPaymentDate = latestPayment.createdAt
    }

    response.meta.diagnostics = diagnosticInfo
  }

  return response
}

/**
 * Interface for payment creation data
 */
interface PaymentCreationData {
  venueId: string
  amount: number // Amount in cents
  tip: number // Tip in cents
  status: 'COMPLETED' | 'PENDING' | 'FAILED' | 'PROCESSING' | 'REFUNDED'
  method: 'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'DIGITAL_WALLET'
  source: string
  splitType: 'PERPRODUCT' | 'EQUALPARTS' | 'CUSTOMAMOUNT' | 'FULLPAYMENT'
  tpvId: string
  staffId: string
  paidProductsId: string[]

  // Card payment fields
  cardBrand?: string
  last4?: string
  typeOfCard?: 'CREDIT' | 'DEBIT'
  currency: string
  bank?: string

  // Menta integration fields
  mentaAuthorizationReference?: string
  mentaOperationId?: string
  mentaTicketId?: string
  token?: string
  isInternational: boolean

  // Additional fields
  reviewRating?: string

  // Enhanced payment tracking fields (from new database migration)
  authorizationNumber?: string
  referenceNumber?: string
  maskedPan?: string
  entryMode?: string

  // Split payment specific fields
  equalPartsPartySize?: number
  equalPartsPayedFor?: number
}

/**
 * Record a payment for a specific order
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param paymentData Payment creation data
 * @param userId User ID who processed the payment
 * @param orgId Organization ID
 * @returns Created payment with order information
 */
export async function recordOrderPayment(
  venueId: string,
  orderId: string,
  paymentData: PaymentCreationData,
  userId?: string,
  _orgId?: string,
) {
  logger.info('Recording order payment', { venueId, orderId, splitType: paymentData.splitType })

  // Find the order directly by ID
  const activeOrder = await prisma.order.findUnique({
    where: {
      id: orderId,
      venueId,
    },
    include: {
      items: true,
      venue: true,
    },
  })

  if (!activeOrder) {
    throw new NotFoundError(`Order ${orderId} not found in venue ${venueId}`)
  }

  // Validate splitType business logic
  if (activeOrder.splitType && activeOrder.splitType !== paymentData.splitType) {
    // Define allowed transitions based on business rules
    const allowedTransitions = {
      PERPRODUCT: ['PERPRODUCT', 'FULLPAYMENT'], // Can only continue with same method or pay full
      EQUALPARTS: ['EQUALPARTS', 'FULLPAYMENT'], // Can only continue with same method or pay full
      CUSTOMAMOUNT: ['PERPRODUCT', 'EQUALPARTS', 'CUSTOMAMOUNT', 'FULLPAYMENT'], // Can use any method
      FULLPAYMENT: ['FULLPAYMENT'], // Only full payment allowed (order should be completed)
    }

    const allowedMethods = allowedTransitions[activeOrder.splitType] || []

    if (!allowedMethods.includes(paymentData.splitType)) {
      throw new BadRequestError(
        `Order has splitType ${activeOrder.splitType}. Cannot use ${paymentData.splitType}. Allowed methods: ${allowedMethods.join(', ')}`,
      )
    }
  }

  // Convert amounts from cents to decimal (Prisma expects Decimal)
  const totalAmount = paymentData.amount / 100
  const tipAmount = paymentData.tip / 100

  // Find current open shift for this venue
  const currentShift = await prisma.shift.findFirst({
    where: {
      venueId,
      status: 'OPEN',
      endTime: null,
    },
    orderBy: {
      startTime: 'desc',
    },
  })

  // ✅ CORRECTED: Use validateStaffVenue helper for proper staffId validation
  const validatedStaffId = await validateStaffVenue(paymentData.staffId, venueId, userId)

  // Create the payment record
  const payment = await prisma.payment.create({
    data: {
      venueId,
      orderId: activeOrder.id,
      amount: totalAmount,
      tipAmount,
      method: paymentData.method as PaymentMethod, // Cast to PaymentMethod enum
      status: paymentData.status as any, // Direct enum mapping since frontend sends correct values
      splitType: paymentData.splitType as SplitType, // Cast to SplitType enum
      source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
      processor: 'TBD',
      processorId: paymentData.mentaOperationId,
      processorData: {
        cardBrand: paymentData.cardBrand,
        last4: paymentData.last4,
        typeOfCard: paymentData.typeOfCard,
        bank: paymentData.bank,
        currency: paymentData.currency,
        mentaAuthorizationReference: paymentData.mentaAuthorizationReference,
        mentaTicketId: paymentData.mentaTicketId,
        isInternational: paymentData.isInternational,
      },
      // New enhanced fields in the Payment table
      authorizationNumber: paymentData.authorizationNumber,
      referenceNumber: paymentData.referenceNumber,
      maskedPan: paymentData.maskedPan,
      cardBrand: paymentData.cardBrand ? (paymentData.cardBrand.toUpperCase().replace(' ', '_') as any) : null,
      entryMode: paymentData.entryMode ? (paymentData.entryMode.toUpperCase() as any) : null,
      processedById: validatedStaffId, // ✅ CORRECTED: Use validated staff ID
      shiftId: currentShift?.id,
      feePercentage: 0, // TODO: Calculate based on payment processor
      feeAmount: 0, // TODO: Calculate based on amount and percentage
      netAmount: totalAmount + tipAmount, // For now, net amount = total
      posRawData: {
        splitType: paymentData.splitType,
        staffId: paymentData.staffId, // ✅ CORRECTED: Use staffId field name consistently
        source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
        paidProductsId: paymentData.paidProductsId || [],
        ...(paymentData.equalPartsPartySize && { equalPartsPartySize: paymentData.equalPartsPartySize }),
        ...(paymentData.equalPartsPayedFor && { equalPartsPayedFor: paymentData.equalPartsPayedFor }),
        ...(paymentData.reviewRating && { reviewRating: paymentData.reviewRating }),
      },
    },
    include: {
      order: {
        include: {
          items: true,
          venue: true,
        },
      },
      processedBy: true,
    },
  })

  // Create VenueTransaction for financial tracking and settlement
  await prisma.venueTransaction.create({
    data: {
      venueId,
      paymentId: payment.id,
      type: 'PAYMENT',
      grossAmount: totalAmount + tipAmount,
      feeAmount: payment.feeAmount,
      netAmount: payment.netAmount,
      status: 'PENDING', // Will be updated to SETTLED by settlement process
    },
  })

  logger.info('VenueTransaction created for payment', {
    paymentId: payment.id,
    grossAmount: totalAmount + tipAmount,
    feeAmount: payment.feeAmount,
    netAmount: payment.netAmount,
  })

  // Create TransactionCost for financial tracking (only for Avoqado-processed non-cash payments)
  try {
    await createTransactionCost(payment.id)
  } catch (transactionCostError) {
    logger.error('Failed to create TransactionCost', {
      paymentId: payment.id,
      error: transactionCostError,
    })
    // Don't fail the payment if TransactionCost creation fails
  }

  // Update Order.splitType if this is the first payment
  if (!activeOrder.splitType) {
    await prisma.order.update({
      where: { id: activeOrder.id },
      data: { splitType: paymentData.splitType as any },
    })
  }

  // Handle split payment allocations based on splitType
  if (paymentData.splitType === 'PERPRODUCT' && paymentData.paidProductsId.length > 0) {
    // Create allocations for specific products
    const orderItems = activeOrder.items.filter((item: any) => paymentData.paidProductsId.includes(item.id))

    for (const item of orderItems) {
      await prisma.paymentAllocation.create({
        data: {
          paymentId: payment.id,
          orderItemId: item.id,
          orderId: activeOrder.id,
          amount: item.total, // Allocate the full item amount
        },
      })
    }
  } else {
    // For other split types, create a general allocation to the order
    await prisma.paymentAllocation.create({
      data: {
        paymentId: payment.id,
        orderId: activeOrder.id,
        amount: totalAmount,
      },
    })
  }

  // Create Review record if reviewRating is provided
  if (paymentData.reviewRating) {
    try {
      const rating = mapTpvRatingToNumeric(paymentData.reviewRating)
      if (rating !== null) {
        await prisma.review.create({
          data: {
            venueId: activeOrder.venueId,
            paymentId: payment.id,
            overallRating: rating,
            source: 'TPV',
            servedById: paymentData.staffId, // Link to the staff who served
          },
        })
        logger.info('Review created successfully', { paymentId: payment.id, rating, originalRating: paymentData.reviewRating })
      } else {
        logger.warn('Invalid review rating provided', { paymentId: payment.id, rating: paymentData.reviewRating })
      }
    } catch (error) {
      logger.error('Failed to create review', { paymentId: payment.id, error })
      // Don't fail the payment if review creation fails
    }
  }

  // Generate digital receipt for TPV payments (AVOQADO origin)
  let digitalReceipt = null
  try {
    digitalReceipt = await generateDigitalReceipt(payment.id)
    logger.info('Digital receipt generated for payment', {
      paymentId: payment.id,
      receiptId: digitalReceipt.id,
      accessKey: digitalReceipt.accessKey,
    })
  } catch (error) {
    logger.error('Failed to generate digital receipt', { paymentId: payment.id, error })
    // Don't fail the payment if receipt generation fails
  }

  // Emit socket events for real-time updates
  try {
    // Emit payment completed event to venue room
    socketManager.broadcastToVenue(activeOrder.venueId, SocketEventType.PAYMENT_COMPLETED, {
      paymentId: payment.id,
      orderId: activeOrder.id,
      orderNumber: activeOrder.orderNumber,
      venueId: activeOrder.venueId,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      method: payment.method,
      status: payment.status.toLowerCase(), // Convert to lowercase for Android compatibility
      timestamp: new Date().toISOString(),
    })

    // Emit order updated event to venue room
    socketManager.broadcastToVenue(activeOrder.venueId, SocketEventType.ORDER_UPDATED, {
      orderId: activeOrder.id,
      orderNumber: activeOrder.orderNumber,
      venueId: activeOrder.venueId,
      status: activeOrder.status,
      paymentStatus: activeOrder.paymentStatus,
      timestamp: new Date().toISOString(),
    })

    logger.info('Socket events emitted successfully', {
      paymentId: payment.id,
      orderId: activeOrder.id,
      orderNumber: activeOrder.orderNumber,
      venueId: activeOrder.venueId,
      events: ['PAYMENT_COMPLETED', 'ORDER_UPDATED'],
    })
  } catch (error) {
    logger.error('Failed to emit socket events', {
      paymentId: payment.id,
      orderId: activeOrder.id,
      error,
    })
    // Don't fail the payment if socket emission fails
  }

  // ✅ NUEVO: Detectar modo de operación y manejar pago según el contexto
  const isIntegratedMode = activeOrder.source === OrderSource.POS && activeOrder.externalId && activeOrder.externalId.trim() !== ''

  logger.info('Payment processing mode detected', {
    paymentId: payment.id,
    orderId: activeOrder.id,
    isIntegratedMode,
    orderSource: activeOrder.source,
    hasExternalId: !!activeOrder.externalId,
  })

  if (isIntegratedMode) {
    // MODO INTEGRADO: Enviar comando a POS, POS maneja los totales
    try {
      const isPartialPayment = totalAmount + tipAmount < parseFloat(activeOrder.total.toString())

      await publishCommand(`command.softrestaurant.${venueId}`, {
        entity: 'Payment',
        action: 'APPLY',
        payload: {
          orderExternalId: activeOrder.externalId,
          paymentData: {
            amount: totalAmount,
            tip: tipAmount,
            posPaymentMethodId: mapPaymentMethodToPOS(paymentData.method),
            reference: paymentData.mentaOperationId || paymentData.authorizationNumber || '',
            isPartial: isPartialPayment,
          },
        },
      })

      // Track this payment command to prevent double deduction when POS sends back order.updated
      if (activeOrder.externalId) {
        trackRecentPaymentCommand(activeOrder.externalId, totalAmount + tipAmount)
      }

      logger.info('Payment command sent to POS (Integrated Mode)', {
        paymentId: payment.id,
        orderExternalId: activeOrder.externalId,
        isPartial: isPartialPayment,
      })
    } catch (rabbitMQError) {
      logger.error('Failed to send payment command to POS', {
        paymentId: payment.id,
        error: rabbitMQError,
      })
      // No fallar el pago si RabbitMQ falla
    }
  } else {
    // MODO AUTÓNOMO: Backend maneja los totales directamente
    try {
      await updateOrderTotalsForStandalonePayment(activeOrder.id, totalAmount + tipAmount)

      logger.info('Order totals updated directly in backend (Standalone Mode)', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        paymentAmount: totalAmount + tipAmount,
      })
    } catch (updateError) {
      logger.error('Failed to update order totals in standalone mode', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        error: updateError,
      })
      // Continue execution - payment is still recorded even if total update fails
    }
  }

  logger.info('Payment recorded successfully', { paymentId: payment.id, amount: totalAmount })

  // Add digital receipt info to payment response
  return {
    ...payment,
    digitalReceipt: digitalReceipt
      ? {
          id: digitalReceipt.id,
          accessKey: digitalReceipt.accessKey,
          receiptUrl: `${process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`}${process.env.API_PREFIX || '/api/v1'}/public/receipt/${digitalReceipt.accessKey}`,
        }
      : null,
  }
}

/**
 * Record a fast payment (without specific table association)
 * @param venueId Venue ID
 * @param paymentData Payment creation data
 * @param userId User ID who processed the payment
 * @param orgId Organization ID
 * @returns Created payment
 */
export async function recordFastPayment(venueId: string, paymentData: PaymentCreationData, userId?: string, _orgId?: string) {
  logger.info('Recording fast payment', { venueId, amount: paymentData.amount, paymentData })
  const fastOrder = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `FAST-${Date.now()}`,
      type: 'DINE_IN',
      source: 'TPV',
      status: 'CONFIRMED',
      subtotal: paymentData.amount / 100, // Convert to decimal
      taxAmount: 0, // No tax for fast payments
      total: paymentData.amount / 100, // Convert to decimal
      paymentStatus: 'PAID',
      splitType: paymentData.splitType as any, // Set splitType for fast orders
    },
  })

  // Convert amounts from cents to decimal (Prisma expects Decimal)
  const totalAmount = paymentData.amount / 100
  const tipAmount = paymentData.tip / 100

  // Find current open shift for this venue
  const currentShift = await prisma.shift.findFirst({
    where: {
      venueId,
      status: 'OPEN',
      endTime: null,
    },
    orderBy: {
      startTime: 'desc',
    },
  })

  // ✅ CORRECTED: Use validateStaffVenue helper for proper staffId validation
  const validatedStaffId = await validateStaffVenue(paymentData.staffId, venueId, userId)

  // Map source from Android app format to PaymentSource enum
  const mapPaymentSource = (source?: string): PaymentSource => {
    if (!source) return 'OTHER'
    // Map "AVOQADO_TPV" from Android app to "TPV" enum value
    if (source === 'AVOQADO_TPV') return 'TPV'
    // Check if it's a valid PaymentSource enum value
    const validSources = ['TPV', 'DASHBOARD_TEST', 'QR', 'WEB', 'APP', 'PHONE', 'POS', 'OTHER']
    return validSources.includes(source) ? (source as PaymentSource) : 'OTHER'
  }

  // Create the fast payment record (no order association)
  const payment = await prisma.payment.create({
    data: {
      venueId,
      orderId: fastOrder.id, // Fast payment - no order association
      amount: totalAmount,
      tipAmount,
      method: paymentData.method as PaymentMethod, // Cast to PaymentMethod enum
      status: paymentData.status as any, // Direct enum mapping since frontend sends correct values
      splitType: 'FULLPAYMENT' as SplitType, // Fast payments are always full payments
      source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
      processor: 'TBD',
      type: 'FAST',
      processorId: paymentData.mentaOperationId,
      processorData: {
        cardBrand: paymentData.cardBrand,
        last4: paymentData.last4,
        typeOfCard: paymentData.typeOfCard,
        bank: paymentData.bank,
        currency: paymentData.currency,
        authorizationNumber: paymentData.authorizationNumber,
        referenceNumber: paymentData.referenceNumber,
        isInternational: paymentData.isInternational,
      },
      // New enhanced fields in the Payment table
      authorizationNumber: paymentData.authorizationNumber,
      referenceNumber: paymentData.referenceNumber,
      maskedPan: paymentData.maskedPan,
      cardBrand: paymentData.cardBrand ? (paymentData.cardBrand.toUpperCase().replace(' ', '_') as any) : null,
      entryMode: paymentData.entryMode ? (paymentData.entryMode.toUpperCase() as any) : null,
      processedById: validatedStaffId, // ✅ CORRECTED: Use validated staff ID
      shiftId: currentShift?.id,
      feePercentage: 0, // TODO: Calculate based on payment processor
      feeAmount: 0, // TODO: Calculate based on amount and percentage
      netAmount: totalAmount + tipAmount, // For now, net amount = total
      posRawData: {
        splitType: 'FULLPAYMENT',
        staffId: paymentData.staffId, // ✅ CORRECTED: Use staffId field name consistently
        source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
        paymentType: 'FAST',
        ...(paymentData.reviewRating && { reviewRating: paymentData.reviewRating }),
      },
    },
    include: {
      processedBy: true,
    },
  })

  // Create VenueTransaction for financial tracking and settlement
  await prisma.venueTransaction.create({
    data: {
      venueId,
      paymentId: payment.id,
      type: 'PAYMENT',
      grossAmount: totalAmount + tipAmount,
      feeAmount: payment.feeAmount,
      netAmount: payment.netAmount,
      status: 'PENDING', // Will be updated to SETTLED by settlement process
    },
  })

  logger.info('VenueTransaction created for fast payment', {
    paymentId: payment.id,
    grossAmount: totalAmount + tipAmount,
    feeAmount: payment.feeAmount,
    netAmount: payment.netAmount,
  })

  // Create TransactionCost for financial tracking (only for Avoqado-processed non-cash payments)
  try {
    await createTransactionCost(payment.id)
  } catch (transactionCostError) {
    logger.error('Failed to create TransactionCost for fast payment', {
      paymentId: payment.id,
      error: transactionCostError,
    })
    // Don't fail the payment if TransactionCost creation fails
  }

  // Create a general allocation for the fast payment (no specific order)
  await prisma.paymentAllocation.create({
    data: {
      paymentId: payment.id,
      orderId: fastOrder.id, // No order for fast payments
      amount: totalAmount,
    },
  })

  // Create Review record if reviewRating is provided
  if (paymentData.reviewRating) {
    try {
      const rating = mapTpvRatingToNumeric(paymentData.reviewRating)
      if (rating !== null) {
        await prisma.review.create({
          data: {
            venueId: venueId,
            paymentId: payment.id,
            overallRating: rating,
            source: 'TPV',
            servedById: paymentData.staffId, // Link to the staff who served
          },
        })
        logger.info('Review created successfully for fast payment', {
          paymentId: payment.id,
          rating,
          originalRating: paymentData.reviewRating,
        })
      } else {
        logger.warn('Invalid review rating provided for fast payment', { paymentId: payment.id, rating: paymentData.reviewRating })
      }
    } catch (error) {
      logger.error('Failed to create review for fast payment', { paymentId: payment.id, error })
      // Don't fail the payment if review creation fails
    }
  }

  // Generate digital receipt for fast TPV payments (AVOQADO origin)
  let digitalReceipt = null
  try {
    digitalReceipt = await generateDigitalReceipt(payment.id)
    logger.info('Digital receipt generated for fast payment', {
      paymentId: payment.id,
      receiptId: digitalReceipt.id,
      accessKey: digitalReceipt.accessKey,
    })
  } catch (error) {
    logger.error('Failed to generate digital receipt for fast payment', { paymentId: payment.id, error })
    // Don't fail the payment if receipt generation fails
  }

  // Emit socket events for real-time updates
  try {
    // Emit payment completed event to venue room
    socketManager.broadcastToVenue(venueId, SocketEventType.PAYMENT_COMPLETED, {
      paymentId: payment.id,
      orderId: fastOrder.id,
      orderNumber: fastOrder.orderNumber,
      venueId: venueId,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      method: payment.method,
      status: payment.status.toLowerCase(), // Convert to lowercase for Android compatibility
      type: 'FAST',
      timestamp: new Date().toISOString(),
    })

    // Emit order updated event to venue room for the fast order
    socketManager.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: fastOrder.id,
      orderNumber: fastOrder.orderNumber,
      venueId: venueId,
      status: fastOrder.status,
      paymentStatus: fastOrder.paymentStatus,
      type: 'FAST',
      timestamp: new Date().toISOString(),
    })

    logger.info('Socket events emitted successfully for fast payment', {
      paymentId: payment.id,
      orderId: fastOrder.id,
      orderNumber: fastOrder.orderNumber,
      venueId: venueId,
      events: ['PAYMENT_COMPLETED', 'ORDER_UPDATED'],
    })
  } catch (error) {
    logger.error('Failed to emit socket events for fast payment', {
      paymentId: payment.id,
      orderId: fastOrder.id,
      error,
    })
    // Don't fail the payment if socket emission fails
  }

  logger.info('Fast payment recorded successfully', { paymentId: payment.id, amount: totalAmount })

  // Add digital receipt info to payment response
  return {
    ...payment,
    digitalReceipt: digitalReceipt
      ? {
          id: digitalReceipt.id,
          accessKey: digitalReceipt.accessKey,
          receiptUrl: `${process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`}${process.env.API_PREFIX || '/api/v1'}/public/receipt/${digitalReceipt.accessKey}`,
        }
      : null,
  }
}

/**
 * Get available merchant accounts for a venue
 * Returns active merchant accounts configured for the venue with display information
 * @param venueId Venue ID to get merchant accounts for
 * @param orgId Organization ID for authorization
 * @returns Array of available merchant accounts with display info
 */
export async function getVenueMerchantAccounts(venueId: string, _orgId?: string): Promise<any[]> {
  // First validate that the venue exists and belongs to the organization
  const venue = await prisma.venue.findFirst({
    where: {
      id: venueId,
    },
    include: {
      paymentConfig: {
        include: {
          primaryAccount: {
            include: {
              provider: true,
            },
          },
          secondaryAccount: {
            include: {
              provider: true,
            },
          },
          tertiaryAccount: {
            include: {
              provider: true,
            },
          },
        },
      },
    },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found or not accessible')
  }

  if (!venue.paymentConfig) {
    logger.warn('No payment configuration found for venue', { venueId })
    return []
  }

  const accounts = []
  const { paymentConfig } = venue

  // Helper function to create account response object
  const createAccountResponse = (account: any, accountType: string) => {
    if (!account || !account.active) return null

    // Check if account has required credentials
    const credentials = account.credentialsEncrypted
    const hasValidCredentials = !!(credentials && credentials.merchantId && credentials.apiKey)

    return {
      id: account.id,
      accountType,
      displayName: account.displayName || `${account.provider.name} ${accountType}`,
      providerName: account.provider.name,
      providerCode: account.provider.code,
      active: account.active,
      hasValidCredentials,
      displayOrder: account.displayOrder,
      externalMerchantId: account.externalMerchantId,
      // 🚀 OPTIMIZATION: Include decrypted credentials for POS terminals
      // This eliminates the need for getMentaRoute API calls during payment
      credentials: hasValidCredentials
        ? {
            apiKey: credentials.apiKey,
            merchantId: credentials.merchantId,
            customerId: credentials.customerId || null,
          }
        : null,
    }
  }

  // Add primary account if exists and active
  if (paymentConfig.primaryAccount) {
    const primaryAccount = createAccountResponse(paymentConfig.primaryAccount, 'PRIMARY')
    if (primaryAccount) accounts.push(primaryAccount)
  }

  // Add secondary account if exists and active
  if (paymentConfig.secondaryAccount) {
    const secondaryAccount = createAccountResponse(paymentConfig.secondaryAccount, 'SECONDARY')
    if (secondaryAccount) accounts.push(secondaryAccount)
  }

  // Add tertiary account if exists and active
  if (paymentConfig.tertiaryAccount) {
    const tertiaryAccount = createAccountResponse(paymentConfig.tertiaryAccount, 'TERTIARY')
    if (tertiaryAccount) accounts.push(tertiaryAccount)
  }

  // Filter only accounts with valid credentials and sort by display order
  const validAccounts = accounts.filter(account => account.hasValidCredentials).sort((a, b) => a.displayOrder - b.displayOrder)

  logger.info('Retrieved merchant accounts for venue', {
    venueId,
    totalAccounts: accounts.length,
    validAccounts: validAccounts.length,
  })

  return validAccounts
}

/**
 * Interface for payment routing request data
 */
interface PaymentRoutingData {
  amount: number // Amount in cents
  merchantAccountId: string // Selected merchant account ID (user has already chosen primary/secondary/tertiary)
  terminalSerial: string // Terminal identifier
  bin?: string // Optional BIN for card routing
}

/**
 * Get payment routing configuration for the selected merchant account
 * This method retrieves the credentials and routing info for the merchant account selected by the user in TPV
 * @param venueId Venue ID
 * @param routingData Routing parameters from the request (includes user-selected merchant account)
 * @param orgId Organization ID for authorization
 * @returns Payment routing configuration with credentials and routing info for the selected account
 */
export async function getPaymentRouting(venueId: string, routingData: PaymentRoutingData, _orgId?: string): Promise<any> {
  logger.info('Getting payment routing configuration for user-selected merchant account', {
    venueId,
    merchantAccountId: routingData.merchantAccountId,
    amount: routingData.amount,
  })

  // First validate that the venue exists and get its payment configuration
  const venue = await prisma.venue.findFirst({
    where: {
      id: venueId,
    },
    include: {
      paymentConfig: {
        include: {
          primaryAccount: {
            include: {
              provider: true,
            },
          },
          secondaryAccount: {
            include: {
              provider: true,
            },
          },
          tertiaryAccount: {
            include: {
              provider: true,
            },
          },
        },
      },
    },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found or not accessible')
  }

  if (!venue.paymentConfig) {
    throw new BadRequestError('Venue payment configuration not found')
  }

  // Find the specific merchant account by ID from the venue's configured accounts
  // The user has already selected which account they want to use (primary/secondary/tertiary)
  let selectedAccount: any = null
  let accountType: string = 'UNKNOWN'

  const { paymentConfig } = venue

  if (paymentConfig.primaryAccount?.id === routingData.merchantAccountId) {
    selectedAccount = paymentConfig.primaryAccount
    accountType = 'PRIMARY'
  } else if (paymentConfig.secondaryAccount?.id === routingData.merchantAccountId) {
    selectedAccount = paymentConfig.secondaryAccount
    accountType = 'SECONDARY'
  } else if (paymentConfig.tertiaryAccount?.id === routingData.merchantAccountId) {
    selectedAccount = paymentConfig.tertiaryAccount
    accountType = 'TERTIARY'
  }

  if (!selectedAccount || !selectedAccount.active) {
    throw new NotFoundError('Selected merchant account not found or not active for this venue')
  }

  // Check if account has valid credentials
  const credentials = selectedAccount.credentialsEncrypted as any
  if (!credentials || !credentials.merchantId || !credentials.apiKey || !credentials.customerId) {
    throw new BadRequestError('Selected merchant account does not have valid payment processor credentials')
  }

  // Simple routing based on account type - the user has already made the routing decision by selecting the account
  const route = accountType.toLowerCase() // 'primary', 'secondary', or 'tertiary'
  const acquirer = selectedAccount.provider.code.toUpperCase() // 'MENTA', etc.

  // 🚨 CRITICAL FIX: Get proper terminal UUID instead of hardware serial
  // Fetch terminal record by serial number to get the proper UUID
  const terminal = await prisma.terminal.findFirst({
    where: {
      serialNumber: routingData.terminalSerial,
      venueId: venueId,
    },
  })

  if (!terminal) {
    throw new NotFoundError(`Terminal with serial ${routingData.terminalSerial} not found for venue ${venueId}`)
  }

  // Use Menta terminal UUID if available, otherwise use terminal's own UUID
  const terminalUuid = terminal.mentaTerminalId
  logger.info(`🎯 Using terminal UUID for payments: ${terminalUuid} (serial: ${routingData.terminalSerial})`)

  // The routing response contains the credentials for the user-selected merchant account
  const routingResponse = {
    route,
    acquirer,
    merchantId: credentials.merchantId,
    apiKeyMerchant: credentials.apiKey,
    customerId: credentials.customerId,
    terminalSerial: terminalUuid, // 🎯 CRITICAL: Return UUID instead of serial number
    amount: routingData.amount,
    // Additional routing metadata
    routingMetadata: {
      accountType,
      providerCode: selectedAccount.provider.code,
      externalMerchantId: selectedAccount.externalMerchantId,
      userSelected: true, // This routing was based on user selection, not automatic rules
      timestamp: new Date().toISOString(),
    },
  }

  logger.info('Payment routing configuration generated for user-selected account', {
    venueId,
    merchantAccountId: routingData.merchantAccountId,
    accountType,
    route,
    acquirer,
    userSelected: true,
    merchantId: credentials.merchantId.substring(0, 8) + '...',
  })

  return routingResponse
}

/**
 * ✅ NUEVO: Mapea métodos de pago del backend a códigos de POS
 * Convierte los métodos de pago de Avoqado a los códigos que entiende SoftRestaurant
 */
function mapPaymentMethodToPOS(method: PaymentMethod): string {
  logger.info('Mapping payment method to POS', { method })
  logger.info('Pene')
  const paymentMethodMap: Record<PaymentMethod, string> = {
    CASH: 'ACARD', // ✅ CHANGED: Use DEB instead of AEF (tipo=2 CARD) to prevent $0.00 archiving issue
    CREDIT_CARD: 'CRE', // TAR. CREDITO
    DEBIT_CARD: 'DEB', // TAR. DEBITO
    DIGITAL_WALLET: 'MPY', // MARC PAYMENTS (como genérico para wallets)
    BANK_TRANSFER: 'DEB', // ✅ CHANGED: Use DEB instead of AEF to prevent $0.00 archiving
    OTHER: 'ACARD', // ✅ CHANGED: Default to DEB instead of AEF
  }

  return paymentMethodMap[method] || 'ACARD' // ✅ CHANGED: Default fallback to DEB
}
