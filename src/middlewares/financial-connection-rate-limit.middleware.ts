/**
 * Financial Connection Rate Limiting Middleware
 *
 * Protege los tres endpoints que tocan credenciales bancarias reales:
 * - POST /venues/:venueId/financial-connections            (email+password contra el banco)
 * - POST /venues/:venueId/financial-connections/:id/validate-device (OTP)
 * - POST /venues/:venueId/financial-connections/:id/validate-2fa    (TOTP 6 dígitos)
 *
 * Sin esto, una sesión OWNER (legítima o secuestrada) puede usar Avoqado como
 * proxy de prueba de credenciales contra el API del banco, o fuerza-bruta el
 * TOTP dentro de la ventana de 5 min del reto. Mismo patrón environment-aware
 * que pin-login-rate-limit.middleware.ts.
 */

import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit'
import { Request, Response } from 'express'
import logger from '@/config/logger'

const isProd = process.env.NODE_ENV === 'production'

const WINDOW_MS = isProd ? 15 * 60 * 1000 : 60 * 1000 // PROD: 15 min | DEV: 1 min
const MAX_ATTEMPTS = isProd ? 10 : 100 // PROD: 10 intentos | DEV: 100

export const financialConnectionRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  // Estas rutas van detrás de authenticateTokenMiddleware, así que el staff está
  // identificado — clave por staff+venue (no por IP: varios owners legítimos
  // pueden compartir la IP de su local, y un atacante autenticado no debe poder
  // rotar IPs para escapar del límite).
  keyGenerator: (req: Request) => {
    const staffId = (req as any).authContext?.userId ?? req.ip ?? 'unknown'
    return `fin-conn:${req.params.venueId ?? 'none'}:${staffId}`
  },
  handler: (req: Request, res: Response) => {
    logger.warn('🚨 Financial connection rate limit exceeded', {
      venueId: req.params.venueId,
      staffId: (req as any).authContext?.userId,
      endpoint: req.path,
    })
    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Demasiados intentos de conexión bancaria. Por favor intenta de nuevo más tarde.',
      retryAfter: Math.ceil(WINDOW_MS / 1000),
    })
  },
})
