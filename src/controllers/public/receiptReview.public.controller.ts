import { NextFunction, Request, Response } from 'express'
import { submitReceiptReview, canSubmitReview, getReceiptReview } from '../../services/tpv/receiptReview.tpv.service'
import { BadRequestError } from '../../errors/AppError'
import logger from '../../config/logger'

/**
 * Submit a review from digital receipt
 * POST /api/public/receipt/:accessKey/review
 */
export async function submitReviewFromReceipt(
  req: Request<{ accessKey: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { accessKey } = req.params
    const {
      overallRating,
      foodRating,
      serviceRating,
      ambienceRating,
      comment,
      customerName,
      customerEmail,
      customerPhone,
    } = req.body

    // Validate required fields
    if (!overallRating) {
      throw new BadRequestError('Overall rating is required')
    }

    if (typeof overallRating !== 'number' || overallRating < 1 || overallRating > 5) {
      throw new BadRequestError('Overall rating must be a number between 1 and 5')
    }

    // Submit the review
    const result = await submitReceiptReview({
      accessKey,
      overallRating,
      foodRating,
      serviceRating,
      ambienceRating,
      comment,
      customerName,
      customerEmail,
      customerPhone,
    })

    logger.info('Review submitted from receipt successfully', {
      accessKey,
      reviewId: result.review.id,
    })

    res.status(201).json({
      success: true,
      message: 'Review submitted successfully',
      data: {
        reviewId: result.review.id,
        venue: result.venue.name,
        rating: overallRating,
      },
    })
  } catch (error) {
    logger.error('Error submitting review from receipt', {
      accessKey: req.params.accessKey,
      error,
    })
    next(error)
  }
}

/**
 * Check if review can be submitted for receipt
 * GET /api/public/receipt/:accessKey/review/status
 */
export async function checkReviewStatus(
  req: Request<{ accessKey: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { accessKey } = req.params

    const result = await canSubmitReview(accessKey)

    res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    logger.error('Error checking review status', {
      accessKey: req.params.accessKey,
      error,
    })
    next(error)
  }
}

/**
 * Get existing review for receipt
 * GET /api/public/receipt/:accessKey/review
 */
export async function getReviewForReceipt(
  req: Request<{ accessKey: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { accessKey } = req.params

    const result = await getReceiptReview(accessKey)

    res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    logger.error('Error getting review for receipt', {
      accessKey: req.params.accessKey,
      error,
    })
    next(error)
  }
}