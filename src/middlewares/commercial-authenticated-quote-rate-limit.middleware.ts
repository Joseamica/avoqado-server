import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit'
import type { Request, Response } from 'express'
import AppError from '@/errors/AppError'

const WINDOW_MS = 60_000

function authenticatedActorKey(request: Request): string {
  const actorId = request.authContext?.userId
  if (typeof actorId !== 'string' || actorId.length === 0) {
    throw new AppError('La autenticación es obligatoria para cotizar.', 401, true, 'COMMERCIAL_AUTHENTICATION_REQUIRED')
  }
  return `actor:${actorId}`
}

function rejectRateLimited(_request: Request, response: Response): void {
  response.status(429).json({
    success: false,
    code: 'COMMERCIAL_AUTHENTICATED_QUOTE_RATE_LIMITED',
    message: 'Demasiadas solicitudes de cotización.',
  })
}

function rejectConfiguratorPreviewRateLimited(_request: Request, response: Response): void {
  response.status(429).json({
    success: false,
    code: 'COMMERCIAL_CONFIGURATOR_PREVIEW_RATE_LIMITED',
    message: 'Demasiadas actualizaciones del configurador. Espera un momento.',
  })
}

export function createCommercialAuthenticatedQuoteRateLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    max: 30,
    keyGenerator: authenticatedActorKey,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rejectRateLimited,
  })
}

export function createCommercialConfiguratorPreviewRateLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    max: 90,
    keyGenerator: authenticatedActorKey,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rejectConfiguratorPreviewRateLimited,
  })
}

export const commercialAuthenticatedQuoteRateLimiter = createCommercialAuthenticatedQuoteRateLimiter()
export const commercialConfiguratorPreviewRateLimiter = createCommercialConfiguratorPreviewRateLimiter()
