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

/**
 * Task 7 (plan 2026-08-20-delivery-nucleo-unico, §8.1): delivery directo es PREMIUM
 * (decisión founder 2026-08-20). El candado en sí es 100% de `checkFeatureAccess`
 * ('DELIVERY_CHANNELS' ya vive en PREMIUM_ONLY_CODES — basePlan.service.ts — así que
 * usa el resolver de FEATURE/`venueHasFeatureAccess`, JAMÁS `moduleService.isModuleEnabled`;
 * cruzarlos "pasa" en silencio para casi todos los venues de prod, que están
 * grandfathered — ver `.claude/rules/feature-gating.md`). Esta envoltura NO reimplementa
 * ese candado: sólo reescribe el CUERPO del 403 cuando niega, porque el que produce hoy
 * `checkFeatureAccess` es inglés genérico ("Please subscribe to enable this feature"),
 * sin decir QUÉ plan hace falta ni CÓMO activarlo, y sin un `code` máquina-legible — y
 * seis clientes distintos (dashboard, superadmin, TPV, Android, iOS, desktop) consumen
 * esta API, así que un 403 pelón obliga a cada uno a inventarse el texto.
 */
const ACTIVAR_EN_DASHBOARD = 'Pídele al dueño del negocio que lo active desde el dashboard (Configuración → Plan).'

interface FeatureAccessDeniedBody {
  featureCode?: string
  trialExpired?: boolean
  suspended?: boolean
}

function withDeliveryPremiumMessage(_req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res)
  res.json = (body: unknown) => {
    const b = body as FeatureAccessDeniedBody
    if (res.statusCode === 403 && b?.featureCode === 'DELIVERY_CHANNELS') {
      if (b.trialExpired) {
        return originalJson({
          error: 'TRIAL_EXPIRED',
          code: 'TRIAL_EXPIRED',
          message: `La prueba gratuita del envío a domicilio (Uber Eats, Rappi, DiDi Food) ya terminó. ${ACTIVAR_EN_DASHBOARD}`,
          featureCode: 'DELIVERY_CHANNELS',
          requiredPlan: 'PREMIUM',
        })
      }
      if (b.suspended) {
        return originalJson({
          error: 'SUBSCRIPTION_SUSPENDED',
          code: 'SUBSCRIPTION_SUSPENDED',
          message: `El envío a domicilio está suspendido por un pago fallido del plan PREMIUM. Actualiza el método de pago en el dashboard (Configuración → Plan) para reactivarlo.`,
          featureCode: 'DELIVERY_CHANNELS',
          requiredPlan: 'PREMIUM',
        })
      }
      return originalJson({
        error: 'PLAN_REQUIRED',
        code: 'PLAN_REQUIRED',
        message: `El envío a domicilio con Uber Eats, Rappi o DiDi Food requiere el plan PREMIUM. ${ACTIVAR_EN_DASHBOARD}`,
        featureCode: 'DELIVERY_CHANNELS',
        requiredPlan: 'PREMIUM',
      })
    }
    return originalJson(body)
  }
  next()
}

// Orden: auth → (validateRequest) → PERMISO/membresía → feature. Ver el bloque §10.4
// arriba: permiso antes que feature evita la fuga de estado de plan a no-miembros.
router.get(
  '/venues/:venueId/channels',
  authenticateTokenMiddleware,
  checkPermission('delivery-channels:read'),
  withDeliveryPremiumMessage,
  checkFeatureAccess('DELIVERY_CHANNELS'),
  ctrl.listChannels,
)

router.post(
  '/venues/:venueId/channels',
  authenticateTokenMiddleware,
  validateRequest(createChannelSchema),
  checkPermission('delivery-channels:connect'),
  withDeliveryPremiumMessage,
  checkFeatureAccess('DELIVERY_CHANNELS'),
  ctrl.createChannel,
)

router.patch(
  '/venues/:venueId/channels/:linkId',
  authenticateTokenMiddleware,
  validateRequest(updateChannelSchema),
  checkChannelUpdatePermission,
  withDeliveryPremiumMessage,
  checkFeatureAccess('DELIVERY_CHANNELS'),
  ctrl.updateChannel,
)

router.post(
  '/venues/:venueId/channels/:linkId/pause',
  authenticateTokenMiddleware,
  validateRequest(pauseChannelSchema),
  checkPermission('delivery-channels:manage'),
  withDeliveryPremiumMessage,
  checkFeatureAccess('DELIVERY_CHANNELS'),
  ctrl.pauseChannel,
)

/**
 * El enlace que un COMERCIO abre para conectar su cuenta de Uber Eats con Avoqado.
 *
 * 🔴 Es el paso que convierte esto en algo que un cliente puede hacer solo. Antes el alta se
 * remataba a mano contra la base: hacía falta el id de tienda de Uber para crear el canal, y
 * ese id sólo aparece DESPUÉS de que el comercio autoriza — un huevo-y-gallina.
 *
 * 🔴 Por qué el venue se sella aquí y no viaja en el query del OAuth: esta ruta está
 * AUTENTICADA, así que sabemos quién pide y para qué negocio. El id entra al `state` firmado
 * con HMAC, y el callback —que es público, porque lo llama Uber— sólo confía en lo que venga
 * ahí dentro. Si aceptara un `venueId` suelto del query, cualquiera podría enlazar las
 * tiendas de un comercio al negocio que quisiera.
 */
router.get(
  '/venues/:venueId/channels/uber/connect-url',
  authenticateTokenMiddleware,
  checkPermission('delivery-channels:manage'),
  deliveryChannelsController.getUberConnectUrl,
)

router.post(
  '/venues/:venueId/activation-request',
  authenticateTokenMiddleware,
  validateRequest(createActivationRequestSchema),
  checkPermission('delivery-channels:request'),
  withDeliveryPremiumMessage,
  checkFeatureAccess('DELIVERY_CHANNELS'),
  ctrl.requestActivation,
)

router.get(
  '/venues/:venueId/activation-request',
  authenticateTokenMiddleware,
  checkPermission('delivery-channels:read'),
  withDeliveryPremiumMessage,
  checkFeatureAccess('DELIVERY_CHANNELS'),
  ctrl.getActivation,
)

router.get(
  '/venues/:venueId/delivery/summary',
  authenticateTokenMiddleware,
  checkPermission('delivery-channels:read'),
  withDeliveryPremiumMessage,
  checkFeatureAccess('DELIVERY_CHANNELS'),
  ctrl.getSummary,
)

export default router
