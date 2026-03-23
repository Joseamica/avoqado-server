/**
 * Partner API Authentication Middleware
 *
 * Authenticates API requests from external partners (e.g., PlayTelecom)
 * using organization-scoped API keys.
 *
 * Key format: sk_{mode}_{random} (same as EcommerceMerchant)
 * Only secret keys accepted (server-to-server).
 *
 * Flow:
 * 1. Extract key from Authorization: Bearer sk_live_xxx
 * 2. SHA-256 hash the key
 * 3. Lookup PartnerAPIKey by secretKeyHash
 * 4. Verify active + mode matches
 * 5. Attach req.partnerContext
 */

import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import { UnauthorizedError, BadRequestError } from '@/errors/AppError'
import crypto from 'crypto'
import logger from '@/config/logger'

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

function parsePartnerKey(apiKey: string): {
  mode: 'live' | 'test'
  isValid: boolean
} {
  const parts = apiKey.split('_')
  if (parts.length !== 3) return { mode: 'test', isValid: false }

  const [prefix, mode, random] = parts
  if (prefix !== 'sk') return { mode: 'test', isValid: false }
  if (mode !== 'live' && mode !== 'test') return { mode: 'test', isValid: false }
  if (!random || random.length < 16) return { mode: 'test', isValid: false }

  return { mode: mode as 'live' | 'test', isValid: true }
}

export function authenticatePartner() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization
      if (!authHeader) {
        throw new UnauthorizedError('Missing Authorization header')
      }

      const parts = authHeader.split(' ')
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        throw new UnauthorizedError('Invalid Authorization header format. Expected: Bearer <api_key>')
      }

      const apiKey = parts[1]
      const { mode, isValid } = parsePartnerKey(apiKey)

      if (!isValid) {
        throw new UnauthorizedError('Invalid API key format. Expected: sk_live_xxx or sk_test_xxx')
      }

      const keyHash = hashKey(apiKey)
      const partner = await prisma.partnerAPIKey.findUnique({
        where: { secretKeyHash: keyHash },
        include: {
          organization: { select: { id: true, name: true } },
        },
      })

      if (!partner) {
        throw new UnauthorizedError('Invalid API key')
      }

      if (!partner.active) {
        throw new UnauthorizedError('API key is inactive')
      }

      const sandboxMode = mode === 'test'
      if (partner.sandboxMode !== sandboxMode) {
        throw new BadRequestError(`API key mode (${mode}) does not match partner environment (${partner.sandboxMode ? 'test' : 'live'})`)
      }

      // Update last used tracking (fire-and-forget)
      prisma.partnerAPIKey
        .update({
          where: { id: partner.id },
          data: {
            lastUsedAt: new Date(),
            lastUsedIp: req.ip || req.socket.remoteAddress,
          },
        })
        .catch(() => {}) // Non-blocking

      req.partnerContext = {
        partnerId: partner.id,
        partnerName: partner.name,
        organizationId: partner.organizationId,
        sandboxMode,
      }

      logger.debug('Partner API request authenticated', {
        partnerId: partner.id,
        partnerName: partner.name,
        organizationId: partner.organizationId,
        sandboxMode,
      })

      next()
    } catch (error) {
      next(error)
    }
  }
}

export const requirePartnerKey = authenticatePartner()
