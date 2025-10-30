/**
 * Chatbot Rate Limiting Middleware
 *
 * Prevents abuse and resource exhaustion by limiting chatbot query frequency.
 *
 * RATE LIMITS:
 * - Per User: 10 queries per minute
 * - Per Venue: 100 queries per hour
 * - Per IP: 20 queries per minute (fallback if no auth)
 *
 * Uses in-memory store (can be upgraded to Redis for production scale)
 *
 * @module ChatbotRateLimitMiddleware
 */

import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit'
import { Request, Response, NextFunction } from 'express'

import { SecurityAuditLoggerService } from '../services/dashboard/security-audit-logger.service'
import { SecurityResponseService, SecurityViolationType } from '../services/dashboard/security-response.service'
import logger from '@/config/logger'

/**
 * Rate limit configuration
 */
const RATE_LIMIT_CONFIG = {
  USER: {
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 requests per minute
  },
  VENUE: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 100, // 100 requests per hour
  },
  IP: {
    windowMs: 60 * 1000, // 1 minute
    max: 20, // 20 requests per minute (fallback)
  },
}

/**
 * In-memory store for tracking requests
 * (Can be replaced with Redis for production scale)
 */
class InMemoryRateLimitStore {
  private userCounts: Map<string, { count: number; resetTime: number }> = new Map()
  private venueCounts: Map<string, { count: number; resetTime: number }> = new Map()

  /**
   * Increment counter for a key
   */
  public increment(
    key: string,
    type: 'user' | 'venue',
  ): {
    count: number
    resetTime: number
    remaining: number
    exceeded: boolean
  } {
    const store = type === 'user' ? this.userCounts : this.venueCounts
    const config = type === 'user' ? RATE_LIMIT_CONFIG.USER : RATE_LIMIT_CONFIG.VENUE
    const now = Date.now()

    let record = store.get(key)

    // Reset if window has passed
    if (!record || now >= record.resetTime) {
      record = {
        count: 0,
        resetTime: now + config.windowMs,
      }
    }

    record.count++
    store.set(key, record)

    const remaining = Math.max(0, config.max - record.count)
    const exceeded = record.count > config.max

    return {
      count: record.count,
      resetTime: record.resetTime,
      remaining,
      exceeded,
    }
  }

  /**
   * Get current count for a key
   */
  public get(
    key: string,
    type: 'user' | 'venue',
  ): {
    count: number
    resetTime: number
  } | null {
    const store = type === 'user' ? this.userCounts : this.venueCounts
    const record = store.get(key)

    if (!record) return null

    // Check if expired
    if (Date.now() >= record.resetTime) {
      store.delete(key)
      return null
    }

    return record
  }

  /**
   * Clean up expired entries (call periodically)
   */
  public cleanup(): void {
    const now = Date.now()

    // Clean user counts
    for (const [key, record] of this.userCounts.entries()) {
      if (now >= record.resetTime) {
        this.userCounts.delete(key)
      }
    }

    // Clean venue counts
    for (const [key, record] of this.venueCounts.entries()) {
      if (now >= record.resetTime) {
        this.venueCounts.delete(key)
      }
    }
  }
}

// Global store instance
const rateLimitStore = new InMemoryRateLimitStore()

// Cleanup expired entries every 5 minutes
setInterval(
  () => {
    rateLimitStore.cleanup()
    logger.debug('🧹 Rate limit store cleanup completed')
  },
  5 * 60 * 1000,
)

/**
 * Custom rate limit middleware for chatbot queries
 *
 * Checks both per-user and per-venue limits
 */
export const chatbotRateLimitMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const userId = req.authContext?.userId
    const venueId = req.authContext?.venueId
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown'

    // If no auth context, use IP-based rate limiting
    if (!userId || !venueId) {
      logger.warn('⚠️ Rate limit check without auth context, using IP-based limiting', { ipAddress })
      return ipBasedRateLimiter(req, res, next)
    }

    // Check per-user limit
    const userLimit = rateLimitStore.increment(userId, 'user')

    if (userLimit.exceeded) {
      const retryAfterSeconds = Math.ceil((userLimit.resetTime - Date.now()) / 1000)

      // Log to audit log
      SecurityAuditLoggerService.logRateLimitExceeded({
        userId,
        venueId,
        ipAddress,
        limit: RATE_LIMIT_CONFIG.USER.max,
        windowMs: RATE_LIMIT_CONFIG.USER.windowMs,
      })

      // Return rate limit error
      const securityResponse = SecurityResponseService.generateSecurityResponse(
        SecurityViolationType.RATE_LIMIT_EXCEEDED,
        'es',
        `Has realizado ${userLimit.count} consultas en el último minuto. El límite es ${RATE_LIMIT_CONFIG.USER.max} consultas por minuto.`,
      )

      res.status(429)
      res.setHeader('Retry-After', String(retryAfterSeconds))
      res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_CONFIG.USER.max))
      res.setHeader('X-RateLimit-Remaining', String(userLimit.remaining))
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(userLimit.resetTime / 1000)))

      res.json({
        success: false,
        error: 'RATE_LIMIT_EXCEEDED',
        message: securityResponse.message,
        retryAfter: retryAfterSeconds,
      })
      return
    }

    // Check per-venue limit
    const venueLimit = rateLimitStore.increment(venueId, 'venue')

    if (venueLimit.exceeded) {
      const retryAfterSeconds = Math.ceil((venueLimit.resetTime - Date.now()) / 1000)

      // Log to audit log
      SecurityAuditLoggerService.logRateLimitExceeded({
        userId,
        venueId,
        ipAddress,
        limit: RATE_LIMIT_CONFIG.VENUE.max,
        windowMs: RATE_LIMIT_CONFIG.VENUE.windowMs,
      })

      // Return rate limit error
      const securityResponse = SecurityResponseService.generateSecurityResponse(
        SecurityViolationType.RATE_LIMIT_EXCEEDED,
        'es',
        `Tu sucursal ha realizado ${venueLimit.count} consultas en la última hora. El límite es ${RATE_LIMIT_CONFIG.VENUE.max} consultas por hora.`,
      )

      res.status(429)
      res.setHeader('Retry-After', String(retryAfterSeconds))
      res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_CONFIG.VENUE.max))
      res.setHeader('X-RateLimit-Remaining', String(venueLimit.remaining))
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(venueLimit.resetTime / 1000)))

      res.json({
        success: false,
        error: 'RATE_LIMIT_EXCEEDED',
        message: securityResponse.message,
        retryAfter: retryAfterSeconds,
      })
      return
    }

    // Add rate limit headers (for transparency)
    res.setHeader('X-RateLimit-User-Limit', String(RATE_LIMIT_CONFIG.USER.max))
    res.setHeader('X-RateLimit-User-Remaining', String(userLimit.remaining))
    res.setHeader('X-RateLimit-Venue-Limit', String(RATE_LIMIT_CONFIG.VENUE.max))
    res.setHeader('X-RateLimit-Venue-Remaining', String(venueLimit.remaining))

    // Pass to next middleware
    next()
  } catch (error) {
    logger.error('❌ Rate limit middleware error', { error })
    // Don't block request on error, but log it
    next()
  }
}

/**
 * IP-based rate limiter (fallback when no auth context)
 */
const ipBasedRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.IP.windowMs,
  max: RATE_LIMIT_CONFIG.IP.max,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests from this IP address. Please try again later.',
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  handler: (req: Request, res: Response) => {
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown'

    logger.warn('🚨 IP-based rate limit exceeded', { ipAddress })

    // Log to audit log (without userId/venueId since no auth)
    SecurityAuditLoggerService.logSecurityViolation({
      userId: 'UNAUTHENTICATED',
      venueId: 'N/A',
      violationType: SecurityViolationType.RATE_LIMIT_EXCEEDED,
      description: `IP-based rate limit exceeded: ${ipAddress}`,
      ipAddress,
    })

    const securityResponse = SecurityResponseService.generateSecurityResponse(SecurityViolationType.RATE_LIMIT_EXCEEDED, 'en')

    res.status(429).json({
      success: false,
      error: 'RATE_LIMIT_EXCEEDED',
      message: securityResponse.message,
    })
  },
})

/**
 * Get current rate limit status for a user/venue
 * (Useful for debugging or displaying to user)
 */
export function getRateLimitStatus(
  userId: string,
  venueId: string,
): {
  user: { count: number; limit: number; remaining: number; resetTime: number } | null
  venue: { count: number; limit: number; remaining: number; resetTime: number } | null
} {
  const userRecord = rateLimitStore.get(userId, 'user')
  const venueRecord = rateLimitStore.get(venueId, 'venue')

  return {
    user: userRecord
      ? {
          count: userRecord.count,
          limit: RATE_LIMIT_CONFIG.USER.max,
          remaining: Math.max(0, RATE_LIMIT_CONFIG.USER.max - userRecord.count),
          resetTime: userRecord.resetTime,
        }
      : null,
    venue: venueRecord
      ? {
          count: venueRecord.count,
          limit: RATE_LIMIT_CONFIG.VENUE.max,
          remaining: Math.max(0, RATE_LIMIT_CONFIG.VENUE.max - venueRecord.count),
          resetTime: venueRecord.resetTime,
        }
      : null,
  }
}

/**
 * Reset rate limits for a user/venue (admin function)
 */
export function resetRateLimits(userId?: string, venueId?: string): void {
  if (userId) {
    rateLimitStore['userCounts'].delete(userId)
    logger.info('✅ Reset rate limits for user', { userId })
  }

  if (venueId) {
    rateLimitStore['venueCounts'].delete(venueId)
    logger.info('✅ Reset rate limits for venue', { venueId })
  }
}
