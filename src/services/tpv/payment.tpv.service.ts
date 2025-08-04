import prisma from '../../utils/prismaClient'
import { Payment, PaymentMethod, PaymentStatus, SplitType } from '@prisma/client'
import { NotFoundError, BadRequestError } from '../../errors/AppError'
import logger from '../../config/logger'
import { generateDigitalReceipt } from './digitalReceipt.tpv.service'

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

  // Validate that staff exists and is assigned to this venue
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      staffId,
      venueId,
      active: true,
    },
    include: {
      staff: true,
    },
  })

  if (!staffVenue) {
    throw new BadRequestError(`Staff ${staffId} is not assigned to venue ${venueId} or is inactive`)
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
  orgId?: string,
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
  orgId?: string,
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
      processor: 'BANKAOOL',
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
        source: paymentData.source || 'AVOQADO_TPV',
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
      accessKey: digitalReceipt.accessKey 
    })
  } catch (error) {
    logger.error('Failed to generate digital receipt', { paymentId: payment.id, error })
    // Don't fail the payment if receipt generation fails
  }

  // TODO: Emit socket event for real-time updates
  // SocketManager.emitPaymentUpdate(venueId, tableNumber, payment)

  logger.info('Payment recorded successfully', { paymentId: payment.id, amount: totalAmount })

  // Add digital receipt info to payment response
  return {
    ...payment,
    digitalReceipt: digitalReceipt ? {
      id: digitalReceipt.id,
      accessKey: digitalReceipt.accessKey,
      receiptUrl: `${process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`}${process.env.API_PREFIX || '/api/v1'}/public/receipt/${digitalReceipt.accessKey}`
    } : null
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
export async function recordFastPayment(venueId: string, paymentData: PaymentCreationData, userId?: string, orgId?: string) {
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
      processor: 'BANKAOOL',
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
        source: paymentData.source || 'AVOQADO_TPV',
        paymentType: 'FAST',
        ...(paymentData.reviewRating && { reviewRating: paymentData.reviewRating }),
      },
    },
    include: {
      processedBy: true,
    },
  })

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
      accessKey: digitalReceipt.accessKey 
    })
  } catch (error) {
    logger.error('Failed to generate digital receipt for fast payment', { paymentId: payment.id, error })
    // Don't fail the payment if receipt generation fails
  }

  // TODO: Emit socket event for real-time updates
  // SocketManager.emitPaymentUpdate(venueId, 'FAST_PAYMENT', payment)

  logger.info('Fast payment recorded successfully', { paymentId: payment.id, amount: totalAmount })

  // Add digital receipt info to payment response
  return {
    ...payment,
    digitalReceipt: digitalReceipt ? {
      id: digitalReceipt.id,
      accessKey: digitalReceipt.accessKey,
      receiptUrl: `${process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`}${process.env.API_PREFIX || '/api/v1'}/public/receipt/${digitalReceipt.accessKey}`
    } : null
  }
}
