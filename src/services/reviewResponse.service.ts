// src/services/reviewResponse.service.ts
import prisma from '@/utils/prismaClient'
import AppError from '@/errors/AppError'
import * as googleBusinessProfileService from './googleBusinessProfile.service'
import { ReviewSource } from '@prisma/client'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * Generate AI-powered response draft for a review
 */
export async function generateAIResponse(reviewId: string) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    include: {
      venue: {
        select: {
          name: true,
          type: true,
        },
      },
    },
  })

  if (!review) {
    throw new AppError('Review not found', 404)
  }

  // Determine sentiment from rating
  const sentiment = review.overallRating >= 4 ? 'positive' : review.overallRating >= 3 ? 'neutral' : 'negative'

  // TODO: Integrate with OpenAI API to generate response
  // For now, return a placeholder response
  const responseText = `Thank you for your ${sentiment} review! We appreciate your feedback and look forward to serving you again.`

  // TODO: Store training data for feedback loop
  // const trainingData = await prisma.reviewResponseTrainingData.create({
  //   data: {
  //     reviewId,
  //     generatedResponse: responseText,
  //     sentiment,
  //   },
  // })

  return {
    response: responseText,
    sentiment,
    // trainingDataId: trainingData.id,
  }
}

/**
 * Submit approved review response
 * This will save to database and post to Google if applicable
 */
export async function submitResponse(reviewId: string, responseText: string) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      source: true,
      externalId: true,
      venueId: true,
      venue: {
        select: {
          googleBusinessProfileConnected: true,
        },
      },
    },
  })

  if (!review) {
    throw new AppError('Review not found', 404)
  }

  // Update review with response
  const updatedReview = await prisma.review.update({
    where: { id: reviewId },
    data: {
      responseText,
      respondedAt: new Date(),
      responseAutomated: true,
    },
  })

  // If this is a Google review and venue has Google connected, post to Google
  if (review.source === ReviewSource.GOOGLE && review.externalId && review.venue.googleBusinessProfileConnected) {
    try {
      await googleBusinessProfileService.postReviewResponse(review.venueId, review.externalId, responseText)
    } catch (error) {
      logger.warn('Error posting response to Google:', error)
      // Don't fail the entire operation if Google posting fails
      // The response is still saved in our database
    }
  }

  logAction({
    venueId: review.venueId,
    action: 'REVIEW_RESPONSE_SUBMITTED',
    entity: 'Review',
    entityId: reviewId,
    data: { source: review.source },
  })

  return {
    success: true,
    reviewId: updatedReview.id,
    responseText: updatedReview.responseText!,
    respondedAt: updatedReview.respondedAt!.toISOString(),
    responseAutomated: updatedReview.responseAutomated,
  }
}

/**
 * Submit feedback on AI-generated response
 * Used for continuous improvement of AI model
 */
export async function submitFeedback(
  _reviewId: string,
  _trainingDataId: string,
  _feedback: 'positive' | 'negative',
  _correctionText?: string,
) {
  // TODO: Update training data with feedback
  // await prisma.reviewResponseTrainingData.update({
  //   where: { id: _trainingDataId },
  //   data: {
  //     feedback: _feedback,
  //     correctionText: _correctionText,
  //     feedbackAt: new Date(),
  //   },
  // })

  return {
    success: true,
  }
}
