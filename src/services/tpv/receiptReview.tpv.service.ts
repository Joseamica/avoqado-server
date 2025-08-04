import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { NotFoundError, BadRequestError } from '../../errors/AppError'

/**
 * Interface for review submission from receipt
 */
interface ReceiptReviewData {
  accessKey: string
  overallRating: number // 1-5
  foodRating?: number // 1-5
  serviceRating?: number // 1-5
  ambienceRating?: number // 1-5
  comment?: string
  customerName?: string
  customerEmail?: string
  customerPhone?: string
}

/**
 * Submit a review from a digital receipt
 * @param reviewData Review data from receipt form
 * @returns Created review
 */
export async function submitReceiptReview(reviewData: ReceiptReviewData) {
  logger.info('Submitting review from receipt', { accessKey: reviewData.accessKey })

  try {
    // Get the digital receipt and verify it exists
    const receipt = await prisma.digitalReceipt.findUnique({
      where: { accessKey: reviewData.accessKey },
      include: {
        payment: {
          include: {
            venue: {
              select: {
                id: true,
                name: true,
              },
            },
            processedBy: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
      },
    })

    if (!receipt) {
      throw new NotFoundError('Receipt not found')
    }

    // Validate rating values (1-5)
    if (reviewData.overallRating < 1 || reviewData.overallRating > 5) {
      throw new BadRequestError('Overall rating must be between 1 and 5')
    }

    if (reviewData.foodRating && (reviewData.foodRating < 1 || reviewData.foodRating > 5)) {
      throw new BadRequestError('Food rating must be between 1 and 5')
    }

    if (reviewData.serviceRating && (reviewData.serviceRating < 1 || reviewData.serviceRating > 5)) {
      throw new BadRequestError('Service rating must be between 1 and 5')
    }

    if (reviewData.ambienceRating && (reviewData.ambienceRating < 1 || reviewData.ambienceRating > 5)) {
      throw new BadRequestError('Ambience rating must be between 1 and 5')
    }

    // Check if a review already exists for this payment
    const existingReview = await prisma.review.findUnique({
      where: { paymentId: receipt.paymentId },
    })

    if (existingReview) {
      throw new BadRequestError('A review has already been submitted for this payment')
    }

    // Create the review
    const review = await prisma.review.create({
      data: {
        venueId: receipt.payment.venue.id,
        paymentId: receipt.paymentId,
        overallRating: reviewData.overallRating,
        foodRating: reviewData.foodRating,
        serviceRating: reviewData.serviceRating,
        ambienceRating: reviewData.ambienceRating,
        comment: reviewData.comment,
        customerName: reviewData.customerName,
        customerEmail: reviewData.customerEmail,
        source: 'AVOQADO', // Review from our digital receipt
        servedById: receipt.payment.processedBy?.id, // Link to staff who processed payment
      },
    })

    logger.info('Review submitted successfully from receipt', {
      reviewId: review.id,
      paymentId: receipt.paymentId,
      venueId: receipt.payment.venue.id,
      rating: reviewData.overallRating,
    })

    return {
      review,
      venue: receipt.payment.venue,
    }
  } catch (error) {
    logger.error('Failed to submit review from receipt', {
      accessKey: reviewData.accessKey,
      error,
    })
    throw error
  }
}

/**
 * Check if a review can be submitted for a receipt
 * @param accessKey Receipt access key
 * @returns Boolean indicating if review can be submitted
 */
export async function canSubmitReview(accessKey: string): Promise<{
  canSubmit: boolean
  reason?: string
  venue?: { id: string; name: string }
}> {
  try {
    const receipt = await prisma.digitalReceipt.findUnique({
      where: { accessKey },
      include: {
        payment: {
          include: {
            venue: {
              select: {
                id: true,
                name: true,
              },
            },
            review: true, // Check if review already exists
          },
        },
      },
    })

    if (!receipt) {
      return {
        canSubmit: false,
        reason: 'Receipt not found',
      }
    }

    if (receipt.payment.review) {
      return {
        canSubmit: false,
        reason: 'Review already submitted',
        venue: receipt.payment.venue,
      }
    }

    return {
      canSubmit: true,
      venue: receipt.payment.venue,
    }
  } catch (error) {
    logger.error('Error checking review eligibility', { accessKey, error })
    return {
      canSubmit: false,
      reason: 'Error checking eligibility',
    }
  }
}

/**
 * Get review status for a receipt
 * @param accessKey Receipt access key
 * @returns Review information if exists
 */
export async function getReceiptReview(accessKey: string) {
  try {
    const receipt = await prisma.digitalReceipt.findUnique({
      where: { accessKey },
      include: {
        payment: {
          include: {
            review: true,
            venue: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    })

    if (!receipt) {
      throw new NotFoundError('Receipt not found')
    }

    return {
      hasReview: !!receipt.payment.review,
      review: receipt.payment.review,
      venue: receipt.payment.venue,
    }
  } catch (error) {
    logger.error('Error getting receipt review', { accessKey, error })
    throw error
  }
}