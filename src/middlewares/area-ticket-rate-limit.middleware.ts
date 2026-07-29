/**
 * Rate limiting de la resolución de vales de área.
 *
 * 🔴 POR QUÉ EXISTE (spec §5.1): *"El verificador es para errores de dedo, no
 * seguridad. Mod-10 es público y se adivina en diez intentos."* El espacio de códigos
 * son 6 dígitos de contador por partición, y el verificador reduce a 1 de cada 10 los
 * intentos que ni siquiera llegan a la base. Sin límite de tasa, cualquiera con una
 * sesión válida podría barrer el espacio y descubrir cuentas ajenas para canjearlas.
 *
 * Contra el canje ajeno protegen TRES cosas juntas, ninguna suficiente sola:
 *   1. este límite de tasa,
 *   2. que un vale ya entregado responde "ya entregado" en vez de devolver la cuenta,
 *   3. que la entrega exige `PAID` y deja registro de quién entregó.
 *
 * ── Lo que este límite NO puede hacer ────────────────────────────────────────────
 *
 * Frenar al cajero legítimo. El local escanea decenas de vales por hora en hora pico,
 * y un 429 en la caja detiene la fila. Por eso el tope es alto en términos de ataque
 * (barrer 999.999 códigos a 120/min tomaría meses) y holgado en términos de operación
 * (dos escaneos por segundo sostenidos por dispositivo).
 */

import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit'
import { Request, Response } from 'express'

import logger from '@/config/logger'

const isProd = process.env.NODE_ENV === 'production'

/** Ventana de un minuto: castiga el barrido, no el ritmo de una caja ocupada. */
const WINDOW_MS = 60 * 1000
/** 120/min por dispositivo en prod (2/s sostenidos). Sin tope práctico en dev. */
const MAX_PER_DEVICE = isProd ? 120 : 1000

/**
 * La llave es el DISPOSITIVO (`X-Device-Id`), no la IP: las 4 terminales del local
 * salen por la MISMA IP del WiFi, así que limitar por IP castigaría a las tres
 * inocentes cuando una se descompone. Sin header caemos a la IP, que es lo único que
 * queda.
 */
export const areaTicketResolveRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_PER_DEVICE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const raw = req.headers['x-device-id']
    const deviceUid = Array.isArray(raw) ? raw[0] : raw
    const venueId = req.params.venueId || 'unknown'
    if (typeof deviceUid === 'string' && deviceUid.trim()) {
      return `area-ticket:device:${venueId}:${deviceUid.trim().slice(0, 64)}`
    }
    return `area-ticket:ip:${venueId}:${req.ip || req.socket.remoteAddress || 'unknown'}`
  },
  handler: (req: Request, res: Response) => {
    logger.warn('🚨 Rate limit de resolución de vales excedido', {
      venueId: req.params.venueId,
      ipAddress: req.ip,
      endpoint: req.path,
    })
    res.status(429).json({
      success: false,
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Demasiadas consultas de vales seguidas. Espera un momento y vuelve a escanear.',
      retryAfter: 60,
    })
  },
})
