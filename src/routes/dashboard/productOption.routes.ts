/**
 * Biblioteca de opciones (Talla, Color…) — sub-router del dashboard. Reusa el servicio del POS
 * (`product-option.mobile.service`); la lista del dashboard pagina por su cuenta (`listProductOptionsPage`).
 * Montado en /dashboard/venues/:venueId/product-options con authenticateToken en el montaje (dashboard.routes.ts).
 */
import { Router } from 'express'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { checkFeatureAccess } from '../../middlewares/checkFeatureAccess.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as c from '../../controllers/dashboard/productGroup.controller'
import * as s from '../../schemas/dashboard/productGroup.schema'

const router = Router({ mergeParams: true })
const gate = checkFeatureAccess('PRODUCT_VARIANTS')

router.get('/', checkPermission('menu:read'), validateRequest(s.productOptionListSchema), c.listOptions)
router.post('/', checkPermission('menu:create'), gate, validateRequest(s.productOptionBodySchema), c.createOption)
router.put('/:optionId', checkPermission('menu:create'), gate, validateRequest(s.productOptionUpdateSchema), c.updateOption)
router.delete('/:optionId', checkPermission('menu:create'), gate, validateRequest(s.productOptionIdSchema), c.deleteOption)

export default router
