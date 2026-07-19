/**
 * Gestión de canales de delivery (DeliveryChannelLink CRUD + pause, Task 10) + solicitud de
 * activación del dueño (DeliveryActivationRequest, Task 3) + resumen diario por canal
 * (GET .../delivery/summary, Task 5) del plan delivery-activation-backend.
 *
 * `delivery-channels:read` / `delivery-channels:manage` / `delivery-channels:request` (permisos)
 * y `DELIVERY_CHANNELS` (Feature code, PREMIUM) ya están registrados — permissions.ts /
 * basePlan.service.ts (commit 8374c949 + Task 3 de este plan).
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
import {
  createChannelSchema,
  updateChannelSchema,
  pauseChannelSchema,
  createActivationRequestSchema,
} from '../schemas/delivery-channels.schema'

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

router.post(
  '/venues/:venueId/activation-request',
  authenticateTokenMiddleware,
  validateRequest(createActivationRequestSchema),
  checkFeatureAccess('DELIVERY_CHANNELS'),
  checkPermission('delivery-channels:request'),
  ctrl.requestActivation,
)

router.get(
  '/venues/:venueId/activation-request',
  authenticateTokenMiddleware,
  checkFeatureAccess('DELIVERY_CHANNELS'),
  checkPermission('delivery-channels:read'),
  ctrl.getActivation,
)

router.get(
  '/venues/:venueId/delivery/summary',
  authenticateTokenMiddleware,
  checkFeatureAccess('DELIVERY_CHANNELS'),
  checkPermission('delivery-channels:read'),
  ctrl.getSummary,
)

export default router
