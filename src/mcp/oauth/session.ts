import jwt from 'jsonwebtoken'
import type { Request, Response } from 'express'
import { ACCESS_TOKEN_SECRET } from '@/config/env'
import type { AvoqadoJwtPayload } from '@/security'
import { autenticacionOpcional } from '@/middlewares/autenticacionOpcional.middleware'

/**
 * Reuse an active dashboard session for one-click MCP connect. The dashboard sets a same-domain
 * HTTP-only `accessToken` cookie; since the MCP OAuth pages live on the same host, the browser
 * sends it to /authorize and /mcp-oauth/approve. Returns the staffId of a VALID, non-impersonation
 * session, or null (→ fall back to the email/password page). Impersonation tokens (`act` claim) are
 * never reused, so a SUPERADMIN's impersonation session can't silently connect as the impersonated user.
 *
 * 🔴 Firma y vencimiento NO bastan (Codex gpt-6-astra, 24-sep): una sesión cerrada, cortada por
 * cambio de contraseña o con JTI revocado seguía conectando el MCP mientras el token no venciera.
 * Ahora pasa por las MISMAS reglas que cualquier ruta (`authenticateTokenMiddleware`, vía
 * `autenticacionOpcional`), en vez de repetirlas aquí.
 */
export async function staffIdFromDashboardSession(req: { cookies?: Record<string, string> }): Promise<string | null> {
  const token = req.cookies?.accessToken
  if (!token) return null
  let decoded: AvoqadoJwtPayload
  try {
    decoded = jwt.verify(token, ACCESS_TOKEN_SECRET, { algorithms: ['HS256'] }) as AvoqadoJwtPayload
  } catch {
    return null // expired / invalid / tampered → fall back to the password page
  }
  if (decoded.act || !decoded.sub) return null

  const prueba = { cookies: { accessToken: token }, headers: {} } as unknown as Request & { authContext?: { userId?: string } }
  await autenticacionOpcional(prueba, {} as Response, () => undefined)
  return prueba.authContext?.userId === decoded.sub ? decoded.sub : null
}
