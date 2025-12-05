// src/controllers/dashboard/review.dashboard.controller.ts
import { NextFunction, Request, Response } from 'express'
import * as reviewsDashboardService from '../../services/dashboard/review.dashboard.service'
import * as reviewResponseService from '../../services/reviewResponse.service'
import { DashboardWithDates } from '../../schemas/dashboard/home.schema'
import { parseDateRange } from '@/utils/datetime'
import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import logger from '../../config/logger'

export async function getReviewsData(
  req: Request<DashboardWithDates['params'], any, any, DashboardWithDates['query']>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { fromDate, toDate } = req.query

    // Parse date range using standardized utility (defaults to last 7 days)
    const dateFilter = parseDateRange(fromDate, toDate, 7)

    // Llamada al servicio
    const reviewsData = await reviewsDashboardService.getReviewsData(venueId, dateFilter)

    res.status(200).json(reviewsData)
  } catch (error) {
    next(error)
  }
}

/**
 * Generate AI-powered response draft for a review
 * POST /api/v1/dashboard/reviews/:reviewId/generate-response
 */
export async function generateReviewResponse(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { reviewId } = req.params

    const result = await reviewResponseService.generateAIResponse(reviewId)

    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * Submit approved review response
 * POST /api/v1/dashboard/reviews/:reviewId/submit-response
 */
export async function submitReviewResponse(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { reviewId } = req.params
    const { responseText } = req.body

    const result = await reviewResponseService.submitResponse(reviewId, responseText)

    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * Submit feedback on AI-generated response
 * POST /api/v1/dashboard/reviews/:reviewId/response-feedback
 */
export async function submitResponseFeedback(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { reviewId } = req.params
    const { trainingDataId, feedback, correctionText } = req.body

    const result = await reviewResponseService.submitFeedback(reviewId, trainingDataId, feedback, correctionText)

    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * Delete a review (SUPERADMIN only)
 * DELETE /api/v1/dashboard/venues/:venueId/reviews/:reviewId
 */
export async function deleteReview(req: Request<{ reviewId: string; venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { reviewId, venueId } = req.params

    // Verify review belongs to this venue
    const review = await prisma.review.findFirst({
      where: {
        id: reviewId,
        venueId,
      },
    })

    if (!review) {
      throw new NotFoundError('Review not found in this venue')
    }

    logger.info('Deleting review', {
      reviewId,
      venueId,
      userId: req.authContext?.userId,
    })

    await reviewsDashboardService.deleteReview(reviewId)

    res.status(204).send()
  } catch (error) {
    logger.error('Error deleting review', {
      reviewId: req.params.reviewId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
}
