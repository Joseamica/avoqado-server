import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit'
import type { Request, Response } from 'express'
import { commercialLimiterKeyResolver, type CommercialLimiterKeyResolver } from '@/services/commercial/commercialLimiterKeyResolver.service'

const WINDOW_MS = 60_000

export interface CommercialPublicRateLimiterDependencies {
  keyResolver: CommercialLimiterKeyResolver
}

export interface CommercialPublicRateLimiters {
  parent: RateLimitRequestHandler
  acquisitionContext: RateLimitRequestHandler
  quotePreviewV2: RateLimitRequestHandler
}

function rejectRateLimited(_request: Request, response: Response): void {
  response.status(429).json({
    success: false,
    code: 'COMMERCIAL_PUBLIC_RATE_LIMITED',
    message: 'Demasiadas solicitudes.',
  })
}

function limiter(max: number, keyResolver: CommercialLimiterKeyResolver): RateLimitRequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    max,
    keyGenerator: keyResolver,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rejectRateLimited,
  })
}

export function createCommercialPublicRateLimiters(
  dependencies: CommercialPublicRateLimiterDependencies = { keyResolver: commercialLimiterKeyResolver },
): CommercialPublicRateLimiters {
  return {
    parent: limiter(60, dependencies.keyResolver),
    acquisitionContext: limiter(10, dependencies.keyResolver),
    quotePreviewV2: limiter(30, dependencies.keyResolver),
  }
}

const commercialPublicRateLimiters = createCommercialPublicRateLimiters()

export const commercialPublicParentRateLimiter = commercialPublicRateLimiters.parent
export const commercialAcquisitionContextRateLimiter = commercialPublicRateLimiters.acquisitionContext
export const commercialQuotePreviewV2RateLimiter = commercialPublicRateLimiters.quotePreviewV2
