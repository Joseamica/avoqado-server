/**
 * @pending-implementation
 * Feature Access Control Middleware
 *
 * STATUS: Implemented but not yet applied to routes.
 * This middleware is ready to use but hasn't been added to route definitions yet.
 * It will be gradually applied to premium/paid feature endpoints.
 *
 * Validates if a venue has an active subscription for a specific feature.
 * This middleware enforces that only venues with paid/trial subscriptions
 * can access feature-specific endpoints.
 *
 * Usage:
 * router.get('/analytics', authenticateTokenMiddleware, checkFeatureAccess('ANALYTICS'), ...)
 */

import { Request, Response, NextFunction } from 'express'
import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import {
  PAID_PLAN_TIER_CODES,
  PREMIUM_ONLY_CODES,
  FREE_TIER_CODES,
  getVenueBaseTier,
  venueHasFeatureAccess,
  venueIsExemptFromPlanGating,
} from '@/services/access/basePlan.service'
import { resolveRequestVenueId } from './checkPermission.middleware'

/**
 * Platform SUPERADMIN bypass — mirrors checkPermission's superadmin rule (any StaffVenue with role
 * SUPERADMIN, disabled while impersonating) and the dashboard's useVenueTier (`isSuperadmin → true`).
 * A superadmin sees EVERY feature on EVERY venue, so feature gates must let them through too — without
 * this, a superadmin inspecting a non-Premium venue (e.g. a Pro venue's accounting) wrongly 403s.
 */
async function requestIsSuperAdmin(authContext: { userId: string; isImpersonating?: boolean }): Promise<boolean> {
  if (authContext.isImpersonating) return false
  const superAdminVenue = await prisma.staffVenue.findFirst({
    where: { staffId: authContext.userId, role: StaffRole.SUPERADMIN },
    select: { id: true },
  })
  return !!superAdminVenue
}

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

      if (!authContext || !authContext.userId) {
        logger.warn('⚠️ Feature access check failed: No auth context', { featureCode })
        res.status(401).json({
          error: 'Unauthorized',
          message: 'No venue context found',
        })
        return
      }

      const userId = authContext.userId
      // Resolve the venue being ACCESSED (URL :venueId → x-venue-id header → token), NOT just the
      // token's home venue. Mirrors checkPermission's resolveRequestVenueId so the feature gate
      // tracks the venue the request operates on (fixes false 403s when the active venue ≠ token venue).
      const venueId = resolveRequestVenueId(req, authContext)
      if (!venueId) {
        logger.warn('⚠️ Feature access check failed: No venueId', { featureCode })
        res.status(401).json({ error: 'Unauthorized', message: 'No venue context found' })
        return
      }

      // SUPERADMIN bypass: a platform superadmin sees EVERY feature on EVERY venue (mirrors
      // checkPermission + useVenueTier). Without this, a superadmin inspecting a non-Premium venue
      // 403s on feature-gated endpoints (e.g. a Pro venue's accounting/CFDI routes).
      if (await requestIsSuperAdmin(authContext)) {
        ;(req as any).venueFeature = { featureCode, grantedBy: 'SUPERADMIN' }
        return next()
      }

      // EXEMPT short-circuit: a grandfathered venue (Venue.seatCapExempt === true) operates
      // as it did before tier monetization, and a DEMO venue (Venue.status LIVE_DEMO / TRIAL)
      // must showcase every feature — full feature access for ANY code, no paywall, for both.
      // Checked here, BEFORE the tier check, the same place superadmin is let through (above),
      // so legacy venues (e.g. a hotel using reservations with no RESERVATIONS grant) and
      // demos never 403 on a feature-gated endpoint. Single venue lookup (seatCapExempt+status).
      if (await venueIsExemptFromPlanGating(venueId)) {
        ;(req as any).venueFeature = { featureCode, grantedBy: 'GRANDFATHERED_OR_DEMO' }
        return next()
      }

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
        // Tier-aware blanket grant: the venue's base plan unlocks features included in its tier
        // (mirrors venueHasFeatureAccess). FREE_TIER_CODES are promised to everyone (even with
        // no plan); PREMIUM unlocks all non-tier features; PRO unlocks all except the Premium-only
        // differentiators (PREMIUM_ONLY_CODES). The plan tiers themselves are never
        // blanket-granted. An explicit own VenueFeature (checked above) always wins.
        if (!PAID_PLAN_TIER_CODES.includes(featureCode as any)) {
          if ((FREE_TIER_CODES as readonly string[]).includes(featureCode)) {
            ;(req as any).venueFeature = { featureCode, grantedBy: 'FREE_TIER' }
            return next()
          }
          const tier = await getVenueBaseTier(venueId)
          const grantedByPlan = tier === 'PREMIUM' || (tier === 'PRO' && !(PREMIUM_ONLY_CODES as readonly string[]).includes(featureCode))
          if (grantedByPlan) {
            ;(req as any).venueFeature = { featureCode, grantedBy: 'BASE_PLAN' }
            return next()
          }
        }

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

      // Check if subscription is suspended due to payment failure
      if (venueFeature.suspendedAt) {
        logger.warn('⚠️ Feature access denied: Subscription suspended', {
          venueId,
          userId,
          featureCode,
          suspendedAt: venueFeature.suspendedAt,
          gracePeriodEndsAt: venueFeature.gracePeriodEndsAt,
          paymentFailureCount: venueFeature.paymentFailureCount,
        })

        res.status(403).json({
          error: 'Subscription suspended',
          message: `Your subscription for ${venueFeature.feature.name} has been suspended due to payment failure. Please update your payment method to restore access.`,
          featureCode,
          featureName: venueFeature.feature.name,
          suspended: true,
          suspendedAt: venueFeature.suspendedAt,
          gracePeriodEndsAt: venueFeature.gracePeriodEndsAt,
          paymentFailureCount: venueFeature.paymentFailureCount,
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
 * PUBLIC (unauthenticated) plan-gate variant of {@link checkFeatureAccess} for venue-scoped
 * public routes (`/venues/:venueSlug/...`). Those requests carry NO authContext and identify
 * the venue by SLUG, so the dashboard middleware (authContext + :venueId) cannot be reused.
 *
 * Behavior — deliberately different from the dashboard gate in three ways:
 *   1. Slug resolution mirrors the public controllers' `resolveVenueBySlug`
 *      (findFirst on `slug` + `active: true`), selecting ONLY the id.
 *   2. Unknown slug → pass through (next()) so the controller produces its existing
 *      404 ('Negocio no encontrado') — never a misleading 403 for a venue that doesn't exist.
 *   3. FAIL-OPEN on unexpected errors (log + next()): a gating bug must never take down
 *      public booking for entitled venues. The dashboard gate fails closed (500); here the
 *      stakes are inverted — a lost end-customer booking costs the venue real money.
 *
 * Entitlement uses {@link venueHasFeatureAccess}, the same resolver the dashboard relies on
 * (grandfathered/demo exemption → own grant → tier blanket), so both planes can never disagree.
 *
 * The 403 body is CUSTOMER-facing: the end customer is not the one with the plan, so the
 * message never mentions plans/upgrades — just that the venue doesn't offer the capability.
 *
 * Usage:
 * router.post('/venues/:venueSlug/reservations', limiter, checkPublicVenueFeature('RESERVATIONS', msg), ...)
 *
 * @param featureCode - The feature code to check (e.g., 'RESERVATIONS')
 * @param customerMessage - Optional Spanish, customer-friendly 403 message override
 * @returns Express middleware function
 */
export function checkPublicVenueFeature(featureCode: string, customerMessage?: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const venueSlug = req.params?.venueSlug
      if (!venueSlug) return next() // no slug param on this route — nothing to gate on

      // Same slug→venue resolution as the public controllers (slug + active), id only.
      const venue = await prisma.venue.findFirst({
        where: { slug: venueSlug, active: true },
        select: { id: true },
      })

      // Unknown slug → let the controller produce its existing 404.
      if (!venue) return next()

      const allowed = await venueHasFeatureAccess(venue.id, featureCode)
      if (!allowed) {
        logger.warn('⚠️ Public feature access denied: venue plan does not include feature', {
          venueSlug,
          venueId: venue.id,
          featureCode,
        })
        res.status(403).json({
          error: 'Feature not available',
          code: 'PLAN_REQUIRED',
          message: customerMessage ?? 'Este negocio no tiene esta función disponible en línea por el momento.',
        })
        return
      }

      next()
    } catch (error) {
      // FAIL-OPEN: never let a gating bug 500 the public booking surface (see JSDoc).
      logger.error('❌ Public feature access check error — failing open', {
        error: error instanceof Error ? error.message : 'Unknown error',
        featureCode,
        venueSlug: req.params?.venueSlug,
      })
      next()
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

      if (!authContext || !authContext.userId) {
        logger.warn('⚠️ Feature access check failed: No auth context', { featureCodes })
        res.status(401).json({
          error: 'Unauthorized',
          message: 'No venue context found',
        })
        return
      }

      const userId = authContext.userId
      const venueId = resolveRequestVenueId(req, authContext)
      if (!venueId) {
        logger.warn('⚠️ Feature access check failed: No venueId', { featureCodes })
        res.status(401).json({ error: 'Unauthorized', message: 'No venue context found' })
        return
      }

      // SUPERADMIN bypass (same as checkFeatureAccess): a platform superadmin sees every feature.
      if (await requestIsSuperAdmin(authContext)) {
        ;(req as any).venueFeature = { featureCodes, grantedBy: 'SUPERADMIN' }
        return next()
      }

      // EXEMPT short-circuit (same as checkFeatureAccess): a grandfathered or demo-status
      // venue is exempt from feature paywalls and gets through any of the requested codes.
      if (await venueIsExemptFromPlanGating(venueId)) {
        ;(req as any).venueFeature = { featureCodes, grantedBy: 'GRANDFATHERED_OR_DEMO' }
        return next()
      }

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

      // Check if subscription is suspended due to payment failure
      if (venueFeature.suspendedAt) {
        logger.warn('⚠️ Feature access denied: Subscription suspended', {
          venueId,
          userId,
          featureCode: venueFeature.feature.code,
          suspendedAt: venueFeature.suspendedAt,
          gracePeriodEndsAt: venueFeature.gracePeriodEndsAt,
          paymentFailureCount: venueFeature.paymentFailureCount,
        })

        res.status(403).json({
          error: 'Subscription suspended',
          message: `Your subscription for ${venueFeature.feature.name} has been suspended due to payment failure. Please update your payment method to restore access.`,
          featureCode: venueFeature.feature.code,
          featureName: venueFeature.feature.name,
          suspended: true,
          suspendedAt: venueFeature.suspendedAt,
          gracePeriodEndsAt: venueFeature.gracePeriodEndsAt,
          paymentFailureCount: venueFeature.paymentFailureCount,
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
    // EXEMPT short-circuit: grandfathered and demo-status venues are exempt from feature
    // paywalls and have access to any feature, mirroring venueHasFeatureAccess + the middleware.
    if (await venueIsExemptFromPlanGating(venueId)) {
      return { hasAccess: true, isTrialing: false, trialEndsAt: null }
    }

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
      // Tier-aware blanket grant (mirrors venueHasFeatureAccess): FREE_TIER_CODES are promised to
      // everyone; PREMIUM unlocks all non-tier features; PRO unlocks all except
      // PREMIUM_ONLY_CODES. An explicit own VenueFeature wins.
      if (!PAID_PLAN_TIER_CODES.includes(featureCode as any)) {
        if ((FREE_TIER_CODES as readonly string[]).includes(featureCode)) {
          return { hasAccess: true, isTrialing: false, trialEndsAt: null }
        }
        const tier = await getVenueBaseTier(venueId)
        const grantedByPlan = tier === 'PREMIUM' || (tier === 'PRO' && !(PREMIUM_ONLY_CODES as readonly string[]).includes(featureCode))
        if (grantedByPlan) {
          return { hasAccess: true, isTrialing: false, trialEndsAt: null }
        }
      }
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

    // Check if subscription is suspended
    if (venueFeature.suspendedAt) {
      return {
        hasAccess: false,
        isTrialing: false,
        trialEndsAt: null,
        reason: 'Subscription suspended due to payment failure',
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
  checkPublicVenueFeature,
  checkAnyFeatureAccess,
  hasFeatureAccess,
}
