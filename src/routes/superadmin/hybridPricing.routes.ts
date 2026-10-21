import { Router } from 'express'
import * as controller from '@/controllers/hybridPricing.controller'
const router = Router()
// «Precios» (list prices, previous-rate notices) and «% de descuento» groups. Inherits authentication + current
// SUPERADMIN role from superadmin.routes. Product keys travel URL-encoded: /lists/FEATURE%3ACFDI.
router.get('/', controller.board)
router.put('/lists/:productKey', controller.saveList)
router.post('/lists/:productKey/retry', controller.retryList)
router.post('/lists/:productKey/status', controller.listStatus)
router.get('/gaps', controller.gaps)
router.get('/gaps/:productKey', controller.gapVenues)
router.get('/percent', controller.percentGroups)
router.post('/percent/preview', controller.previewPercent)
router.post('/percent', controller.createPercent)
router.get('/percent/:groupId', controller.percentGroup)
router.post('/percent/:groupId/status', controller.percentStatus)
router.post('/percent/:groupId/recalculate', controller.recalculatePercent)
export default router
