/**
 * Tienda híbrida (R21): la TPV cobra y entrega los folios de la tienda en línea. Monta SÓLO lo que necesita (la lista «Por pagar»,
 * leer un pedido (D661), aceptar, cancelar, listo, entregado y la impresión de la comanda), con los MISMOS manejadores, esquemas y
 * permisos que `/mobile/venues/:venueId/online-orders`. Nada de bandeja, rechazar, pausar ni efectivo de plataformas: no es de la terminal.
 */
import { Router } from 'express'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { validateVenueAccess } from '@/middlewares/validateVenueAccess.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { validateRequest } from '@/middlewares/validation'
import * as ctrl from '@/controllers/mobile/onlineOrders.mobile.controller'
import { getOnlineOrderHandler } from '@/controllers/dashboard/onlineOrdering.dashboard.controller'
import { acceptSchema, orderActionSchema, toPaySchema } from '@/schemas/online-ordering.schema'

const router = Router({ mergeParams: true })
// Una TPV está atada a UN negocio por sesión: el `:venueId` de la URL debe ser el del token (plan IDOR). Sin esto, quien tiene rol en dos
// sucursales haría latir la caja de B desde la TPV de A.
router.use(authenticateTokenMiddleware, validateVenueAccess)

router.get('/to-pay', validateRequest(toPaySchema), checkPermission('orders:read'), ctrl.toPay)
// D661 (Ruling 14): UN pedido por su cuenta, el mismo lector y manejador del panel; después de `/to-pay` («to-pay» no es un id).
router.get('/:orderId', validateRequest(orderActionSchema), checkPermission('orders:read'), getOnlineOrderHandler)
router.post('/:orderId/accept', validateRequest(acceptSchema), checkPermission('orders:update'), ctrl.accept)
router.post('/:orderId/ready', validateRequest(orderActionSchema), checkPermission('orders:update'), ctrl.ready)
router.post('/:orderId/delivered', validateRequest(orderActionSchema), checkPermission('orders:update'), ctrl.delivered)
router.post('/:orderId/cancel', validateRequest(orderActionSchema), checkPermission('orders:cancel-unpaid'), ctrl.cancel)
router.post('/:orderId/print/claim', validateRequest(orderActionSchema), checkPermission('orders:update'), ctrl.printClaim)
router.post('/:orderId/print/confirm', validateRequest(orderActionSchema), checkPermission('orders:update'), ctrl.printConfirm)

export default router
