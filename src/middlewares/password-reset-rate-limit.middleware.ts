/**
 * Password Reset Rate Limiting Middleware
 *
 * Prevents abuse of password reset functionality by limiting request frequency.
 * Follows Stripe/GitHub pattern for security.
 *
 * RATE LIMITS:
 * - Per Email: 3 requests per 15 minutes
 * - Per IP: 10 requests per hour
 *
 * SECURITY FEATURES:
 * - Prevents brute force attacks
 * - Protects against email enumeration attempts
 * - Prevents resource exhaustion (SMTP spam)
 *
 * @module PasswordResetRateLimitMiddleware
 */

import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit'
import { Request, Response } from 'express'
import logger from '@/config/logger'

/**
 * Rate limit configuration
 */
const RATE_LIMIT_CONFIG = {
  EMAIL: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 3, // 3 requests per 15 minutes per email
  },
  IP: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // 10 requests per hour per IP
  },
}

/**
 * Per-email rate limiter
 *
 * Limits password reset requests to 3 per 15 minutes per email address.
 * This prevents abuse while allowing legitimate users to retry if needed.
 */
export const emailRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.EMAIL.windowMs,
  max: RATE_LIMIT_CONFIG.EMAIL.max,
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  // Key generator: use email from request body (lowercase for consistency)
  keyGenerator: (req: Request) => {
    const email = req.body?.email
    if (!email) return req.ip || 'unknown'
    return email.toString().toLowerCase()
  },
  // Skip if no email in body (let validation handle it)
  skip: (req: Request) => !req.body?.email,
  handler: (req: Request, res: Response) => {
    const email = req.body?.email || 'unknown'
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown'

    logger.warn('🚨 Password reset rate limit exceeded (per email)', { email, ipAddress })

    res.status(429).json({
      success: false,
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Has solicitado demasiados restablecimientos de contraseña. Por favor intenta de nuevo en 15 minutos.',
      retryAfter: 15 * 60, // seconds
    })
  },
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Has solicitado demasiados restablecimientos de contraseña. Por favor intenta de nuevo en 15 minutos.',
  },
})

/**
 * Per-IP rate limiter
 *
 * Limits password reset requests to 10 per hour per IP address.
 * This prevents distributed attacks and protects SMTP resources.
 */
export const ipRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.IP.windowMs,
  max: RATE_LIMIT_CONFIG.IP.max,
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  // Key generator: use IP address
  keyGenerator: (req: Request) => {
    return req.ip || req.socket.remoteAddress || 'unknown'
  },
  handler: (req: Request, res: Response) => {
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown'

    logger.warn('🚨 Password reset rate limit exceeded (per IP)', { ipAddress })

    res.status(429).json({
      success: false,
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Demasiadas solicitudes desde esta dirección IP. Por favor intenta de nuevo en 1 hora.',
      retryAfter: 60 * 60, // seconds
    })
  },
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Demasiadas solicitudes desde esta dirección IP. Por favor intenta de nuevo en 1 hora.',
  },
})

/**
 * Combined rate limiter middleware
 *
 * Apply both email and IP rate limiting.
 * Use this on the password reset request endpoint.
 *
 * @example
 * router.post(
 *   '/auth/request-reset',
 *   passwordResetRateLimiter,
 *   authController.requestPasswordReset
 * )
 */
export const passwordResetRateLimiter = [ipRateLimiter, emailRateLimiter]
