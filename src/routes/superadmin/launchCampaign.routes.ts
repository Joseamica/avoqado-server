/**
 * Campañas ligeras de lanzamiento — rutas de superadmin (spec 2026-09-17 § 3.4).
 *
 * 🔴 El guardia NO se repite: el router padre ya aplica `authenticateTokenMiddleware` +
 * `authorizeRole([StaffRole.SUPERADMIN])`. No hay permiso nuevo que espejear en el dashboard —
 * el candado es el ROL, y por eso no aparece en `permissions.ts`.
 */
import { Router } from 'express'
import * as controller from '../../controllers/superadmin/launchCampaign.superadmin.controller'

const router = Router({ mergeParams: true })

/**
 * @openapi
 * /api/v1/superadmin/launch-campaigns:
 *   get:
 *     tags: [Superadmin, LaunchCampaigns]
 *     summary: Lista las fichas de campaña, paginadas (tope 100 por página)
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [DRAFT, ACTIVE, PAUSED, ENDED] }
 *       - in: query
 *         name: q
 *         schema: { type: string, maxLength: 60 }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200: { description: Fichas con su disponibilidad y `meta` de paginación }
 *   post:
 *     tags: [Superadmin, LaunchCampaigns]
 *     summary: Crea una ficha en DRAFT (no habla con Stripe)
 *     responses:
 *       201: { description: Ficha creada, siempre en DRAFT }
 *       409: { description: LAUNCH_CAMPAIGN_CODE_TAKEN o LAUNCH_CAMPAIGN_SLUG_TAKEN }
 */
router.get('/', controller.list)
router.post('/', controller.create)

/**
 * @openapi
 * /api/v1/superadmin/launch-campaigns/preview:
 *   post:
 *     tags: [Superadmin, LaunchCampaigns]
 *     summary: Cotiza una oferta contra el precio vivo de Stripe. SOLO LEE; no crea cupones
 *     responses:
 *       200: { description: Montos, id del cupón que se usaría y avisos }
 *       409: { description: PLAN_PRICE_UNAVAILABLE }
 */
router.post('/preview', controller.preview)

/**
 * @openapi
 * /api/v1/superadmin/launch-campaigns/{id}:
 *   get:
 *     tags: [Superadmin, LaunchCampaigns]
 *     summary: Ficha con métricas (incluye cuántos lugares llevan más de 30 min apartados)
 *     responses:
 *       200: { description: Ficha, métricas y disponibilidad }
 *       404: { description: LAUNCH_CAMPAIGN_NOT_FOUND }
 *   put:
 *     tags: [Superadmin, LaunchCampaigns]
 *     summary: Edita una ficha con revisión optimista obligatoria (`expectedUpdatedAt`)
 *     responses:
 *       200: { description: Ficha actualizada }
 *       400: { description: LAUNCH_CAMPAIGN_CAP_BELOW_COUNT }
 *       409: { description: LAUNCH_CAMPAIGN_STALE o LAUNCH_CAMPAIGN_FIELD_LOCKED }
 */
router.get('/:id', controller.detail)
router.put('/:id', controller.update)

/**
 * @openapi
 * /api/v1/superadmin/launch-campaigns/{id}/activate:
 *   post:
 *     tags: [Superadmin, LaunchCampaigns]
 *     summary: Activa la ficha y crea (o reutiliza) su cupón de Stripe. Nunca borra un cupón
 *     responses:
 *       200: { description: Ficha ACTIVE con el snapshot de precio congelado }
 *       409: { description: BAD_STATE · EXPIRED · PLAN_PRICE_UNAVAILABLE · PLAN_PRICE_MISMATCH · COUPON_CONFLICT }
 */
router.post('/:id/activate', controller.activate)

/**
 * @openapi
 * /api/v1/superadmin/launch-campaigns/{id}/pause:
 *   post:
 *     tags: [Superadmin, LaunchCampaigns]
 *     summary: Pausa una ficha ACTIVE (motivo obligatorio)
 *     responses:
 *       200: { description: Ficha PAUSED }
 *       409: { description: LAUNCH_CAMPAIGN_BAD_STATE }
 */
router.post('/:id/pause', controller.pause)

/**
 * @openapi
 * /api/v1/superadmin/launch-campaigns/{id}/end:
 *   post:
 *     tags: [Superadmin, LaunchCampaigns]
 *     summary: Termina una ficha. IRREVERSIBLE — es el camino para cambiar un precio publicado
 *     responses:
 *       200: { description: Ficha ENDED }
 *       409: { description: LAUNCH_CAMPAIGN_BAD_STATE }
 */
router.post('/:id/end', controller.end)

/**
 * @openapi
 * /api/v1/superadmin/launch-campaigns/{id}/redemptions:
 *   get:
 *     tags: [Superadmin, LaunchCampaigns]
 *     summary: Redenciones de la ficha, paginadas en el servidor (tope 100)
 *     responses:
 *       200: { description: Filas con organización, local y atribución; sin correos ni huella de tarjeta }
 *       404: { description: LAUNCH_CAMPAIGN_NOT_FOUND }
 */
router.get('/:id/redemptions', controller.redemptions)

export default router
