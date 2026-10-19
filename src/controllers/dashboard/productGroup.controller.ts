/**
 * Productos con variantes (spec 2026-10-14) — controlador delgado del dashboard.
 * El servicio valida reglas de negocio y escribe el ActivityLog (`afterGroupWrite`); aquí sólo se arma la llamada.
 */
import { NextFunction, Request, Response } from 'express'
import * as groups from '../../services/product-variants/productGroup.service'
import * as existing from '../../services/product-variants/groupExisting.service'
import * as shopify from '../../services/product-variants/shopifyFamilies.service'
import * as options from '../../services/mobile/product-option.mobile.service'
import { resolveLegacyCatalogActor } from '../../services/master-catalog/catalogGovernance.service'

const auth = (req: Request) => (req as any).authContext as { userId: string; isImpersonating?: boolean }
const actorOf = (req: Request) => resolveLegacyCatalogActor(auth(req).userId, Boolean(auth(req).isImpersonating))
const h =
  (fn: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(status).json({ success: true, data: await fn(req) })
    } catch (error) {
      next(error)
    }
  }

export const listGroups = h(req => groups.listProductGroups(req.params.venueId, req.query as any))
export const getGroup = h(req => groups.getProductGroup(req.params.venueId, req.params.groupId))
export const listArchived = h(req => groups.listArchivedVariants(req.params.venueId, req.params.groupId, req.query as any))
export const createGroup = h(req => groups.createProductWithVariants(req.params.venueId, req.body, actorOf(req)), 201)
export const updateGroup = h(req => groups.updateProductGroup(req.params.venueId, req.params.groupId, req.body, actorOf(req)))
export const addVariants = h(req => groups.addVariants(req.params.venueId, req.params.groupId, req.body, actorOf(req)), 201)
// archiveProductGroup recibe el staff (no el actor): un token maestro (SERVICE) no tiene fila Staff.
export const archiveGroup = h(req => {
  const actor = actorOf(req)
  return groups.archiveProductGroup(req.params.venueId, req.params.groupId, actor.type === 'HUMAN' ? actor.staffId : null)
})
export const ungroupGroup = h(req => groups.ungroupProductGroup(req.params.venueId, req.params.groupId, actorOf(req)))
export const detachVariant = h(req => groups.detachVariant(req.params.venueId, req.params.groupId, req.params.productId, actorOf(req)))
export const renameValue = h(req =>
  groups.renameOptionValue(req.params.venueId, req.params.groupId, req.params.optionValueId, req.body.value, actorOf(req)),
)
export const setVariantImage = h(req =>
  groups.setVariantImage(req.params.venueId, req.params.groupId, req.params.productId, req.body.imageUrl, actorOf(req)),
)
export const suggestions = h(req => existing.suggestGroups(req.params.venueId, req.query as any))
export const previewGroupExisting = h(req => existing.previewGroupExisting(req.params.venueId, req.body))
export const applyGroupExisting = h(req => existing.applyGroupExisting(req.params.venueId, req.body, actorOf(req)), 201)
export const shopifyFileProposals = h(req => existing.proposalsFromShopifyCsv(req.params.venueId, req.body.csv))
// «Desde Shopify» (bloque 5): el servicio arma nombre, opciones y miembros; del cuerpo sólo toma lo de Avoqado.
export const shopifyProposals = h(req => shopify.listShopifyFamilyProposals(req.params.venueId, req.query as any))
export const previewShopifyProposal = h(req => shopify.previewShopifyProposal(req.params.venueId, req.params.shopifyProductId, req.body))
export const applyShopifyProposal = h(
  req => shopify.applyShopifyProposal(req.params.venueId, actorOf(req), req.params.shopifyProductId, req.body),
  201,
)
export const previewAllShopifyProposals = h(req => shopify.previewAllShopifyProposals(req.params.venueId, { cursor: req.body.cursor }))
export const applyShopifyProposalsBatch = h(req => shopify.applyShopifyProposalsBatch(req.params.venueId, actorOf(req), req.body.items))

// Biblioteca de opciones: reusa el servicio del POS (la bitácora dice DASHBOARD); la lista del dashboard pagina por su cuenta.
export const listOptions = h(req => groups.listProductOptionsPage(req.params.venueId, req.query as any))
export const createOption = h(
  req =>
    options.createProductOption({
      venueId: req.params.venueId,
      staffId: auth(req).userId,
      name: req.body.name,
      values: req.body.values,
      source: 'DASHBOARD',
    }),
  201,
)
export const updateOption = h(req =>
  options.updateProductOption({
    venueId: req.params.venueId,
    staffId: auth(req).userId,
    optionId: req.params.optionId,
    name: req.body.name,
    values: req.body.values,
    source: 'DASHBOARD',
  }),
)
export const deleteOption = h(req => options.deleteProductOption(req.params.optionId, req.params.venueId, auth(req).userId, 'DASHBOARD'))
