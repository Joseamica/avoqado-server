/**
 * Mercado Pago connection service — manages the seller's OAuth credentials at rest.
 *
 * Storage: `EcommerceMerchant.providerCredentials` (JSON). Tokens are AES-256-GCM
 * encrypted via the generalized `createTokenCipher('MERCADO_PAGO_TOKEN_KEY')` helper
 * and stored as base64. The envelope shape lives in `./types.ts`.
 *
 * Persistence semantics:
 *   - persistTokens: MERGE pattern (mirrors Stripe Connect at
 *     stripe-connect.provider.ts:481). Preserves unrelated keys; updates MP-owned keys.
 *   - clearCredentials: removes ONLY MP-owned keys, preserves the rest.
 *
 * Both also mirror `providerMerchantId` (top-level column) with the MP user_id
 * so we can lookup-by-mpUserId for webhook routing.
 */
import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { createTokenCipher } from '@/lib/token-encryption'
import { refreshAccessToken } from './oauth.service'
import type { MercadoPagoCredentials, MercadoPagoTokenResponse } from './types'

const cipher = createTokenCipher('MERCADO_PAGO_TOKEN_KEY')

export interface DecryptedCredentials {
  mpUserId: string
  accessToken: string
  refreshToken: string
  expiresAt: Date
  scope: string
  liveMode: boolean
  lastRefreshedAt?: Date
  publicKey: string
}

/** Keys this service owns inside providerCredentials JSON — used by clearCredentials. */
const MP_KEYS = [
  'schemaVersion',
  'keyVersion',
  'mpUserId',
  'accessTokenCiphertext',
  'refreshTokenCiphertext',
  'expiresAt',
  'scope',
  'liveMode',
  'lastRefreshedAt',
  'publicKey',
] as const

function readJsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/**
 * Persist a fresh OAuth token response into `EcommerceMerchant.providerCredentials`.
 * Merges with existing keys (does NOT overwrite the whole JSON).
 */
export async function persistTokens(
  ecommerceMerchantId: string,
  tokens: MercadoPagoTokenResponse,
): Promise<void> {
  const existing = await prisma.ecommerceMerchant.findUnique({
    where: { id: ecommerceMerchantId },
    select: { providerCredentials: true },
  })
  const prior = readJsonObject(existing?.providerCredentials)

  const mpUserId = String(tokens.user_id)

  const mpFields: MercadoPagoCredentials = {
    schemaVersion: 1,
    keyVersion: 1,
    mpUserId,
    accessTokenCiphertext: cipher.encryptToBase64(tokens.access_token),
    refreshTokenCiphertext: cipher.encryptToBase64(tokens.refresh_token),
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    scope: tokens.scope,
    liveMode: tokens.live_mode,
    lastRefreshedAt: new Date().toISOString(),
    publicKey: tokens.public_key,
  }

  const merged = { ...prior, ...mpFields } as Prisma.InputJsonValue

  await prisma.ecommerceMerchant.update({
    where: { id: ecommerceMerchantId },
    data: {
      providerCredentials: merged,
      providerMerchantId: mpUserId,
    },
  })
}

/**
 * Load and decrypt credentials. Returns null if the merchant has no MP connection.
 */
export async function loadCredentials(
  ecommerceMerchantId: string,
): Promise<DecryptedCredentials | null> {
  const merchant = await prisma.ecommerceMerchant.findUnique({
    where: { id: ecommerceMerchantId },
    select: { providerCredentials: true },
  })
  if (!merchant) return null

  const credentials = merchant.providerCredentials as unknown as MercadoPagoCredentials | null
  if (!credentials?.accessTokenCiphertext || !credentials?.refreshTokenCiphertext) {
    return null
  }

  return {
    mpUserId: credentials.mpUserId,
    accessToken: cipher.decryptFromBase64(credentials.accessTokenCiphertext),
    refreshToken: cipher.decryptFromBase64(credentials.refreshTokenCiphertext),
    expiresAt: new Date(credentials.expiresAt),
    scope: credentials.scope,
    liveMode: credentials.liveMode,
    lastRefreshedAt: credentials.lastRefreshedAt ? new Date(credentials.lastRefreshedAt) : undefined,
    publicKey: credentials.publicKey,
  }
}

export type RefreshResult = 'refreshed' | 'not_needed' | 'no_credentials' | 'merchant_not_found'

/**
 * Refresh the access_token if it expires within `thresholdDays` (default 30).
 *
 * Concurrency: holds a PostgreSQL advisory lock keyed by `hashtextextended(venueId)`
 * inside a single transaction. This serializes refreshes per-venue so the daily
 * cron + an on-demand call don't both refresh and end up with a stale
 * refresh_token persisted (MP rotates refresh tokens on every refresh, and the
 * old one becomes invalid as soon as MP issues a new pair).
 *
 * Lock auto-releases on transaction commit/rollback — no manual unlock needed.
 *
 * Returns:
 *   - "refreshed":         a new token was minted and persisted
 *   - "not_needed":        token still has more than threshold life remaining
 *   - "no_credentials":    merchant has not connected MP yet
 *   - "merchant_not_found": no row with that ecommerceMerchantId exists
 */
export async function refreshIfExpiring(
  ecommerceMerchantId: string,
  thresholdDays = 30,
): Promise<RefreshResult> {
  return prisma.$transaction(async tx => {
    const merchant = await tx.ecommerceMerchant.findUnique({
      where: { id: ecommerceMerchantId },
      select: { id: true, venueId: true, providerCredentials: true },
    })
    if (!merchant) return 'merchant_not_found' as const

    // Acquire per-venue advisory lock. Released on tx commit/rollback.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${merchant.venueId}, 0))`

    const credentials = merchant.providerCredentials as unknown as MercadoPagoCredentials | null
    if (!credentials?.refreshTokenCiphertext) {
      return 'no_credentials' as const
    }

    const expiresAt = new Date(credentials.expiresAt)
    const thresholdMs = thresholdDays * 86400_000
    if (expiresAt.getTime() - Date.now() > thresholdMs) {
      return 'not_needed' as const
    }

    // Decrypt old refresh, exchange with MP, persist the new pair (rotated).
    const refreshToken = cipher.decryptFromBase64(credentials.refreshTokenCiphertext)
    const fresh = await refreshAccessToken(refreshToken)

    const updated: MercadoPagoCredentials = {
      ...credentials,
      schemaVersion: 1,
      keyVersion: 1,
      accessTokenCiphertext: cipher.encryptToBase64(fresh.access_token),
      refreshTokenCiphertext: cipher.encryptToBase64(fresh.refresh_token),
      expiresAt: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
      scope: fresh.scope,
      liveMode: fresh.live_mode,
      lastRefreshedAt: new Date().toISOString(),
      publicKey: fresh.public_key,
    }

    const prior = readJsonObject(merchant.providerCredentials)
    const merged = { ...prior, ...updated } as Prisma.InputJsonValue

    await tx.ecommerceMerchant.update({
      where: { id: ecommerceMerchantId },
      data: {
        providerCredentials: merged,
        providerMerchantId: String(fresh.user_id),
      },
    })

    return 'refreshed' as const
  })
}

/**
 * Remove ONLY MP-owned keys from providerCredentials. Preserves any unrelated
 * keys (e.g. legacy Blumon or Stripe config if they ever co-existed). Also
 * nulls the top-level `providerMerchantId`.
 */
export async function clearCredentials(ecommerceMerchantId: string): Promise<void> {
  const existing = await prisma.ecommerceMerchant.findUnique({
    where: { id: ecommerceMerchantId },
    select: { providerCredentials: true },
  })
  const cleaned = readJsonObject(existing?.providerCredentials)
  for (const key of MP_KEYS) {
    delete cleaned[key]
  }

  await prisma.ecommerceMerchant.update({
    where: { id: ecommerceMerchantId },
    data: {
      providerCredentials: cleaned as Prisma.InputJsonValue,
      providerMerchantId: null,
    },
  })
}
