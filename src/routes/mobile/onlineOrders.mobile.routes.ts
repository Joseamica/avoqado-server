import { Router } from 'express'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { validateRequest } from '@/middlewares/validation'
import * as ctrl from '@/controllers/mobile/onlineOrders.mobile.controller'
import { acceptSchema, inboxSchema, orderActionSchema, pauseSchema, rejectSchema } from '@/schemas/online-ordering.schema'

const router = Router({ mergeParams: true })

// R14: sin candado de plan. Perder el plan bloquea pedidos NUEVOS (público) y configurar (panel), nunca atender los que ya
// existen. Orden: auth → validación → permiso. `:orderId` es el id de la CUENTA (`Order.id`, el `orderId` de la bandeja).
router.get('/inbox', authenticateTokenMiddleware, validateRequest(inboxSchema), checkPermission('orders:read'), ctrl.inbox)
// R12 (founder, 16-oct): pausar desde el piso tiene su propio permiso, de gerente para arriba. En el POS, la cajera lo logra con
// el PIN del gerente (`x-permission-override`, que `checkPermission` ya resuelve). Sólo admite 15, 30 o 60 minutos (o null).
router.post('/pause', authenticateTokenMiddleware, validateRequest(pauseSchema), checkPermission('online-orders:pause'), ctrl.pause)

router.post('/:orderId/accept', authenticateTokenMiddleware, validateRequest(acceptSchema), checkPermission('orders:update'), ctrl.accept)
router.post('/:orderId/reject', authenticateTokenMiddleware, validateRequest(rejectSchema), checkPermission('orders:update'), ctrl.reject)
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
// R15: cancelar exige el permiso de la terminal, como `DELETE /mobile/venues/:venueId/orders/:orderId`.
router.post(
  '/:orderId/cancel',
  authenticateTokenMiddleware,
  validateRequest(orderActionSchema),
  checkPermission('orders:cancel-unpaid'),
  ctrl.cancel,
)

// Impresión de la comanda (cabecera `x-device-id`). El aparato lo dice el cliente, así que el permiso va atado al `:venueId`
// de la ruta. La llave es `Order.id`: con el `onlineOrderId` el reclamo daría `claimed: false` siempre y nadie imprimiría.
// `confirm` con `ok: false` = ya estaba sellada o este aparato perdió el reclamo; NO significa «reimprime».
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
