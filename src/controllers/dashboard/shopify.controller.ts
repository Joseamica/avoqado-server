/**
 * Conector Shopify — controller del dashboard. Delgado: toma lo validado por el esquema, llama al servicio y responde
 * `{ success: true, data }`. Los errores de los servicios (mensaje en español + código; 409 y 422) llegan tal cual al
 * manejador global (express-async-errors). Nunca devuelve ni registra el token de la tienda.
 *
 * L11: el negocio SIEMPRE sale de `req.params.venueId` (lo que `checkPermission` y `checkFeatureAccess` autorizaron), jamás
 * del body; quien actúa es `authContext.userId`.
 */
import { Request, Response } from 'express'
import * as connect from '@/services/commerce-channels/shopify/shopify.connect.service'
import * as overview from '@/services/commerce-channels/shopify/shopify.overview.service'
import * as reconcile from '@/services/commerce-channels/shopify/shopify.reconcile.service'
import * as panel from '@/services/commerce-channels/shopify/shopify.dashboard.service'

const userOf = (req: Request): string => (req as any).authContext.userId
const ok = (res: Response, data: unknown) => res.json({ success: true, data })
type Pagina = { offset: number; limit: number; q?: string }

export async function getOverview(req: Request, res: Response) {
  ok(res, await overview.getShopifyOverview(req.params.venueId))
}

export async function startConnect(req: Request, res: Response) {
  const venueId = req.params.venueId
  ok(res, await connect.startShopifyConnect({ venueId, authUserId: userOf(req), shopDomain: req.body.shopDomain, purpose: 'CONNECT' }))
}

export async function startReauthorize(req: Request, res: Response) {
  const venueId = req.params.venueId
  const shopDomain = await panel.reauthorizeShopDomain(venueId)
  ok(res, await connect.startShopifyConnect({ venueId, authUserId: userOf(req), shopDomain, purpose: 'REAUTHORIZE' }))
}

export async function listLocations(req: Request, res: Response) {
  ok(res, await connect.listIntentLocations({ venueId: req.params.venueId, authUserId: userOf(req), intent: String(req.query.intent) }))
}

export async function confirmConnect(req: Request, res: Response) {
  const { intent, locationId } = req.body
  ok(res, await connect.confirmShopifyConnect({ venueId: req.params.venueId, authUserId: userOf(req), intent, locationId }))
}

export async function getConnectReview(req: Request, res: Response) {
  const q = req.query as unknown as Pagina & { filtro: connect.FiltroVistaPrevia }
  ok(res, await connect.getConnectReview({ venueId: req.params.venueId, offset: q.offset, limit: q.limit, filtro: q.filtro }))
}

export async function applyConnect(req: Request, res: Response) {
  await connect.requestApplyShopifyConnect({ venueId: req.params.venueId, staffId: userOf(req) })
  ok(res, { solicitado: true })
}

export async function disconnect(req: Request, res: Response) {
  // L17: el resultado real de B (`false` = no había nada que desconectar), no un `true` fijo.
  const r = await connect.disconnectShopify({ venueId: req.params.venueId, staffId: userOf(req) })
  ok(res, { desconectado: r.desconectada })
}

export async function resync(req: Request, res: Response) {
  ok(res, await panel.requestShopifyResync({ venueId: req.params.venueId, staffId: userOf(req) }))
}

export async function listReviews(req: Request, res: Response) {
  const q = req.query as unknown as Pagina
  ok(res, await overview.listShopifyReviews(req.params.venueId, { offset: q.offset, limit: q.limit, q: q.q }))
}

export async function listReviewEnvios(req: Request, res: Response) {
  ok(res, await overview.getShopifyReviewEnvios(req.params.venueId, (req.query as unknown as { ids: string[] }).ids))
}

export async function resolveReview(req: Request, res: Response) {
  const { choice, expectedAvoqadoQty, expectedShopifyQty } = req.body
  ok(
    res,
    await reconcile.resolveShopifyReview({
      venueId: req.params.venueId,
      reviewId: req.params.reviewId,
      choice,
      expectedAvoqadoQty,
      expectedShopifyQty,
      staffId: userOf(req),
    }),
  )
}

export async function listIssues(req: Request, res: Response) {
  const q = req.query as unknown as Pagina & { reason?: string }
  ok(res, await overview.listShopifyIssues(req.params.venueId, { offset: q.offset, limit: q.limit, q: q.q, reason: q.reason }))
}
