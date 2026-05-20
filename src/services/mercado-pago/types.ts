/**
 * Mercado Pago integration types.
 *
 * Tokens at rest are AES-256-GCM encrypted (via `createTokenCipher('MERCADO_PAGO_TOKEN_KEY')`)
 * and base64-encoded inside the EcommerceMerchant.providerCredentials JSON column.
 *
 * Schema version is bumped when the envelope shape changes; key version is
 * bumped when the encryption key rotates. Both default to 1.
 */

/** Stored shape inside EcommerceMerchant.providerCredentials for MP merchants. */
export interface MercadoPagoCredentials {
  /** Envelope shape version. Bump when shape changes. */
  schemaVersion: 1
  /** AES-GCM key version (for future rotation). v1 always = 1. */
  keyVersion: 1
  /** MP user_id of the seller — also mirrored to EcommerceMerchant.providerMerchantId. */
  mpUserId: string
  /** base64-encoded encrypted access_token (180-day TTL). */
  accessTokenCiphertext: string
  /** base64-encoded encrypted refresh_token. */
  refreshTokenCiphertext: string
  /** ISO timestamp when the access_token expires. */
  expiresAt: string
  /** OAuth scope string returned by MP (typically "offline_access read write"). */
  scope: string
  /** true once a real payment has flowed; helps distinguish 'authorized but unused' connections. */
  liveMode: boolean
  /** ISO timestamp of the last successful refresh (cron or on-demand). */
  lastRefreshedAt?: string
  /**
   * Seller's MP public_key returned in the OAuth token response.
   * The frontend Brick (`@mercadopago/sdk-react`) uses this to initialize MP.js
   * when rendering the inline payment form on `pay.avoqado.io`.
   */
  publicKey: string
}

/** OAuth state JWT payload — signed with OAUTH_STATE_SECRET, 10-min TTL. */
export interface MercadoPagoOAuthState {
  intent: 'connect_merchant'
  ecommerceMerchantId: string
  venueId: string
  staffId: string
}

/** Response from POST https://api.mercadopago.com/oauth/token */
export interface MercadoPagoTokenResponse {
  access_token: string
  token_type: 'bearer'
  expires_in: number
  scope: string
  user_id: number
  refresh_token: string
  public_key: string
  live_mode: boolean
}

/** MP webhook envelope received at /api/v1/webhooks/mercadopago */
export interface MercadoPagoWebhookPayload {
  id: number | string
  live_mode: boolean
  type: string
  date_created: string
  user_id: number | string
  api_version: string
  action: string
  data: { id: string }
}

/** Subset of MP payment object returned by GET /v1/payments/:id */
export interface MercadoPagoPayment {
  id: number
  status: 'pending' | 'approved' | 'authorized' | 'in_process' | 'in_mediation' | 'rejected' | 'cancelled' | 'refunded' | 'charged_back'
  status_detail: string
  external_reference: string | null
  transaction_amount: number
  currency_id: string
  date_approved: string | null
  date_created: string
  fee_details: Array<{ type: string; amount: number; fee_payer: string }>
  application_fee?: number
  marketplace_fee?: number
  order?: { id: number | null } | null
}
