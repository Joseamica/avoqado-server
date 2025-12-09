/**
 * SDK Authentication Middleware
 *
 * Authenticates API requests from e-commerce merchants using Avoqado SDK.
 * Uses API key authentication (publicKey or secretKey) similar to Stripe.
 *
 * **Key Types:**
 * - Public Key (pk_live_xxx / pk_test_xxx): Used for client-side operations (create checkout session)
 * - Secret Key (sk_live_xxx / sk_test_xxx): Used for server-side operations (list sessions, cancel, refunds)
 *
 * **Authentication Flow:**
 * 1. Extract API key from Authorization header (Bearer token)
 * 2. Validate key format and extract key type (public/secret) and mode (live/test)
 * 3. Look up EcommerceMerchant by key
 * 4. Verify merchant is active and key matches environment
 * 5. Attach merchant context to req.sdkContext
 *
 * @module middlewares/sdk-auth
 */

import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import { UnauthorizedError, BadRequestError } from '@/errors/AppError'
import crypto from 'crypto'
import logger from '@/config/logger'
import { OPERATIONAL_VENUE_STATUSES } from '@/lib/venueStatus.constants'

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface SDKContext {
  merchantId: string
  merchantName: string
  venueId: string // Added for venue tracking
  keyType: 'public' | 'secret'
  sandboxMode: boolean
  providerId: string
  providerCode: string
  active: boolean
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parses API key and extracts metadata
 * Format: {prefix}_{mode}_{random}
 *
 * Examples:
 * - pk_live_abc123xyz → { type: 'public', mode: 'live' }
 * - pk_test_abc123xyz → { type: 'public', mode: 'test' }
 * - sk_live_abc123xyz → { type: 'secret', mode: 'live' }
 * - sk_test_abc123xyz → { type: 'secret', mode: 'test' }
 */
function parseApiKey(apiKey: string): {
  type: 'public' | 'secret'
  mode: 'live' | 'test'
  isValid: boolean
} {
  const parts = apiKey.split('_')

  // Validate format: {prefix}_{mode}_{random}
  if (parts.length !== 3) {
    return { type: 'public', mode: 'test', isValid: false }
  }

  const [prefix, mode, random] = parts

  // Validate prefix
  if (prefix !== 'pk' && prefix !== 'sk') {
    return { type: 'public', mode: 'test', isValid: false }
  }

  // Validate mode
  if (mode !== 'live' && mode !== 'test') {
    return { type: 'public', mode: 'test', isValid: false }
  }

  // Validate random part exists and is long enough
  if (!random || random.length < 16) {
    return { type: 'public', mode: 'test', isValid: false }
  }

  return {
    type: prefix === 'pk' ? 'public' : 'secret',
    mode: mode as 'live' | 'test',
    isValid: true,
  }
}

/**
 * Hashes secret key for database storage and lookup
 * Uses SHA-256 (one-way hash, more secure than encryption)
 *
 * @param secretKey - Plaintext secret key
 * @returns SHA-256 hash of the secret key
 */
function hashSecretKey(secretKey: string): string {
  return crypto.createHash('sha256').update(secretKey).digest('hex')
}

// ═══════════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Authenticates SDK requests using API key
 * Supports both public keys (pk_*) and secret keys (sk_*)
 *
 * @param requireSecretKey - If true, only accept secret keys (for sensitive operations)
 */
export function authenticateSDK(requireSecretKey: boolean = false) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1. Extract API key from Authorization header
      const authHeader = req.headers.authorization

      if (!authHeader) {
        throw new UnauthorizedError('Missing Authorization header')
      }

      // Expected format: "Bearer pk_live_abc123xyz" or "Bearer sk_live_abc123xyz"
      const parts = authHeader.split(' ')

      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        throw new UnauthorizedError('Invalid Authorization header format. Expected: Bearer <api_key>')
      }

      const apiKey = parts[1]

      // 2. Parse and validate API key format
      const { type, mode, isValid } = parseApiKey(apiKey)

      if (!isValid) {
        throw new UnauthorizedError('Invalid API key format')
      }

      // 3. Check if secret key is required
      if (requireSecretKey && type !== 'secret') {
        throw new UnauthorizedError('This operation requires a secret key (sk_live_* or sk_test_*)')
      }

      // 4. Look up merchant by API key
      let merchant

      if (type === 'public') {
        // Public key lookup (plaintext)
        merchant = await prisma.ecommerceMerchant.findUnique({
          where: { publicKey: apiKey },
          include: {
            provider: true,
            venue: { select: { id: true, status: true } }, // Include venue status for operational check
          },
        })
      } else {
        // Secret key lookup (hash-based for O(1) performance)
        const keyHash = hashSecretKey(apiKey)

        merchant = await prisma.ecommerceMerchant.findUnique({
          where: { secretKeyHash: keyHash },
          include: {
            provider: true,
            venue: { select: { id: true, status: true } }, // Include venue status for operational check
          },
        })
      }

      if (!merchant) {
        throw new UnauthorizedError('Invalid API key')
      }

      // 5. Verify merchant is active
      if (!merchant.active) {
        throw new UnauthorizedError('Merchant account is inactive')
      }

      // 5.5. Verify venue is operational (not SUSPENDED, ADMIN_SUSPENDED, or CLOSED)
      if (!merchant.venue || !OPERATIONAL_VENUE_STATUSES.includes(merchant.venue.status)) {
        logger.warn('SDK auth rejected: venue not operational', {
          merchantId: merchant.id,
          venueId: merchant.venueId,
          venueStatus: merchant.venue?.status,
        })
        throw new UnauthorizedError('Venue is not operational. Contact support for assistance.')
      }

      // 6. Verify key mode matches merchant sandbox mode
      const sandboxMode = mode === 'test'

      if (merchant.sandboxMode !== sandboxMode) {
        throw new BadRequestError(`API key mode (${mode}) does not match merchant environment (${merchant.sandboxMode ? 'test' : 'live'})`)
      }

      // 7. Attach SDK context to request
      req.sdkContext = {
        merchantId: merchant.id,
        merchantName: merchant.businessName,
        venueId: merchant.venueId, // Added for venue tracking
        keyType: type,
        sandboxMode,
        providerId: merchant.providerId,
        providerCode: merchant.provider.code,
        active: merchant.active,
      }

      logger.debug('SDK request authenticated', {
        merchantId: merchant.id,
        keyType: type,
        sandboxMode,
      })

      next()
    } catch (error) {
      // Pass errors to global error handler
      next(error)
    }
  }
}

/**
 * Middleware to require secret key authentication
 * Shorthand for authenticateSDK(true)
 */
export const requireSecretKey = authenticateSDK(true)

/**
 * Middleware to allow both public and secret keys
 * Shorthand for authenticateSDK(false)
 */
export const requireAnyKey = authenticateSDK(false)

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates a new API key pair for e-commerce merchant
 * Called during merchant onboarding
 *
 * @param sandboxMode - Whether to generate test keys or live keys
 * @returns Object with publicKey, secretKey (show once!), and secretKeyHash (store in DB)
 */
export function generateAPIKeys(sandboxMode: boolean): {
  publicKey: string
  secretKey: string
  secretKeyHash: string
} {
  const mode = sandboxMode ? 'test' : 'live'
  const randomPart = crypto.randomBytes(32).toString('hex') // 64 chars

  const publicKey = `pk_${mode}_${randomPart}`
  const secretKey = `sk_${mode}_${randomPart}`
  const secretKeyHash = hashSecretKey(secretKey)

  return {
    publicKey,
    secretKey, // ⚠️ Show this to user ONLY ONCE on creation!
    secretKeyHash, // ✅ Store this in database
  }
}
