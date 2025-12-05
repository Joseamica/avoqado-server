// src/services/dashboard/review.dashboard.service.ts
import prisma from '../../utils/prismaClient'
import { DateFilter } from '../../schemas/dashboard/home.schema'
import { NotFoundError } from '../../errors/AppError'
import { Review } from '@prisma/client'

export async function getReviewsData(venueId: string, dateFilter: DateFilter): Promise<{ reviews: Review[] }> {
  // Verificar que el venue existe
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  const dateCondition = {
    createdAt: {
      gte: dateFilter.from,
      lte: dateFilter.to,
    },
  }

  const reviews = await prisma.review.findMany({
    where: { venueId, ...dateCondition },
    orderBy: { createdAt: 'desc' },
  })

  return { reviews }
}

/**
 * Delete a review (SUPERADMIN only)
 * This is a hard delete - use with caution
 */
export async function deleteReview(reviewId: string): Promise<void> {
  // First verify the review exists
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
  })

  if (!review) {
    throw new NotFoundError(`Review con ID ${reviewId} no encontrado`)
  }

  // Delete the review
  await prisma.review.delete({
    where: { id: reviewId },
  })
}
