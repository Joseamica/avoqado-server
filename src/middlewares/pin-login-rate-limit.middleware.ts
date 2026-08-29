/**
 * PIN Login Rate Limiting Middleware
 *
 * Prevents brute force attacks on PIN-based authentication.
 * Follows security best practices from Stripe, Square, and Toast POS systems.
 *
 * RATE LIMITS:
 * - Per IP: 5 login attempts per 15 minutes
 * - Per Venue: 10 login attempts per 15 minutes
 *
 * SECURITY FEATURES:
 * - Prevents brute force PIN enumeration (4-10 digit PINs = 10k-10B combinations)
 * - Protects individual venues from targeted attacks
 * - Fail-fast with 429 status (no waiting, immediate rejection)
 * - Audit logging for security monitoring
 *
 * WHY STRICT LIMITS:
 * - 4-digit PINs can be brute-forced in ~2 hours without rate limiting
 * - 6-digit PINs can be brute-forced in ~8 hours without rate limiting
 * - 5 attempts per 15 min = ~480 attempts per day (insufficient for brute force)
 *
 * @module PinLoginRateLimitMiddleware
 */

import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit'
import { Request, Response } from 'express'
import logger from '@/config/logger'

/**
 * Rate limit configuration (environment-aware)
 *
 * PRODUCTION: Strict limits for security (prevent brute force attacks)
 * DEVELOPMENT: Permissive limits for rapid testing without frustration
 *
 * Why different limits?
 * - Production: 10 attempts = ~40 PIN guesses max (secure against brute force)
 * - Development: 100 attempts = unlimited realistic testing (no blocking during dev)
 */
const isProd = process.env.NODE_ENV === 'production'

const RATE_LIMIT_CONFIG = {
  IP: {
    windowMs: isProd ? 15 * 60 * 1000 : 1 * 60 * 1000, // PROD: 15 min | DEV: 1 min
    max: isProd ? 10 : 100, // PROD: 10 attempts | DEV: 100 attempts
  },
  VENUE: {
    windowMs: isProd ? 15 * 60 * 1000 : 1 * 60 * 1000, // PROD: 15 min | DEV: 1 min
    max: isProd ? 20 : 200, // PROD: 20 attempts | DEV: 200 attempts
  },
}

/**
 * Per-IP rate limiter
 *
 * Limits PIN login attempts to 5 per 15 minutes per IP address.
 * This prevents brute force attacks from a single source.
 *
 * Example:
 * - Attacker tries 5 PINs → Blocked for 15 minutes
 * - Legitimate staff tries 3 wrong PINs, waits 15 min → Can try again
 */
export const ipRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.IP.windowMs,
  max: RATE_LIMIT_CONFIG.IP.max,
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable deprecated `X-RateLimit-*` headers
  // Key generator: use IP address
  keyGenerator: (req: Request) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    return `pin-login:ip:${ip}`
  },
  handler: (req: Request, res: Response) => {
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown'
    const venueId = req.params.venueId || 'unknown'

    logger.warn('🚨 PIN login rate limit exceeded (per IP)', {
      ipAddress,
      venueId,
      endpoint: req.path,
      userAgent: req.get('user-agent'),
    })

    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Demasiados intentos de inicio de sesión. Por favor intenta de nuevo en 15 minutos.',
      retryAfter: 15 * 60, // seconds
    })
  },
})

/**
 * Per-Venue rate limiter
 *
 * Limits PIN login attempts to 10 per 15 minutes per venue.
 * This prevents targeted attacks on a specific venue while allowing
 * multiple legitimate staff members to attempt login.
 *
 * Example:
 * - 10 staff members try wrong PINs → Venue temporarily locked
 * - 5 staff members try correct PINs + 4 try wrong → Still allowed
 */
export const venueRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.VENUE.windowMs,
  max: RATE_LIMIT_CONFIG.VENUE.max,
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable deprecated `X-RateLimit-*` headers
  // Key generator: use venueId from route params
  keyGenerator: (req: Request) => {
    const venueId = req.params.venueId || 'unknown'
    return `pin-login:venue:${venueId}`
  },
  // Skip if no venueId (let validation handle it)
  skip: (req: Request) => !req.params.venueId,
  handler: (req: Request, res: Response) => {
    const venueId = req.params.venueId || 'unknown'
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown'

    logger.warn('🚨 PIN login rate limit exceeded (per venue)', {
      venueId,
      ipAddress,
      endpoint: req.path,
    })

    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Este local ha tenido demasiados intentos de inicio de sesión. Por favor intenta de nuevo en 15 minutos.',
      retryAfter: 15 * 60, // seconds
    })
  },
})

/**
 * Combined rate limiter middleware
 *
 * Apply both IP and venue rate limiting.
 * Use this on the TPV PIN login endpoint.
 *
 * Order matters:
 * 1. IP rate limiter (stricter, 5 attempts) - blocks persistent attackers
 * 2. Venue rate limiter (looser, 10 attempts) - prevents venue-wide lockout
 *
 * @example
 * router.post(
 *   '/tpv/venues/:venueId/auth',
 *   pinLoginRateLimiter,
 *   authController.staffSignIn
 * )
 */
export const pinLoginRateLimiter = [ipRateLimiter, venueRateLimiter]

/**
 * Autorización con PIN de gerente — CUBETA PROPIA.
 *
 * 🔴 Montar `pinLoginRateLimiter` aquí ponía las autorizaciones en el MISMO
 * contador que el login de TPV y los cinco endpoints del reloj checador: sus
 * llaves son fijas (`pin-login:ip:` / `pin-login:venue:`) y no distinguen la
 * ruta. Como todas las terminales de un local salen por una sola IP (NAT), un
 * cambio de turno con once checadas dejaba al negocio sin poder autorizar
 * durante quince minutos — y al revés, una tarde con varias autorizaciones
 * dejaba al personal sin poder checar entrada.
 *
 * Peor aún, el 429 mentía sobre la causa: hablaba de "intentos de inicio de
 * sesión" a alguien que nunca intentó entrar. Aquí el mensaje dice lo que pasó.
 *
 * Los topes son los mismos; lo que cambia es que el presupuesto ya no se comparte.
 */
const overrideIpRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.IP.windowMs,
  max: RATE_LIMIT_CONFIG.IP.max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    return `pin-override:ip:${ip}`
  },
  handler: (req: Request, res: Response) => {
    logger.warn('🚨 Rate limit de autorización por PIN excedido (por IP)', {
      ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
      venueId: req.params.venueId || 'unknown',
      endpoint: req.path,
      userAgent: req.get('user-agent'),
    })
    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Demasiados intentos de autorización. Espera 15 minutos.',
      retryAfter: 15 * 60,
    })
  },
})

const overrideVenueRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.VENUE.windowMs,
  max: RATE_LIMIT_CONFIG.VENUE.max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `pin-override:venue:${req.params.venueId || 'unknown'}`,
  skip: (req: Request) => !req.params.venueId,
  handler: (req: Request, res: Response) => {
    logger.warn('🚨 Rate limit de autorización por PIN excedido (por venue)', {
      venueId: req.params.venueId || 'unknown',
      ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
      endpoint: req.path,
    })
    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Demasiados intentos de autorización. Espera 15 minutos.',
      retryAfter: 15 * 60,
    })
  },
})

export const pinOverrideRateLimiter = [overrideIpRateLimiter, overrideVenueRateLimiter]

/**
 * Cambiar de usuario por PIN — CUBETA PROPIA, y contada por APARATO.
 *
 * Dos diferencias deliberadas con las otras dos cubetas de esta casa:
 *
 * 1. 🔴 **La llave primaria es el APARATO (`X-Device-Id`), no la IP.** Todas las tablets de un
 *    local salen por una sola IP (NAT), así que contar por IP castiga al negocio entero por los
 *    dedos de una persona: en un local con cinco tablets, alguien tecleando mal su PIN dejaría a
 *    las otras cuatro sin poder cambiar de usuario. Contando por aparato, el bloqueo cae donde
 *    está el problema. Si el aparato no manda el header (app vieja), se cae a la IP: mejor
 *    contar de más que no contar.
 * 2. **Presupuesto separado** del login de TPV, del checador y del override, por lo mismo que
 *    documenta el bloque de arriba: un cambio de turno no puede dejar al local sin autorizar, ni
 *    una tarde de autorizaciones sin poder cambiar de usuario.
 */
function llaveDeAparato(req: Request): string {
  const deviceId = req.get('x-device-id')
  if (deviceId && deviceId.length <= 128) return `pin-switch:device:${deviceId}`
  return `pin-switch:ip:${req.ip || req.socket.remoteAddress || 'unknown'}`
}

const switchUserDeviceRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.IP.windowMs,
  max: RATE_LIMIT_CONFIG.IP.max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: llaveDeAparato,
  handler: (req: Request, res: Response) => {
    logger.warn('🚨 Rate limit de cambio de usuario excedido (por aparato)', {
      deviceId: req.get('x-device-id') || 'sin-header',
      venueId: req.params.venueId || 'unknown',
      ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
      endpoint: req.path,
    })
    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Demasiados intentos. Espera 15 minutos o inicia sesión con tu contraseña.',
      retryAfter: 15 * 60,
    })
  },
})

const switchUserVenueRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.VENUE.windowMs,
  max: RATE_LIMIT_CONFIG.VENUE.max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `pin-switch:venue:${req.params.venueId || 'unknown'}`,
  skip: (req: Request) => !req.params.venueId,
  handler: (req: Request, res: Response) => {
    logger.warn('🚨 Rate limit de cambio de usuario excedido (por venue)', {
      venueId: req.params.venueId || 'unknown',
      ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
      endpoint: req.path,
    })
    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Demasiados intentos. Espera 15 minutos o inicia sesión con tu contraseña.',
      retryAfter: 15 * 60,
    })
  },
})

export const pinSwitchUserRateLimiter = [switchUserDeviceRateLimiter, switchUserVenueRateLimiter]
export { llaveDeAparato as __llaveDeAparatoParaPruebas }
