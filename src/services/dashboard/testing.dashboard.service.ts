// services/dashboard/testing.dashboard.service.ts

import { PaymentMethod, Payment } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { recordFastPayment } from '../tpv/payment.tpv.service'

/**
 * Interface for test payment creation
 */
interface CreateTestPaymentData {
  venueId: string
  amount: number // Amount in cents
  tipAmount: number // Tip in cents
  method: PaymentMethod
  staffId: string // Staff executing the test
}

/**
 * Interface for payment with receipt information
 */
interface PaymentWithReceipt extends Payment {
  digitalReceipt?: {
    id: string
    accessKey: string
    receiptUrl: string
  } | null
}

/**
 * Create a test payment for SUPERADMIN testing purposes
 *
 * This function creates a fast payment (without specific order association)
 * and marks it as a test payment in the metadata for easy identification
 *
 * @param data Test payment creation data
 * @returns Created payment with receipt information
 */
export async function createTestPayment(data: CreateTestPaymentData): Promise<PaymentWithReceipt> {
  logger.info('Creating test payment', {
    venueId: data.venueId,
    amount: data.amount,
    tipAmount: data.tipAmount,
    method: data.method,
    staffId: data.staffId,
  })

  // Validate that the venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: data.venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue ${data.venueId} not found`)
  }

  // Validate that the staff exists and belongs to the venue
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      staffId: data.staffId,
      venueId: data.venueId,
      active: true,
    },
  })

  if (!staffVenue) {
    throw new NotFoundError(`Staff ${data.staffId} is not assigned to venue ${data.venueId}`)
  }

  // Use the existing recordFastPayment function but with test metadata
  const payment = await recordFastPayment(
    data.venueId,
    {
      venueId: data.venueId,
      amount: data.amount,
      tip: data.tipAmount,
      method: data.method as any, // Cast to match PaymentCreationData type expectations
      status: 'COMPLETED',
      source: 'DASHBOARD_TEST',
      splitType: 'FULLPAYMENT',
      tpvId: 'TEST_TPV',
      staffId: data.staffId,
      paidProductsId: [],
      currency: venue.currency,
      isInternational: false,
      // Mark this as a test payment in the metadata
      reviewRating: undefined, // No review for test payments
    },
    data.staffId,
  )

  // Update the payment's type and posRawData to mark it as a test payment
  const updatedPayment = await prisma.payment.update({
    where: { id: payment.id },
    data: {
      type: 'TEST', // ✅ NEW: Mark as TEST payment type
      posRawData: {
        ...((payment.posRawData as any) || {}),
        isTestPayment: true,
        testExecutedBy: data.staffId,
        testTimestamp: new Date().toISOString(),
        testSource: 'SUPERADMIN_TESTING_DASHBOARD',
      },
    },
    include: {
      order: {
        include: {
          table: true,
        },
      },
      processedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      receipts: {
        orderBy: {
          createdAt: 'desc',
        },
        take: 1,
      },
    },
  })

  logger.info('Test payment created successfully', {
    paymentId: updatedPayment.id,
    venueId: data.venueId,
    amount: data.amount,
    tipAmount: data.tipAmount,
  })

  // Return payment with receipt information
  return {
    ...updatedPayment,
    digitalReceipt: payment.digitalReceipt || null,
  } as PaymentWithReceipt
}

/**
 * Get recent test payments
 *
 * Retrieves the most recent test payments, optionally filtered by venue
 * Test payments are identified by the isTestPayment flag in posRawData
 *
 * @param venueId Optional venue ID to filter by
 * @param limit Maximum number of payments to return (default 10, max 100)
 * @returns Array of test payments
 */
export async function getTestPayments(venueId?: string, limit: number = 10): Promise<Payment[]> {
  logger.info('Fetching test payments', { venueId, limit })

  // Build the where clause
  const whereClause: any = {
    type: 'TEST', // ✅ UPDATED: Filter by PaymentType.TEST instead of JSON query
  }

  // Add venue filter if provided
  if (venueId) {
    whereClause.venueId = venueId
  }

  const payments = await prisma.payment.findMany({
    where: whereClause,
    include: {
      order: {
        include: {
          table: true,
        },
      },
      processedBy: {
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
          slug: true,
        },
      },
      receipts: {
        orderBy: {
          createdAt: 'desc',
        },
        take: 1,
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: Math.min(limit, 100), // Ensure limit doesn't exceed 100
  })

  logger.info('Test payments fetched successfully', {
    count: payments.length,
    venueId,
  })

  return payments
}

/**
 * Delete a test payment
 *
 * Removes a test payment and its associated order
 * Only allows deletion of payments marked as test payments
 *
 * @param paymentId Payment ID to delete
 * @param staffId Staff requesting the deletion (for authorization)
 */
export async function deleteTestPayment(paymentId: string, staffId: string): Promise<void> {
  logger.info('Deleting test payment', { paymentId, staffId })

  // Verify the payment exists and is a test payment
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      order: true,
    },
  })

  if (!payment) {
    throw new NotFoundError(`Payment ${paymentId} not found`)
  }

  // Verify this is a test payment
  if (payment.type !== 'TEST') {
    throw new Error('Can only delete test payments through this endpoint')
  }

  // Delete the payment (cascade will handle related records)
  await prisma.payment.delete({
    where: { id: paymentId },
  })

  logger.info('Test payment deleted successfully', { paymentId })
}
