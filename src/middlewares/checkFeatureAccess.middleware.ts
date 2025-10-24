/**
 * Feature Access Control Middleware
 *
 * Validates if a venue has an active subscription for a specific feature.
 * This middleware enforces that only venues with paid/trial subscriptions
 * can access feature-specific endpoints.
 *
 * Usage:
 * router.get('/analytics', authenticateTokenMiddleware, checkFeatureAccess('ANALYTICS'), ...)
 */

import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

/**
 * Middleware factory to check if venue has access to a specific feature
 *
 * @param featureCode - The feature code to check (e.g., 'ANALYTICS', 'ADVANCED_INVENTORY')
 * @returns Express middleware function
 */
export function checkFeatureAccess(featureCode: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authContext = (req as any).authContext

      if (!authContext || !authContext.venueId) {
        logger.warn('⚠️ Feature access check failed: No auth context', { featureCode })
        res.status(401).json({
          error: 'Unauthorized',
          message: 'No venue context found',
        })
        return
      }

      const { venueId, userId } = authContext

      // Query VenueFeature to check if feature is active
      const venueFeature = await prisma.venueFeature.findFirst({
        where: {
          venueId,
          feature: {
            code: featureCode,
          },
        },
        include: {
          feature: true,
        },
      })

      // Feature not found or not active
      if (!venueFeature || !venueFeature.active) {
        logger.warn('⚠️ Feature access denied: Feature not active', {
          venueId,
          userId,
          featureCode,
          hasFeature: !!venueFeature,
          isActive: venueFeature?.active || false,
        })

        res.status(403).json({
          error: 'Feature not available',
          message: `This venue does not have access to the ${featureCode} feature. Please subscribe to enable this feature.`,
          featureCode,
          subscriptionRequired: true,
        })
        return
      }

      // Check if trial has expired (endDate is in the past)
      const now = new Date()
      if (venueFeature.endDate && venueFeature.endDate < now) {
        logger.warn('⚠️ Feature access denied: Trial expired', {
          venueId,
          userId,
          featureCode,
          endDate: venueFeature.endDate,
        })

        res.status(403).json({
          error: 'Feature trial expired',
          message: `Your trial for ${venueFeature.feature.name} has expired. Please add a payment method to continue using this feature.`,
          featureCode,
          featureName: venueFeature.feature.name,
          trialExpired: true,
          expirationDate: venueFeature.endDate,
        })
        return
      }

      // Feature is active - allow access
      // Optionally attach feature info to request for use in controllers
      ;(req as any).venueFeature = {
        id: venueFeature.id,
        featureCode,
        featureName: venueFeature.feature.name,
        isTrialing: !!venueFeature.endDate,
        trialEndsAt: venueFeature.endDate,
        subscriptionId: venueFeature.stripeSubscriptionId,
      }

      logger.info('✅ Feature access granted', {
        venueId,
        userId,
        featureCode,
        isTrialing: !!venueFeature.endDate,
      })

      next()
    } catch (error) {
      logger.error('❌ Feature access check error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        featureCode,
        venueId: (req as any).authContext?.venueId,
      })

      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to verify feature access',
      })
    }
  }
}

/**
 * Middleware to check if venue has access to ANY of the specified features
 *
 * @param featureCodes - Array of feature codes (e.g., ['ANALYTICS', 'REPORTS'])
 * @returns Express middleware function
 */
export function checkAnyFeatureAccess(featureCodes: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authContext = (req as any).authContext

      if (!authContext || !authContext.venueId) {
        logger.warn('⚠️ Feature access check failed: No auth context', { featureCodes })
        res.status(401).json({
          error: 'Unauthorized',
          message: 'No venue context found',
        })
        return
      }

      const { venueId, userId } = authContext

      // Query for any active feature in the list
      const venueFeature = await prisma.venueFeature.findFirst({
        where: {
          venueId,
          active: true,
          feature: {
            code: {
              in: featureCodes,
            },
          },
        },
        include: {
          feature: true,
        },
      })

      if (!venueFeature) {
        logger.warn('⚠️ Feature access denied: No active features found', {
          venueId,
          userId,
          featureCodes,
        })

        res.status(403).json({
          error: 'Feature not available',
          message: `This venue requires access to one of these features: ${featureCodes.join(', ')}`,
          featureCodes,
          subscriptionRequired: true,
        })
        return
      }

      // Check trial expiration
      const now = new Date()
      if (venueFeature.endDate && venueFeature.endDate < now) {
        logger.warn('⚠️ Feature access denied: Trial expired', {
          venueId,
          userId,
          featureCode: venueFeature.feature.code,
          endDate: venueFeature.endDate,
        })

        res.status(403).json({
          error: 'Feature trial expired',
          message: `Your trial for ${venueFeature.feature.name} has expired.`,
          featureCode: venueFeature.feature.code,
          trialExpired: true,
          expirationDate: venueFeature.endDate,
        })
        return
      }

      // Attach feature info to request
      ;(req as any).venueFeature = {
        id: venueFeature.id,
        featureCode: venueFeature.feature.code,
        featureName: venueFeature.feature.name,
        isTrialing: !!venueFeature.endDate,
        trialEndsAt: venueFeature.endDate,
        subscriptionId: venueFeature.stripeSubscriptionId,
      }

      logger.info('✅ Feature access granted', {
        venueId,
        userId,
        featureCode: venueFeature.feature.code,
      })

      next()
    } catch (error) {
      logger.error('❌ Feature access check error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        featureCodes,
        venueId: (req as any).authContext?.venueId,
      })

      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to verify feature access',
      })
    }
  }
}

/**
 * Helper function to check feature access programmatically (for use in services)
 *
 * @param venueId - The venue ID
 * @param featureCode - The feature code to check
 * @returns Object with access status and details
 */
export async function hasFeatureAccess(
  venueId: string,
  featureCode: string,
): Promise<{
  hasAccess: boolean
  isTrialing: boolean
  trialEndsAt: Date | null
  reason?: string
}> {
  try {
    const venueFeature = await prisma.venueFeature.findFirst({
      where: {
        venueId,
        feature: {
          code: featureCode,
        },
      },
      include: {
        feature: true,
      },
    })

    if (!venueFeature || !venueFeature.active) {
      return {
        hasAccess: false,
        isTrialing: false,
        trialEndsAt: null,
        reason: 'Feature not active',
      }
    }

    const now = new Date()
    if (venueFeature.endDate && venueFeature.endDate < now) {
      return {
        hasAccess: false,
        isTrialing: true,
        trialEndsAt: venueFeature.endDate,
        reason: 'Trial expired',
      }
    }

    return {
      hasAccess: true,
      isTrialing: !!venueFeature.endDate,
      trialEndsAt: venueFeature.endDate,
    }
  } catch (error) {
    logger.error('❌ Error checking feature access', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId,
      featureCode,
    })

    return {
      hasAccess: false,
      isTrialing: false,
      trialEndsAt: null,
      reason: 'Error checking access',
    }
  }
}

export default {
  checkFeatureAccess,
  checkAnyFeatureAccess,
  hasFeatureAccess,
}
