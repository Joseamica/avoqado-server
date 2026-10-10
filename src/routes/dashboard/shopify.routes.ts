/**
 * Conector Shopify — API del dashboard. Montado en /api/v1/dashboard/venues/:venueId/shopify (dashboard.routes.ts).
 *
 * Orden: auth (en el montaje) → validateRequest → checkPermission → checkFeatureAccess. Permiso ANTES que el plan, igual
 * que pases y delivery: un no miembro no sondea el plan por los 403. Sin plan (apagado se ve, spec §4 ⑧): el resumen, las
 * dos listas, la vista previa de conexión y desconectar. El literal de `checkFeatureAccess` lo lee
 * `basePlan.gatedCodes.test.ts`: no lo cambies por una constante.
 */
import { Router } from 'express'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { checkFeatureAccess } from '@/middlewares/checkFeatureAccess.middleware'
import { validateRequest } from '@/middlewares/validation'
import * as ctrl from '@/controllers/dashboard/shopify.controller'
import * as s from '@/schemas/dashboard/shopify.schema'

const router = Router({ mergeParams: true })
const gate = (perm: string) => [checkPermission(perm), checkFeatureAccess('SHOPIFY_INTEGRATION')]
const READ = 'inventory:read'
const MANAGE = 'settings:manage'
const ADJUST = 'inventory:adjust'

router.get('/', validateRequest(s.soloVenueSchema), checkPermission(READ), ctrl.getOverview)
router.post('/connect/start', validateRequest(s.startSchema), ...gate(MANAGE), ctrl.startConnect)
router.post('/reauthorize/start', validateRequest(s.soloVenueSchema), ...gate(MANAGE), ctrl.startReauthorize)
router.get('/connect/locations', validateRequest(s.locationsSchema), ...gate(MANAGE), ctrl.listLocations)
router.post('/connect/confirm', validateRequest(s.confirmSchema), ...gate(MANAGE), ctrl.confirmConnect)
// Sin plan: la vista previa sólo LEE lo que ya se importó; aplicar sí lo pide.
router.get('/connect/review', validateRequest(s.connectReviewSchema), checkPermission(MANAGE), ctrl.getConnectReview)
router.post('/connect/apply', validateRequest(s.soloVenueSchema), ...gate(MANAGE), ctrl.applyConnect)
// Sin plan, a propósito: quien lo perdió siempre puede salir.
router.post('/disconnect', validateRequest(s.soloVenueSchema), checkPermission(MANAGE), ctrl.disconnect)
router.post('/resync', validateRequest(s.soloVenueSchema), ...gate(MANAGE), ctrl.resync)
router.get('/reviews', validateRequest(s.reviewsSchema), checkPermission(READ), ctrl.listReviews)
router.get('/reviews/envios', validateRequest(s.reviewEnviosSchema), checkPermission(READ), ctrl.listReviewEnvios)
router.post('/reviews/:reviewId/resolve', validateRequest(s.resolveSchema), ...gate(ADJUST), ctrl.resolveReview)
router.get('/issues', validateRequest(s.issuesSchema), checkPermission(READ), ctrl.listIssues)

export default router
