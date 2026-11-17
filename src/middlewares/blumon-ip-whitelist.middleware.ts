/**
 * Blumon IP Whitelist Middleware
 *
 * Security layer for Blumon TPV webhooks.
 * Since Blumon doesn't provide signature verification (like Stripe),
 * we use IP whitelisting as the primary security mechanism.
 *
 * Lista de IPs: `BLUMON_ALLOWED_IPS` abajo (una IP nueva sólo con confirmación escrita de Blumon).
 *
 * 🔴 La IP se lee del PORTERO (`ipDelCliente`: `CF-Connecting-IP`, que Cloudflare no deja inventar, o `req.ip`), nunca
 * del primer eslabón de `X-Forwarded-For`: ése lo escribe quien llama, y Cloudflare y el proxy de Render sólo AGREGAN
 * su eslabón al final (medido en producción el 21-oct-2026). Con el primer eslabón, cualquiera pasaba mandando
 * `X-Forwarded-For: 3.132.184.158`. El cambio se hizo después de comprobar en producción, del 22 al 29-oct, que los 12
 * avisos reales de Blumon traían esa misma IP en el portero (D1, `docs/audit/2026-10-21-limites-por-ip/` del workspace).
 */

import { Request, Response, NextFunction } from 'express'
import logger from '../config/logger'
import { ipDelCliente } from '../utils/clientIp'

/**
 * IPs de origen de los avisos de Blumon TPV, para producción y sandbox (medido 22–29-oct y 17-nov-2026: los avisos de
 * producción llegan desde la misma IP que los de sandbox y el portero no rechazó ninguno). Medición:
 * `docs/audit/2026-11-09-sdk-propio-diseno/ips-del-aviso.md` del workspace.
 * Una IP nueva entra sólo con confirmación escrita de Blumon; sin comodines ni rangos.
 */
const BLUMON_ALLOWED_IPS = [
  '3.132.184.158', // Producción y sandbox (AWS us-east-2, Ohio)
]

/**
 * Middleware to verify Blumon webhook requests come from allowed IPs
 */
export function blumonIPWhitelist(req: Request, res: Response, next: NextFunction): void {
  // Skip in development
  if (process.env.NODE_ENV === 'development') {
    next()
    return
  }

  const clientIP = (ipDelCliente(req) ?? 'unknown').replace(/^::ffff:/, '')

  if (BLUMON_ALLOWED_IPS.includes(clientIP)) {
    next()
    return
  }

  logger.warn('🚫 Blumon webhook REJECTED: IP not in whitelist', {
    clientIP,
    // Lo que dijo quien llamó: si trae la IP de Blumon al principio, alguien intentó hacerse pasar por Blumon.
    xForwardedFor: req.headers['x-forwarded-for'],
    allowedIPs: BLUMON_ALLOWED_IPS,
  })

  res.status(403).json({
    success: false,
    error: 'Forbidden',
    message: 'IP not authorized',
  })
}

export default blumonIPWhitelist
