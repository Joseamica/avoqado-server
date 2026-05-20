/**
 * Zod schemas for Mercado Pago OAuth dashboard endpoints.
 *
 * All messages are in Spanish per the project's Zod policy
 * (.claude/rules/critical-warnings.md): the validation middleware shows Zod
 * messages directly to users.
 */
import { z } from 'zod'

/**
 * Query params for GET /dashboard/integrations/mercadopago/oauth/connect.
 * The frontend "Connect MP" button passes venueId + ecommerceMerchantId.
 */
export const initiateQuerySchema = z.object({
  venueId: z.string().min(1, 'El ID del venue es requerido'),
  ecommerceMerchantId: z.string().min(1, 'El ID del merchant es requerido'),
})

/**
 * Query params for the GLOBAL OAuth callback (GET /integrations/mercadopago/oauth/callback).
 * MP redirects the browser here after the seller authorizes. The state JWT
 * carries venueId + ecommerceMerchantId, since MP doesn't accept dynamic path
 * placeholders.
 */
export const callbackQuerySchema = z.object({
  code: z.string().min(1, 'El código de autorización es requerido').optional(),
  state: z.string().min(1, 'El estado OAuth es requerido'),
  error: z.string().optional(),
  error_description: z.string().optional(),
})

/**
 * Path params for DELETE /dashboard/venues/:venueId/ecommerce-merchants/:merchantId/mercadopago/oauth.
 */
export const disconnectParamsSchema = z.object({
  venueId: z.string().min(1, 'El ID del venue es requerido'),
  merchantId: z.string().min(1, 'El ID del merchant es requerido'),
})

export type InitiateQuery = z.infer<typeof initiateQuerySchema>
export type CallbackQuery = z.infer<typeof callbackQuerySchema>
export type DisconnectParams = z.infer<typeof disconnectParamsSchema>
