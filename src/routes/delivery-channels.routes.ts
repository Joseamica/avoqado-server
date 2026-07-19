/**
 * Gestión de canales de delivery (DeliveryChannelLink CRUD + pause, Task 10).
 *
 * `delivery-channels:read` / `delivery-channels:manage` (permisos) y `DELIVERY_CHANNELS`
 * (Feature code) todavía NO existen en el catálogo — Task 11 los registra
 * (permissions.ts / basePlan.service.ts). Referenciarlos aquí por string es
 * correcto y esperado; hasta que Task 11 aterrice, estos endpoints son
 * inalcanzables para cualquier rol (fail-closed, nunca fail-open).
 *
 * Middleware order (precedente real del repo: MERCHANT_ROUTING_RULES,
 * dashboard.routes.ts ~3247, comentario "validate body BEFORE feature/perm
 * checks" — permissions-policy.md): validar el body ANTES de feature/permiso.
 */
import { Router } from 'express'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import { checkPermission } from '../middlewares/checkPermission.middleware'
import { checkFeatureAccess } from '../middlewares/checkFeatureAccess.middleware'
import { validateRequest } from '../middlewares/validation'
import * as ctrl from '../controllers/delivery-channels/deliveryChannels.controller'
import { createChannelSchema, updateChannelSchema, pauseChannelSchema } from '../schemas/delivery-channels.schema'

const router = Router({ mergeParams: true })

router.get(
  '/venues/:venueId/channels',
  authenticateTokenMiddleware,
  checkFeatureAccess('DELIVERY_CHANNELS'),
  checkPermission('delivery-channels:read'),
  ctrl.listChannels,
)

router.post(
  '/venues/:venueId/channels',
  authenticateTokenMiddleware,
  validateRequest(createChannelSchema),
  checkFeatureAccess('DELIVERY_CHANNELS'),
  checkPermission('delivery-channels:manage'),
  ctrl.createChannel,
)

router.patch(
  '/venues/:venueId/channels/:linkId',
  authenticateTokenMiddleware,
  validateRequest(updateChannelSchema),
  checkFeatureAccess('DELIVERY_CHANNELS'),
  checkPermission('delivery-channels:manage'),
  ctrl.updateChannel,
)

router.post(
  '/venues/:venueId/channels/:linkId/pause',
  authenticateTokenMiddleware,
  validateRequest(pauseChannelSchema),
  checkFeatureAccess('DELIVERY_CHANNELS'),
  checkPermission('delivery-channels:manage'),
  ctrl.pauseChannel,
)

export default router
