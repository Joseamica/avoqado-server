/**
 * Blumon IP Whitelist Middleware
 *
 * Security layer for Blumon TPV webhooks.
 * Since Blumon doesn't provide signature verification (like Stripe),
 * we use IP whitelisting as the primary security mechanism.
 *
 * To add new IPs: Update BLUMON_ALLOWED_IPS array below
 */

import { Request, Response, NextFunction } from 'express'
import logger from '../config/logger'
import { ipDelCliente } from '../utils/clientIp'

/**
 * Known Blumon webhook source IPs
 * - Sandbox: 3.132.184.158 (AWS us-east-2, Ohio)
 * - Production: TBD (ask Edgardo)
 */
const BLUMON_ALLOWED_IPS = [
  '3.132.184.158', // Sandbox (AWS us-east-2)
  // Add production IPs here when provided by Blumon
]

/**
 * Get client IP, handling proxies (Render, Cloudflare, etc.)
 */
function getClientIP(req: Request): string {
  const forwardedFor = req.headers['x-forwarded-for']
  if (forwardedFor) {
    const ips = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor).split(',')
    return ips[0].trim()
  }

  const realIP = req.headers['x-real-ip']
  if (realIP) {
    return Array.isArray(realIP) ? realIP[0] : realIP
  }

  const cfConnectingIP = req.headers['cf-connecting-ip']
  if (cfConnectingIP) {
    return Array.isArray(cfConnectingIP) ? cfConnectingIP[0] : cfConnectingIP
  }

  return req.ip || req.socket?.remoteAddress || 'unknown'
}

/**
 * 🔎 D1, paso 1 (21-oct-2026): SÓLO observa; la decisión sigue siendo la de `getClientIP`.
 *
 * `getClientIP` toma el PRIMER eslabón de `X-Forwarded-For`, y ése lo escribe quien llama: Cloudflare y el proxy de
 * Render AGREGAN su eslabón al final, no reemplazan la cadena (medido en producción el 21-oct). O sea que cualquiera
 * pasa este guardia mandando `X-Forwarded-For: 3.132.184.158`. Lo correcto es leer la IP del portero
 * (`ipDelCliente`: `CF-Connecting-IP`, que Cloudflare no deja inventar, o `req.ip`).
 *
 * No se cambia a ciegas: la lista sólo trae la IP del sandbox y la de producción dice «TBD». Si los avisos REALES
 * de Blumon llegan con otra IP del portero, el cambio los rechazaría. Por eso aquí se anota, en cada aviso, qué
 * decidiría leer la IP del portero. Paso 2 —cambiar la decisión— sólo si los avisos reales dicen
 * `cambiariaLaDecision: false`. Un `warn` con `decision: 'ACEPTA'` y `cambiariaLaDecision: true` es, o un aviso real
 * que el cambio rechazaría, o alguien entrando con la IP inventada. Para distinguirlos, la observación viaja también
 * en `res.locals` y el controlador la pone en «📤 Blumon webhook processed», junto al pago que emparejó: los dos
 * registros llevan `correlationId` distintos y no se pueden unir (Codex d1-r1).
 */
function observarIpDelPortero(req: Request, ipQueDiceElVisitante: string) {
  const ipDelPortero = (ipDelCliente(req) ?? 'unknown').replace(/^::ffff:/, '')
  const aceptaHoy = BLUMON_ALLOWED_IPS.includes(ipQueDiceElVisitante)
  const datos = {
    ipQueDiceElVisitante,
    ipDelPortero,
    coinciden: ipQueDiceElVisitante === ipDelPortero,
    decision: aceptaHoy ? 'ACEPTA' : 'RECHAZA',
    cambiariaLaDecision: aceptaHoy !== BLUMON_ALLOWED_IPS.includes(ipDelPortero),
  }

  if (datos.cambiariaLaDecision) {
    logger.warn('🔎 [Blumon IP] leer la IP del portero CAMBIARÍA la decisión (D1, paso 1: sólo se observa)', datos)
  } else {
    logger.info('🔎 [Blumon IP] observación (D1, paso 1)', datos)
  }
  return datos
}

/**
 * Middleware to verify Blumon webhook requests come from allowed IPs
 */
export function blumonIPWhitelist(req: Request, res: Response, next: NextFunction): void {
  // Skip in development
  if (process.env.NODE_ENV === 'development') {
    next()
    return
  }

  const clientIP = getClientIP(req)
  const normalizedIP = clientIP.replace(/^::ffff:/, '')
  res.locals.blumonIpObservada = observarIpDelPortero(req, normalizedIP)

  if (BLUMON_ALLOWED_IPS.includes(normalizedIP)) {
    next()
    return
  }

  logger.warn('🚫 Blumon webhook REJECTED: IP not in whitelist', {
    clientIP: normalizedIP,
    allowedIPs: BLUMON_ALLOWED_IPS,
  })

  res.status(403).json({
    success: false,
    error: 'Forbidden',
    message: 'IP not authorized',
  })
}

export default blumonIPWhitelist
