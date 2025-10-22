/**
 * Feature Service
 *
 * Manages platform features that venues can enable/disable
 */

import prisma from '@/utils/prismaClient'
import { Feature } from '@prisma/client'

/**
 * Get all active features available for venues
 *
 * @returns List of active features grouped by category
 */
export async function getAvailableFeatures(): Promise<Feature[]> {
  const features = await prisma.feature.findMany({
    where: {
      active: true,
    },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  })

  return features
}

/**
 * Get features enabled for a specific venue
 *
 * @param venueId - Venue ID
 * @returns List of enabled features for the venue
 */
export async function getVenueFeatures(venueId: string): Promise<Feature[]> {
  const venueFeatures = await prisma.venueFeature.findMany({
    where: {
      venueId,
      active: true,
    },
    include: {
      feature: true,
    },
  })

  return venueFeatures.map(vf => vf.feature)
}

/**
 * Save selected features for a venue
 *
 * @param venueId - Venue ID
 * @param featureIds - Array of feature IDs to enable
 * @returns List of enabled features
 */
export async function saveVenueFeatures(venueId: string, featureIds: string[]): Promise<Feature[]> {
  // Verify all feature IDs exist and are active
  const features = await prisma.feature.findMany({
    where: {
      id: { in: featureIds },
      active: true,
    },
  })

  if (features.length !== featureIds.length) {
    const foundIds = features.map(f => f.id)
    const missingIds = featureIds.filter(id => !foundIds.includes(id))
    throw new Error(`Invalid or inactive feature IDs: ${missingIds.join(', ')}`)
  }

  // Use transaction to ensure atomicity
  await prisma.$transaction(async tx => {
    // Delete existing venue features
    await tx.venueFeature.deleteMany({
      where: { venueId },
    })

    // Create new venue features
    await tx.venueFeature.createMany({
      data: features.map(feature => ({
        venueId,
        featureId: feature.id,
        monthlyPrice: feature.monthlyPrice,
        active: true,
      })),
    })
  })

  // Return the enabled features
  return features
}
