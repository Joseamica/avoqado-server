/**
 * SIM custody dashboard routes (plan §1.4).
 *
 * Mounted at /dashboard/organizations/:orgId/sim-custody from dashboard.routes.ts.
 *
 * Pipeline per endpoint:
 *   authenticateToken → rate-limit → idempotency (bulk only) → checkPermission → controller
 *
 * New admin bulk endpoints also gate on SERIALIZED_INVENTORY module:
 *   authenticateToken → requireSerializedInventoryModule → checkPermission →
 *     idempotency → bulkLimiter → validateRequest → controller
 */

import { Router, Request, Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { simCustodyIdempotency } from '../../middlewares/simCustodyIdempotency.middleware'
import { moduleService, MODULE_CODES } from '../../services/modules/module.service'
import {
  assignToPromoter,
  assignToPromoterDirect,
  assignToSupervisor,
  collectFromPromoter,
  collectFromSupervisor,
  listEvents,
  reassignPromoter,
  changeCategory,
} from '../../controllers/dashboard/simCustody.dashboard.controller'

const router = Router({ mergeParams: true })

// Per-actor rate limits (plan §11). Uses authContext.userId so anonymous reqs
// are rejected earlier by authenticateToken. IP fallback for safety.
const actorKey = (req: any) => req.authContext?.userId ?? req.ip
const bulkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: actorKey,
  message: { error: 'RATE_LIMIT', message: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' },
})
const singleLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: actorKey,
  message: { error: 'RATE_LIMIT', message: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' },
})

router.post(
  '/sim-custody/assign-to-supervisor',
  authenticateTokenMiddleware,
  bulkLimiter,
  simCustodyIdempotency({ required: true }),
  checkPermission('sim-custody:assign-to-supervisor'),
  assignToSupervisor,
)

router.post(
  '/sim-custody/assign-to-promoter',
  authenticateTokenMiddleware,
  bulkLimiter,
  simCustodyIdempotency({ required: true }),
  checkPermission('sim-custody:assign-to-promoter'),
  assignToPromoter,
)

// OWNER/SUPERADMIN bypass: asigna directo a Promotor sin pasar por Supervisor.
// Requires `sim-custody:assign-to-promoter-direct` (granted to OWNER only;
// SUPERADMIN inherits via wildcard `*:*`).
router.post(
  '/sim-custody/assign-to-promoter-direct',
  authenticateTokenMiddleware,
  bulkLimiter,
  simCustodyIdempotency({ required: true }),
  checkPermission('sim-custody:assign-to-promoter-direct'),
  assignToPromoterDirect,
)

router.post(
  '/sim-custody/collect-from-promoter',
  authenticateTokenMiddleware,
  singleLimiter,
  simCustodyIdempotency({ required: false }),
  checkPermission('sim-custody:collect-from-promoter'),
  collectFromPromoter,
)

router.post(
  '/sim-custody/collect-from-supervisor',
  authenticateTokenMiddleware,
  singleLimiter,
  simCustodyIdempotency({ required: false }),
  checkPermission('sim-custody:collect-from-supervisor'),
  collectFromSupervisor,
)

router.get('/sim-custody/events', authenticateTokenMiddleware, singleLimiter, listEvents)

// ─── Module gate ──────────────────────────────────────────────────────────────
//
// The SERIALIZED_INVENTORY module is org-level for PlayTelecom (OrganizationModule).
// moduleService.isModuleEnabled(venueId, ...) already has the org-level fallback:
//   1. Check VenueModule for the venue from authContext
//   2. If absent, fall back to OrganizationModule for the venue's org
// So authContext.venueId is sufficient — no extra DB lookup needed.

async function requireSerializedInventoryModule(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext ?? {}
    if (!venueId) {
      return res.status(403).json({ ok: false, moduleRequired: true, error: 'Venue no identificado para verificar el módulo.' })
    }
    const enabled = await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)
    if (!enabled) {
      return res
        .status(403)
        .json({ ok: false, moduleRequired: true, error: 'El módulo de inventario serializado no está habilitado para esta organización.' })
    }
    next()
  } catch (err) {
    next(err)
  }
}

// ─── Admin bulk endpoints (Task 6) ────────────────────────────────────────────

router.post(
  '/sim-custody/reassign-promoter',
  authenticateTokenMiddleware,
  requireSerializedInventoryModule,
  checkPermission('sim-custody:reassign'),
  simCustodyIdempotency({ required: true }),
  bulkLimiter,
  reassignPromoter,
)

router.post(
  '/sim-custody/change-category',
  authenticateTokenMiddleware,
  requireSerializedInventoryModule,
  checkPermission('serialized-inventory:change-category'),
  simCustodyIdempotency({ required: true }),
  bulkLimiter,
  changeCategory,
)

export default router
