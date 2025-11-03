// src/services/reviewSync.service.ts
import prisma from '@/utils/prismaClient'
import * as googleBusinessProfileService from './googleBusinessProfile.service'
import type { GoogleReview } from './googleBusinessProfile.service'
import { ReviewSource } from '@prisma/client'
import logger from '@/config/logger'

/**
 * Sync Google reviews for a single venue
 */
export async function syncVenueGoogleReviews(venueId: string): Promise<number> {
  // Get venue with Google integration
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: {
      id: true,
      googleBusinessProfileConnected: true,
      googlePlaceId: true,
    },
  })

  if (!venue?.googleBusinessProfileConnected || !venue.googlePlaceId) {
    throw new Error(`Venue ${venueId} does not have Google Business Profile connected`)
  }

  // Fetch reviews from Google
  try {
    const { reviews: googleReviews } = await googleBusinessProfileService.fetchReviews(venueId)

    // Parse googleReviews and upsert to database
    const syncPromises = googleReviews.map(async (googleReview: GoogleReview) => {
      // Check if review already exists
      const existingReview = await prisma.review.findFirst({
        where: {
          venueId: venue.id,
          externalId: googleReview.reviewId,
        },
      })

      if (existingReview) {
        // Update existing review
        await prisma.review.update({
          where: { id: existingReview.id },
          data: {
            overallRating: googleReview.starRating,
            comment: googleReview.comment || '',
            customerName: googleReview.reviewer.displayName,
            responseText: googleReview.reviewReply?.comment || null,
            respondedAt: googleReview.reviewReply?.updateTime ? new Date(googleReview.reviewReply.updateTime) : null,
          },
        })
      } else {
        // Create new review
        await prisma.review.create({
          data: {
            venueId: venue.id,
            source: ReviewSource.GOOGLE,
            externalId: googleReview.reviewId,
            overallRating: googleReview.starRating,
            comment: googleReview.comment || '',
            customerName: googleReview.reviewer.displayName,
            responseText: googleReview.reviewReply?.comment || null,
            respondedAt: googleReview.reviewReply?.updateTime ? new Date(googleReview.reviewReply.updateTime) : null,
            createdAt: new Date(googleReview.createTime),
          },
        })
      }
    })

    // Execute all upserts in parallel
    await Promise.all(syncPromises)
    const syncedCount = googleReviews.length

    // Update last sync timestamp
    await prisma.venue.update({
      where: { id: venueId },
      data: {
        googleLastSyncAt: new Date(),
      },
    })

    return syncedCount
  } catch (error) {
    logger.warn(`Error syncing Google reviews for venue ${venueId}:`, error)
    throw error
  }
}

/**
 * Sync Google reviews for all connected venues
 */
export async function syncAllGoogleReviews(): Promise<{ success: number; failed: number }> {
  // Get all venues with Google Business Profile connected
  const venues = await prisma.venue.findMany({
    where: {
      googleBusinessProfileConnected: true,
      googlePlaceId: { not: null },
    },
    select: {
      id: true,
      name: true,
    },
  })

  logger.info(`Starting Google reviews sync for ${venues.length} venues`)

  let successCount = 0
  let failedCount = 0

  for (const venue of venues) {
    try {
      await syncVenueGoogleReviews(venue.id)
      successCount++
      logger.info(`✓ Synced reviews for venue: ${venue.name}`)
    } catch (error) {
      failedCount++
      logger.warn(`✗ Failed to sync reviews for venue: ${venue.name}`, error)
    }
  }

  logger.info(`Google reviews sync completed. Success: ${successCount}, Failed: ${failedCount}`)

  return { success: successCount, failed: failedCount }
}

/**
 * Setup cron job for automatic review syncing
 * Should be called once when the server starts
 */
export function setupReviewSyncCron() {
  const cron = require('node-cron')

  // Run every 6 hours at minute 0
  // Cron expression: "0 */6 * * *" means "at minute 0 past every 6th hour"
  cron.schedule('0 */6 * * *', async () => {
    logger.info('Starting scheduled Google reviews sync...')
    try {
      await syncAllGoogleReviews()
    } catch (error) {
      logger.warn('Error in scheduled Google reviews sync:', error)
    }
  })

  logger.info('Google reviews sync cron job scheduled (every 6 hours)')
}
