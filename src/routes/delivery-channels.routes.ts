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
 *
 * Fix A1 (auditoría, spec §10.4 — confused-deputy): crear un canal, o cambiar
 * `externalLocationId`/`externalAccountId` de uno existente, bindea un recurso EXTERNO de
 * Deliverect a este venue — luego ese recurso se dispara (pause/menu-sync) con las credenciales
 * OAuth PLATFORM-WIDE de Deliverect. El scoping por `venueId` solo prueba dueño del link LOCAL
 * de Avoqado, no del recurso externo, así que un manager de un tenant podía bindear un
 * `externalLocationId` arbitrario. Decisión de producto (spec §2): "ops/superadmin conecta el
 * canal; el dueño solo solicita y opera". Por eso create + el update que toca esos dos campos
 * exigen `delivery-channels:connect` — un permiso que NINGÚN rol no-SUPERADMIN tiene en
 * DEFAULT_PERMISSIONS (solo pasa vía el atajo `*:*` de SUPERADMIN en checkPermission; ver
 * SUPERADMIN_ONLY_ALLOWLIST en scripts/audit-permissions.ts, y el comentario "NO: delivery-
 * channels:connect" en los bloques OWNER/ADMIN de src/lib/permissions.ts). `pause` y el toggle
 * `orderAcceptanceMode` (controles operativos sobre un canal YA conectado) se quedan en
 * OWNER/ADMIN vía `delivery-channels:manage` — mismo patrón "endpoints con sub-acciones" que
 * documenta permissions-policy.md (el permiso depende del contenido del body, no un único
 * checkPermission genérico para toda la ruta).
 */
import { NextFunction, Request, Response, Router } from 'express'
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

/** Campos que identifican el recurso EXTERNO de Deliverect — ver Fix A1 arriba. */
const CHANNEL_IDENTITY_FIELDS = ['externalLocationId', 'externalAccountId'] as const

/**
 * PATCH .../channels/:linkId puede tocar tanto la identidad del recurso externo
 * (externalLocationId/externalAccountId — SUPERADMIN-only) como campos operativos
 * (orderAcceptanceMode/autoSyncMenu/config — OWNER/ADMIN). El permiso exigido depende del
 * BODY, así que no se gatea con un único `checkPermission` genérico (permissions-policy.md,
 * "Endpoints con sub-acciones").
 */
function checkChannelUpdatePermission(req: Request, res: Response, next: NextFunction) {
  const body = (req.body ?? {}) as Record<string, unknown>
  const touchesIdentityField = CHANNEL_IDENTITY_FIELDS.some(field => field in body)
  if (touchesIdentityField) {
    return checkPermission('delivery-channels:connect')(req, res, next)
  }
  return checkPermission('delivery-channels:manage')(req, res, next)
}

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
  checkPermission('delivery-channels:connect'),
  ctrl.createChannel,
)

router.patch(
  '/venues/:venueId/channels/:linkId',
  authenticateTokenMiddleware,
  validateRequest(updateChannelSchema),
  checkFeatureAccess('DELIVERY_CHANNELS'),
  checkChannelUpdatePermission,
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
