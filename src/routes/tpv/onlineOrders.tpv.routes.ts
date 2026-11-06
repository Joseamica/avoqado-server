/**
 * Tienda híbrida (R21): la TPV cobra y entrega los folios de la tienda en línea. Monta SÓLO lo que necesita (la lista «Por pagar»,
 * aceptar, cancelar, listo, entregado y la impresión de la comanda), con los MISMOS manejadores, esquemas y permisos que
 * `/mobile/venues/:venueId/online-orders`. Nada de bandeja, rechazar, pausar ni efectivo de plataformas: eso no es de la terminal.
 */
import { Router } from 'express'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { validateRequest } from '@/middlewares/validation'
import * as ctrl from '@/controllers/mobile/onlineOrders.mobile.controller'
import { acceptSchema, orderActionSchema, toPaySchema } from '@/schemas/online-ordering.schema'

const router = Router({ mergeParams: true })

router.get('/to-pay', authenticateTokenMiddleware, validateRequest(toPaySchema), checkPermission('orders:read'), ctrl.toPay)
router.post('/:orderId/accept', authenticateTokenMiddleware, validateRequest(acceptSchema), checkPermission('orders:update'), ctrl.accept)
router.post(
  '/:orderId/ready',
  authenticateTokenMiddleware,
  validateRequest(orderActionSchema),
  checkPermission('orders:update'),
  ctrl.ready,
)
router.post(
  '/:orderId/delivered',
  authenticateTokenMiddleware,
  validateRequest(orderActionSchema),
  checkPermission('orders:update'),
  ctrl.delivered,
)
router.post(
  '/:orderId/cancel',
  authenticateTokenMiddleware,
  validateRequest(orderActionSchema),
  checkPermission('orders:cancel-unpaid'),
  ctrl.cancel,
)
router.post(
  '/:orderId/print/claim',
  authenticateTokenMiddleware,
  validateRequest(orderActionSchema),
  checkPermission('orders:update'),
  ctrl.printClaim,
)
router.post(
  '/:orderId/print/confirm',
  authenticateTokenMiddleware,
  validateRequest(orderActionSchema),
  checkPermission('orders:update'),
  ctrl.printConfirm,
)

export default router
