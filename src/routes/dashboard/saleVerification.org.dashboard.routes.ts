/**
 * Org-scoped sale verification dashboard routes (PlayTelecom "Ventas" view).
 *
 * Mounted at /dashboard/organizations/:orgId/sale-verifications from
 * dashboard.routes.ts. Provides cross-venue listings, summary, chart
 * aggregations, and the back-office approve/reject endpoint.
 *
 * Pipeline per endpoint: authenticateToken → checkOrgAccess → checkPermission → controller
 */

import { Router } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import * as ctrl from '../../controllers/dashboard/sale-verification.org.dashboard.controller'
// Mismo candado que el resto de las rutas de organización: membresía ACTIVA en la base y SUPERADMIN
// sólo si lo es de verdad (Codex ronda 3; antes era una copia que le creía al token).
import { checkOrgAccess } from './organizationDashboard.routes'

const router = Router({ mergeParams: true })

router.use(authenticateTokenMiddleware)
router.use(checkOrgAccess)

router.get('/', checkPermission('sale-verifications:review'), ctrl.listOrgSaleVerifications)
router.get('/summary', checkPermission('sale-verifications:review'), ctrl.getOrgSalesSummary)
router.get('/by-month', checkPermission('sale-verifications:review'), ctrl.getSalesByMonth)
router.get('/by-sim-type', checkPermission('sale-verifications:review'), ctrl.getSalesBySimType)
router.get('/by-week', checkPermission('sale-verifications:review'), ctrl.getSalesByWeek)
router.get('/by-sale-type-weekly', checkPermission('sale-verifications:review'), ctrl.getSalesBySaleTypeWeekly)
router.get('/by-sim-type-weekly', checkPermission('sale-verifications:review'), ctrl.getSalesBySimTypeWeekly)
router.get('/by-city', checkPermission('sale-verifications:review'), ctrl.getSalesByCity)
router.get('/by-supervisor', checkPermission('sale-verifications:review'), ctrl.getSalesBySupervisor)
router.get('/by-store', checkPermission('sale-verifications:review'), ctrl.getSalesByStore)
router.get('/by-promoter', checkPermission('sale-verifications:review'), ctrl.getSalesByPromoter)
router.get('/by-promoter-daily', checkPermission('sale-verifications:review'), ctrl.getSalesByPromoterDaily)

router.patch('/:id/review', checkPermission('sale-verifications:review'), ctrl.reviewOrgSaleVerification)
router.post('/:id/reopen', checkPermission('sale-verifications:reopen'), ctrl.reopenOrgSaleVerification)
router.patch('/:id', checkPermission('sale-verifications:edit'), ctrl.editOrgSaleVerification)

export default router
