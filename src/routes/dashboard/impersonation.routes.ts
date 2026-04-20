/**
 * Impersonation routes — SUPERADMIN-only endpoints used by the dashboard picker
 * and banner to manage a read-only impersonation session.
 *
 * Mounted at `/api/v1/dashboard/impersonation/*` from dashboard.routes.ts.
 *
 * Note: the impersonation-guard middleware (invoked inside authenticateToken)
 * whitelists this path family so `/stop`, `/extend`, and `/status` work even
 * when the current session is already an impersonation session.
 */
import { Router } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import * as impersonationController from '../../controllers/dashboard/impersonation.controller'

const router: Router = Router()

// Start a new impersonation session. Requires real SUPERADMIN.
router.post('/start', authenticateTokenMiddleware, impersonationController.startHandler)

// Extend the active impersonation session by 15 min. Max 2 extensions.
router.post('/extend', authenticateTokenMiddleware, impersonationController.extendHandler)

// End the active impersonation session and return to a normal SUPERADMIN token.
router.post('/stop', authenticateTokenMiddleware, impersonationController.stopHandler)

// Get the current session's impersonation state (for frontend hydration).
router.get('/status', authenticateTokenMiddleware, impersonationController.statusHandler)

// List staff + roles available as impersonation targets for the current venue.
router.get('/eligible-targets', authenticateTokenMiddleware, impersonationController.eligibleTargetsHandler)

export default router
