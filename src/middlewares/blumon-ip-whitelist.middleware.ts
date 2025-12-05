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
