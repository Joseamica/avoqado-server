import { Router } from 'express'
import * as controller from '@/controllers/hybridBilling.controller'
const router = Router()
// Inherits authentication + current SUPERADMIN role from superadmin.routes.
router.get('/', controller.campaigns)
router.get('/catalog', controller.campaignCatalog)
router.post('/', controller.createCampaign)
router.get('/:id/redemptions', controller.campaignRedemptions)
router.get('/:id', controller.campaign)
router.put('/:id', controller.updateCampaign)
router.post('/:id/publish', controller.publishCampaign)
router.post('/:id/status', controller.campaignStatus)
export default router
