// src/services/dashboard/feedbacks.dashboard.service.ts
import prisma from '../../utils/prismaClient'
import { DateFilter } from '../../schemas/dashboard/home.schema'
import { NotFoundError } from '../../errors/AppError'
import { Review } from '@prisma/client'

export async function getReviewsData(venueId: string, dateFilter: DateFilter): Promise<{ reviews: Review[] }> {
  // Verificar que el venue existe
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true }
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