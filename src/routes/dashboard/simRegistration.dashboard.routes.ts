/**
 * SIM registration-request dashboard routes.
 *
 * Mounted at /dashboard/organizations/:orgId from dashboard.routes.ts.
 *
 * Pipeline per endpoint:
 *   authenticateToken → rate-limit → checkPermission → controller
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import {
  approveRequest,
  countRequests,
  listRequests,
  rejectRequest,
  approveStockItems,
  countStockApprovals,
  listStockApprovals,
} from '../../controllers/dashboard/simRegistration.dashboard.controller'

const router = Router({ mergeParams: true })

// Per-actor rate limits. Uses authContext.userId; IP fallback for safety.
const actorKey = (req: any) => req.authContext?.userId ?? req.ip
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: actorKey,
  message: { error: 'RATE_LIMIT', message: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' },
})

router.get(
  '/sim-registration-requests',
  authenticateTokenMiddleware,
  limiter,
  checkPermission('sim-custody:approve-registration'),
  listRequests,
)

router.get(
  '/sim-registration-requests/count',
  authenticateTokenMiddleware,
  limiter,
  checkPermission('sim-custody:approve-registration'),
  countRequests,
)

router.post(
  '/sim-registration-requests/:id/approve',
  authenticateTokenMiddleware,
  limiter,
  checkPermission('sim-custody:approve-registration'),
  approveRequest,
)

router.post(
  '/sim-registration-requests/:id/reject',
  authenticateTokenMiddleware,
  limiter,
  checkPermission('sim-custody:approve-registration'),
  rejectRequest,
)

router.get(
  '/pending-stock-approvals',
  authenticateTokenMiddleware,
  limiter,
  checkPermission('sim-custody:approve-registration'),
  listStockApprovals,
)

router.get(
  '/pending-stock-approvals/count',
  authenticateTokenMiddleware,
  limiter,
  checkPermission('sim-custody:approve-registration'),
  countStockApprovals,
)

router.post(
  '/pending-stock-approvals/approve',
  authenticateTokenMiddleware,
  limiter,
  checkPermission('sim-custody:approve-registration'),
  approveStockItems,
)

export default router
