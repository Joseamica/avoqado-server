/**
 * Staff Onboarding State Routes
 *
 * Per-staff, per-venue key/value API for onboarding UX state (tour banners,
 * checklists, welcome-tour auto-launch flags). Replaces client-side
 * localStorage so progress persists across devices.
 *
 * All endpoints are scoped to the authenticated staff member — the staffId
 * always comes from `authContext.userId` (never from body or params) to
 * prevent tampering.
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import * as staffOnboardingService from '../../services/dashboard/staffOnboarding.service'
import prisma from '../../utils/prismaClient'

const router = Router({ mergeParams: true })

/**
 * Middleware: verifies the authenticated staff has access to the target venue.
 * SUPERADMIN bypasses the check.
 */
async function requireVenueAccess(req: Request, res: Response, next: NextFunction) {
  try {
    const authContext = (req as any).authContext
    const { userId, role } = authContext ?? {}
    const { venueId } = req.params

    if (!userId) {
      return res.status(401).json({ success: false, error: 'unauthorized', message: 'Autenticación requerida' })
    }
    if (!venueId) {
      return res.status(400).json({ success: false, error: 'bad_request', message: 'venueId es requerido' })
    }

    if (role === 'SUPERADMIN') return next()

    const assignment = await prisma.staffVenue.findUnique({
      where: { staffId_venueId: { staffId: userId, venueId } },
      select: { id: true },
    })

    if (!assignment) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Sin acceso a este venue' })
    }

    next()
  } catch (error) {
    next(error)
  }
}

const venueAccess = [authenticateTokenMiddleware, requireVenueAccess]

/**
 * GET /dashboard/venues/:venueId/onboarding-state
 * Returns all onboarding state records for the authenticated staff at this venue,
 * as a `{ [key]: state }` map.
 */
router.get('/onboarding-state', venueAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId: staffId } = (req as any).authContext
    const { venueId } = req.params

    const state = await staffOnboardingService.getOnboardingState(staffId, venueId)
    res.json({ success: true, data: state })
  } catch (error) {
    next(error)
  }
})

/**
 * PUT /dashboard/venues/:venueId/onboarding-state/:key
 * Upserts a single onboarding state record for (authenticated staff, venue, key).
 * Body: { state: any } — arbitrary JSON, <= 8KB.
 *
 * `key` is URL-encoded and may contain `::` separators (e.g. `tour-banner::inventory-welcome`).
 */
router.put('/onboarding-state/:key', venueAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId: staffId } = (req as any).authContext
    const { venueId, key } = req.params
    const { state } = req.body as { state?: unknown }

    if (state === undefined) {
      return res.status(400).json({ success: false, error: 'validation', message: 'El campo state es requerido' })
    }

    const decodedKey = decodeURIComponent(key)
    const result = await staffOnboardingService.setOnboardingState(staffId, venueId, decodedKey, state)
    res.json({ success: true, data: result })
  } catch (error: any) {
    if (error?.message?.includes('tamaño máximo') || error?.message?.includes('clave')) {
      return res.status(400).json({ success: false, error: 'validation', message: error.message })
    }
    next(error)
  }
})

/**
 * DELETE /dashboard/venues/:venueId/onboarding-state/:key
 * Clears a single onboarding state record. Idempotent.
 */
router.delete('/onboarding-state/:key', venueAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId: staffId } = (req as any).authContext
    const { venueId, key } = req.params

    const decodedKey = decodeURIComponent(key)
    await staffOnboardingService.clearOnboardingState(staffId, venueId, decodedKey)
    res.json({ success: true, data: { message: 'Onboarding state cleared' } })
  } catch (error) {
    next(error)
  }
})

export default router
