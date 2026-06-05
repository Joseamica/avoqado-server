import jwt from 'jsonwebtoken'
import { ACCESS_TOKEN_SECRET } from '@/config/env'
import type { AvoqadoJwtPayload } from '@/security'

/**
 * Reuse an active dashboard session for one-click MCP connect. The dashboard sets a same-domain
 * HTTP-only `accessToken` cookie; since the MCP OAuth pages live on the same host, the browser
 * sends it to /authorize and /mcp-oauth/approve. Returns the staffId of a VALID, non-impersonation
 * session, or null (→ fall back to the email/password page). Impersonation tokens (`act` claim) are
 * never reused, so a SUPERADMIN's impersonation session can't silently connect as the impersonated user.
 */
export function staffIdFromDashboardSession(req: { cookies?: Record<string, string> }): string | null {
  const token = req.cookies?.accessToken
  if (!token) return null
  try {
    const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET, { algorithms: ['HS256'] }) as AvoqadoJwtPayload
    if (decoded.act || !decoded.sub) return null
    return decoded.sub
  } catch {
    return null // expired / invalid / tampered → fall back to the password page
  }
}
