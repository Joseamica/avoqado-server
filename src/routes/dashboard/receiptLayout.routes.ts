/**
 * Diseño del ticket en papel (spec § 7.2). Se monta en
 * /dashboard/venues/:venueId/receipt-layout con authenticateToken aplicado EN EL MONTAJE
 * (ver dashboard.routes.ts). Orden: checkPermission → validateRequest → controlador, el
 * mismo que printStation.routes.ts.
 */
import { Router } from 'express'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as controller from '../../controllers/dashboard/receiptLayout.dashboard.controller'
import {
  deleteReceiptLayoutSchema,
  getReceiptLayoutSchema,
  getTemplatesSchema,
  previewReceiptLayoutSchema,
  putReceiptLayoutSchema,
} from '../../schemas/dashboard/receiptLayout.schema'

const router = Router({ mergeParams: true })

// Rutas estáticas ANTES de las de raíz (Express empareja en orden).
router.get('/templates', checkPermission('receipt-layout:read'), validateRequest(getTemplatesSchema), controller.templates)
router.post('/preview', checkPermission('receipt-layout:read'), validateRequest(previewReceiptLayoutSchema), controller.preview)

router.get('/', checkPermission('receipt-layout:read'), validateRequest(getReceiptLayoutSchema), controller.get)
router.put('/', checkPermission('receipt-layout:manage'), validateRequest(putReceiptLayoutSchema), controller.put)
router.delete('/', checkPermission('receipt-layout:manage'), validateRequest(deleteReceiptLayoutSchema), controller.reset)

export default router
