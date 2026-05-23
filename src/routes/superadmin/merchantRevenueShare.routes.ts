import { Router } from 'express'
import * as controller from '../../controllers/superadmin/merchantRevenueShare.controller'

/**
 * MerchantRevenueShare routes
 * Base path: /api/v1/dashboard/superadmin/merchant-revenue-shares
 * All routes require SUPERADMIN role (enforced by parent router middleware).
 *
 * Spec: docs/superpowers/specs/2026-05-22-revenue-share-fee-model-design.md
 */
const router = Router()

router.get('/', controller.getMerchantRevenueShares)
router.get('/report', controller.getRevenueShareReport) // antes de /:id para que no entre como id
router.get('/by-merchant', controller.getMerchantRevenueShareByMerchant)
router.get('/:id', controller.getMerchantRevenueShareById)
router.post('/', controller.createMerchantRevenueShare)
router.put('/:id', controller.updateMerchantRevenueShare)
router.delete('/:id', controller.deleteMerchantRevenueShare)

export default router
