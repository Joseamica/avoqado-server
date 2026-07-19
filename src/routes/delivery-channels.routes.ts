/**
 * Gestión de canales de delivery (DeliveryChannelLink CRUD + pause, Task 10) + solicitud de
 * activación del dueño (DeliveryActivationRequest, Task 3) + resumen diario por canal
 * (GET .../delivery/summary, Task 5) del plan delivery-activation-backend.
 *
 * `delivery-channels:read` / `delivery-channels:manage` / `delivery-channels:request` (permisos)
 * y `DELIVERY_CHANNELS` (Feature code, PREMIUM) ya están registrados — permissions.ts /
 * basePlan.service.ts (commit 8374c949 + Task 3 de este plan).
 *
 * Middleware order: validar el body ANTES de feature/permiso (precedente real del
 * repo: MERCHANT_ROUTING_RULES, dashboard.routes.ts ~3247, "validate body BEFORE
 * feature/perm checks" — permissions-policy.md).
 *
 * Fix §10.4 (auditoría — fuga de estado de plan): permiso/membresía ANTES que feature.
 * A DIFERENCIA de la convención feature-primero del resto del repo, aquí `checkPermission`
 * corre antes que `checkFeatureAccess`: si corriera primero el feature, un autenticado que
 * NO es miembro del `:venueId` podría sondear el plan/trial/suspensión de un venue ajeno por
 * los 403 distintos (fuga de información) antes de que el permiso lo niegue. Con permiso
 * primero, un no-miembro recibe 403 sin revelar el estado del plan; un miembro legítimo sin
 * PREMIUM sigue viendo el 403 de feature (upsell) igual que antes. NO reordenar "para que
 * coincida con las otras rutas" — es intencional. (El fix del patrón en TODA la plataforma es
 * una decisión transversal aparte; esto solo endurece delivery.)
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

// Orden: auth → (validateRequest) → PERMISO/membresía → feature. Ver el bloque §10.4
// arriba: permiso antes que feature evita la fuga de estado de plan a no-miembros.
router.get(
  '/venues/:venueId/channels',
  authenticateTokenMiddleware,
  checkPermission('delivery-channels:read'),
  checkFeatureAccess('DELIVERY_CHANNELS'),
  ctrl.listChannels,
)

router.post(
  '/venues/:venueId/channels',
  authenticateTokenMiddleware,
  validateRequest(createChannelSchema),
  checkPermission('delivery-channels:connect'),
  checkFeatureAccess('DELIVERY_CHANNELS'),
  ctrl.createChannel,
)

router.patch(
  '/venues/:venueId/channels/:linkId',
  authenticateTokenMiddleware,
  validateRequest(updateChannelSchema),
  checkChannelUpdatePermission,
  checkFeatureAccess('DELIVERY_CHANNELS'),
  ctrl.updateChannel,
)

router.post(
  '/venues/:venueId/channels/:linkId/pause',
  authenticateTokenMiddleware,
  validateRequest(pauseChannelSchema),
  checkPermission('delivery-channels:manage'),
  checkFeatureAccess('DELIVERY_CHANNELS'),
  ctrl.pauseChannel,
)

router.post(
  '/venues/:venueId/activation-request',
  authenticateTokenMiddleware,
  validateRequest(createActivationRequestSchema),
  checkPermission('delivery-channels:request'),
  checkFeatureAccess('DELIVERY_CHANNELS'),
  ctrl.requestActivation,
)

router.get(
  '/venues/:venueId/activation-request',
  authenticateTokenMiddleware,
  checkPermission('delivery-channels:read'),
  checkFeatureAccess('DELIVERY_CHANNELS'),
  ctrl.getActivation,
)

router.get(
  '/venues/:venueId/delivery/summary',
  authenticateTokenMiddleware,
  checkPermission('delivery-channels:read'),
  checkFeatureAccess('DELIVERY_CHANNELS'),
  ctrl.getSummary,
)

export default router
