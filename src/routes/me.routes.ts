/**
 * Me Routes
 *
 * Routes for the current authenticated user.
 * These endpoints provide information about the current user's access and permissions.
 *
 * Base path: /api/v1/me
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { getUserAccess, createAccessCache } from '@/services/access/access.service'
import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'

const router = Router()

/**
 * GET /api/v1/me/access
 *
 * Get the current user's access information for a specific venue.
 * Returns core permissions, white-label status, and feature access.
 *
 * Query params:
 * - venueId (optional): Target venue ID. If not provided, uses the venue from JWT token.
 *
 * Response:
 * {
 *   userId: string,
 *   venueId: string,
 *   organizationId: string,
 *   role: string,
 *   corePermissions: string[],
 *   whiteLabelEnabled: boolean,
 *   enabledFeatures: string[],
 *   featureAccess: { [code: string]: { allowed: boolean, reason?: string, dataScope: string } }
 * }
 */
router.get('/access', authenticateTokenMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authContext = (req as any).authContext
    const { userId } = authContext

    // Get target venueId from query param or use the one from JWT
    const targetVenueId = (req.query.venueId as string) || authContext.venueId

    if (!targetVenueId) {
      throw new BadRequestError('venueId is required either in query params or JWT token')
    }

    logger.info(`me.routes: Getting access for user ${userId} in venue ${targetVenueId}`)

    // Create a cache for this request (useful if we add more endpoints that need access)
    const cache = createAccessCache()

    const access = await getUserAccess(userId, targetVenueId, cache)

    res.json(access)
  } catch (error) {
    next(error)
  }
})

/**
 * GET /api/v1/me/venues
 *
 * Get all venues the current user has access to, with their roles.
 * Useful for venue selectors and multi-venue dashboards.
 *
 * Response:
 * {
 *   venues: [
 *     {
 *       id: string,
 *       name: string,
 *       slug: string,
 *       role: string,
 *       organizationId: string,
 *       organizationName: string
 *     }
 *   ]
 * }
 */
router.get('/venues', authenticateTokenMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authContext = (req as any).authContext
    const { userId } = authContext

    // Import prisma here to avoid circular dependencies
    const prisma = (await import('@/utils/prismaClient')).default

    const staffVenues = await prisma.staffVenue.findMany({
      where: {
        staffId: userId,
        active: true,
      },
      select: {
        role: true,
        venue: {
          select: {
            id: true,
            name: true,
            slug: true,
            organizationId: true,
            organization: {
              select: {
                name: true,
              },
            },
          },
        },
      },
      orderBy: {
        venue: {
          name: 'asc',
        },
      },
    })

    const venues = staffVenues.map(sv => ({
      id: sv.venue.id,
      name: sv.venue.name,
      slug: sv.venue.slug,
      role: sv.role,
      organizationId: sv.venue.organizationId,
      organizationName: sv.venue.organization.name,
    }))

    res.json({ venues })
  } catch (error) {
    next(error)
  }
})

export default router
