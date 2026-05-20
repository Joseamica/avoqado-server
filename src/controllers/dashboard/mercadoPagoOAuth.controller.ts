/**
 * Mercado Pago OAuth dashboard controller.
 *
 * Three endpoints:
 *   - GET   /dashboard/integrations/mercadopago/oauth/connect     — Authenticated
 *   - GET   /integrations/mercadopago/oauth/callback              — Public (MP redirects browser)
 *   - DELETE /dashboard/venues/:venueId/ecommerce-merchants/:merchantId/mercadopago/oauth — Authenticated
 *
 * Every endpoint that mutates state goes through `getMercadoPagoMerchant`
 * (tenant guard) to prevent cross-venue credential overwrites.
 *
 * Why the callback is GLOBAL (not venue-scoped):
 *   MP doesn't accept dynamic placeholders like `:venueId` in registered
 *   redirect URIs. Instead, venueId + merchantId travel inside the JWT state,
 *   and we extract them server-side. Defense-in-depth: we re-run the tenant
 *   guard against the state's payload before persisting tokens.
 */
import { Request, Response } from 'express'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import * as guardService from '@/services/mercado-pago/merchant-guard.service'
import * as oauthService from '@/services/mercado-pago/oauth.service'
import * as connectionService from '@/services/mercado-pago/connection.service'
import {
  initiateQuerySchema,
  callbackQuerySchema,
  disconnectParamsSchema,
} from '@/schemas/dashboard/mercadoPagoOAuth.schema'
import type { MercadoPagoOAuthState } from '@/services/mercado-pago/types'

/**
 * GET /api/v1/dashboard/integrations/mercadopago/oauth/connect?venueId=...&ecommerceMerchantId=...
 *
 * Authenticated. Redirects the browser to MP's authorization page.
 */
export async function initiate(req: Request, res: Response) {
  const parsed = initiateQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: parsed.error.errors[0].message })
  }

  const { venueId, ecommerceMerchantId } = parsed.data
  const { userId: staffId, venueId: authVenueId } = (req as any).authContext ?? {}
  if (!staffId) {
    return res.status(401).json({ success: false, error: 'No autenticado' })
  }
  // Defense-in-depth: the authenticated user's venue (if scoped) must match
  // the venueId in the query.
  if (authVenueId && authVenueId !== venueId) {
    return res.status(401).json({ success: false, error: 'No tienes acceso a este venue' })
  }

  try {
    await guardService.getMercadoPagoMerchant(venueId, ecommerceMerchantId)
  } catch (err: any) {
    return res.status(err.statusCode || 401).json({ success: false, error: err.message })
  }

  const state = oauthService.signState({
    intent: 'connect_merchant',
    ecommerceMerchantId,
    venueId,
    staffId,
  })
  logger.info('[MP OAuth] initiate', { venueId, ecommerceMerchantId, staffId })
  return res.redirect(oauthService.buildAuthUrl(state))
}

/**
 * GET /api/v1/integrations/mercadopago/oauth/callback?code=...&state=...
 *
 * PUBLIC endpoint — MP redirects the browser here after the seller authorizes.
 * The browser carries the staff's dashboard session cookie if they came from
 * the dashboard (which they did — the initiate endpoint required auth).
 *
 * We don't authenticate this directly because MP doesn't pass cookies on the
 * redirect (it's a 302 to a third-party URL → browser navigates). State JWT
 * + tenant guard provide the security.
 */
export async function callback(req: Request, res: Response) {
  const parsed = callbackQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).send('Parámetros OAuth inválidos')
  }

  const dashboardUrl =
    process.env.PUBLIC_DASHBOARD_URL || process.env.DASHBOARD_URL || process.env.FRONTEND_URL || 'http://localhost:5173'

  // 1. Did MP itself return an error? (User clicked "Cancelar", or scope rejected, etc.)
  if (parsed.data.error) {
    logger.warn('[MP OAuth] callback returned error', {
      err: parsed.data.error,
      description: parsed.data.error_description,
    })
    const params = new URLSearchParams({
      mp_status: 'error',
      reason: parsed.data.error,
      ...(parsed.data.error_description ? { description: parsed.data.error_description } : {}),
    })
    return res.redirect(`${dashboardUrl}/integrations/mercadopago?${params.toString()}`)
  }
  if (!parsed.data.code) {
    return res.redirect(`${dashboardUrl}/integrations/mercadopago?mp_status=error&reason=missing_code`)
  }

  // 2. Verify state JWT (signed by us at initiate time, 10-min TTL).
  let statePayload: MercadoPagoOAuthState
  try {
    statePayload = oauthService.verifyState(parsed.data.state)
  } catch (err) {
    logger.warn('[MP OAuth] state verification failed', { err: String(err) })
    return res.redirect(`${dashboardUrl}/integrations/mercadopago?mp_status=error&reason=invalid_state`)
  }

  // Once we have a venueId from state, every subsequent redirect should land
  // on the merchant page so the user sees the banner. Look up the slug once.
  const venue = await prisma.venue.findUnique({
    where: { id: statePayload.venueId },
    select: { slug: true },
  })
  const merchantPath = venue?.slug
    ? `/venues/${venue.slug}/ecommerce-merchants`
    : '/integrations/mercadopago'

  // 3. Tenant re-check: the venue + merchant in the state must still be a
  //    valid MERCADO_PAGO merchant (defense-in-depth — someone could have
  //    tampered with their dashboard session in between).
  try {
    await guardService.getMercadoPagoMerchant(statePayload.venueId, statePayload.ecommerceMerchantId)
  } catch (err: any) {
    logger.warn('[MP OAuth] tenant guard rejected callback', {
      err: err.message,
      venueId: statePayload.venueId,
      merchantId: statePayload.ecommerceMerchantId,
    })
    return res.redirect(`${dashboardUrl}${merchantPath}?mp_status=error&reason=tenant_check_failed`)
  }

  // 4. Exchange code → tokens, persist (encrypted).
  try {
    const tokens = await oauthService.exchangeCodeForTokens(parsed.data.code)
    await connectionService.persistTokens(statePayload.ecommerceMerchantId, tokens)

    logger.info('[MP OAuth] connected', {
      venueId: statePayload.venueId,
      ecommerceMerchantId: statePayload.ecommerceMerchantId,
      mpUserId: tokens.user_id,
    })

    const params = new URLSearchParams({
      mp_status: 'connected',
      ecommerceMerchantId: statePayload.ecommerceMerchantId,
    })
    return res.redirect(`${dashboardUrl}${merchantPath}?${params.toString()}`)
  } catch (err: any) {
    logger.error('[MP OAuth] token exchange failed', {
      err: err.message,
      venueId: statePayload.venueId,
      ecommerceMerchantId: statePayload.ecommerceMerchantId,
    })
    const params = new URLSearchParams({
      mp_status: 'error',
      reason: 'token_exchange_failed',
      ecommerceMerchantId: statePayload.ecommerceMerchantId,
      ...(err.message ? { description: err.message } : {}),
    })
    return res.redirect(`${dashboardUrl}${merchantPath}?${params.toString()}`)
  }
}

/**
 * DELETE /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:merchantId/mercadopago/oauth
 *
 * Authenticated. Removes the MP credentials from the merchant. Does NOT revoke
 * the token on MP's side — the seller can do that from their own MP account.
 * If revocation matters, we can add a call to MP's /users/{user_id}/applications/{app_id}
 * DELETE endpoint in a follow-up.
 */
export async function disconnect(req: Request, res: Response) {
  const parsed = disconnectParamsSchema.safeParse(req.params)
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: parsed.error.errors[0].message })
  }

  const { venueId, merchantId } = parsed.data
  try {
    await guardService.getMercadoPagoMerchant(venueId, merchantId)
  } catch (err: any) {
    return res.status(err.statusCode || 401).json({ success: false, error: err.message })
  }

  await connectionService.clearCredentials(merchantId)
  logger.info('[MP OAuth] disconnected', { venueId, merchantId })
  return res.json({ success: true })
}
