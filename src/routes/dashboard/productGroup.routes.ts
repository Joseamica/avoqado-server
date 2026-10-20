/**
 * Productos con variantes (spec 2026-10-14) — sub-router del dashboard.
 * Montado en /dashboard/venues/:venueId/product-groups con authenticateToken en el montaje (dashboard.routes.ts).
 * Leer: menu:read, sin candado (un negocio en Gratis sigue viendo y vendiendo sus familias).
 * Crear o crecer: candado PRODUCT_VARIANTS (Pro y Premium); checkFeatureAccess contesta el 403 del plan.
 * Reducir (archivar, deshacer, separar) no se candadea: bajar de plan nunca deja a nadie sin poder limpiar.
 */
import { Router } from 'express'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { checkFeatureAccess } from '../../middlewares/checkFeatureAccess.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as c from '../../controllers/dashboard/productGroup.controller'
import * as s from '../../schemas/dashboard/productGroup.schema'

const router = Router({ mergeParams: true })
const gate = checkFeatureAccess('PRODUCT_VARIANTS')

// Rutas fijas ANTES de «/:groupId».
router.get('/', checkPermission('menu:read'), validateRequest(s.listGroupsSchema), c.listGroups)
router.get('/suggestions', checkPermission('menu:read'), validateRequest(s.suggestionsSchema), c.suggestions)
router.post('/group-existing/preview', checkPermission('menu:update'), gate, validateRequest(s.groupExistingSchema), c.previewGroupExisting)
router.post('/group-existing', checkPermission('menu:update'), gate, validateRequest(s.applyGroupExistingSchema), c.applyGroupExisting)
router.post('/shopify-file/proposals', checkPermission('menu:update'), gate, validateRequest(s.shopifyFileSchema), c.shopifyFileProposals)
// «Desde Shopify» (bloque 5): agrupar lo ligado a Shopify. El gid viaja codificado (`gid%3A%2F%2Fshopify%2FProduct%2F1`).
router.get('/shopify-proposals', checkPermission('menu:update'), gate, validateRequest(s.shopifyProposalsSchema), c.shopifyProposals)
router.post(
  '/shopify-proposals/preview-all',
  checkPermission('menu:update'),
  gate,
  validateRequest(s.shopifyProposalsPreviewAllSchema),
  c.previewAllShopifyProposals,
)
router.post(
  '/shopify-proposals/apply-batch',
  checkPermission('menu:update'),
  gate,
  validateRequest(s.shopifyProposalsApplyBatchSchema),
  c.applyShopifyProposalsBatch,
)
router.post(
  '/shopify-proposals/:shopifyProductId/preview',
  checkPermission('menu:update'),
  gate,
  validateRequest(s.shopifyProposalPreviewSchema),
  c.previewShopifyProposal,
)
router.post(
  '/shopify-proposals/:shopifyProductId/apply',
  checkPermission('menu:update'),
  gate,
  validateRequest(s.shopifyProposalApplySchema),
  c.applyShopifyProposal,
)
router.post('/', checkPermission('menu:create'), gate, validateRequest(s.createGroupSchema), c.createGroup)
router.get('/:groupId', checkPermission('menu:read'), validateRequest(s.groupParamsSchema), c.getGroup)
router.get('/:groupId/archived', checkPermission('menu:read'), validateRequest(s.archivedSchema), c.listArchived)
router.patch('/:groupId', checkPermission('menu:update'), gate, validateRequest(s.updateGroupSchema), c.updateGroup)
router.post('/:groupId/variants', checkPermission('menu:create'), gate, validateRequest(s.addVariantsSchema), c.addVariants)
router.post('/:groupId/archive', checkPermission('menu:delete'), validateRequest(s.groupParamsSchema), c.archiveGroup)
router.post('/:groupId/ungroup', checkPermission('menu:update'), validateRequest(s.groupParamsSchema), c.ungroupGroup)
router.post('/:groupId/variants/:productId/detach', checkPermission('menu:update'), validateRequest(s.detachSchema), c.detachVariant)
router.patch('/:groupId/values/:optionValueId', checkPermission('menu:update'), gate, validateRequest(s.renameValueSchema), c.renameValue)
router.put(
  '/:groupId/variants/:productId/image',
  checkPermission('menu:update'),
  gate,
  validateRequest(s.variantImageSchema),
  c.setVariantImage,
)

export default router
