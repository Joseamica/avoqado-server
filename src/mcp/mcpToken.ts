import jwt from 'jsonwebtoken'
import { MCP_DIRECTORY_RESOURCE_URL } from './oauth/config'
import type { McpProfile } from './directory/catalog'

export const MCP_AUDIENCE = 'avoqado-mcp'
export const MCP_DIRECTORY_AUDIENCE = MCP_DIRECTORY_RESOURCE_URL.href

function getSecret(): jwt.Secret {
  const secret = process.env.ACCESS_TOKEN_SECRET
  if (!secret) throw new Error('ACCESS_TOKEN_SECRET is not set')
  return secret
}

export interface McpTokenPayload {
  profile?: 'directory' // derived from the verified audience; legacy/manual tokens have no profile
  sub: string // Staff.id
  org: string // active organization id
  cid?: string // OAuth client id (Phase 1); absent for dev-server tokens
  scp?: string[] // granted OAuth scopes; absent on legacy tokens (read-only compatibility)
  exp?: number // expiry (epoch seconds) — required by the SDK bearer middleware
  iat?: number // emisión (segundos): el corte de sesión se compara contra esto
  gat?: number // concesión ORIGINAL de la cadena OAuth (segundos); ausente en tokens viejos/de desarrollo
}

/**
 * Issue a short-lived, audience-bound MCP token. Distinct from dashboard /api/v1 tokens.
 * WHY embed scopes (`scp`): the granted OAuth scope used to be dropped at mint time, so a client
 * connected with only `mcp:read` still carried an all-powerful token. Carrying the real scopes lets
 * verifyAccessToken report — and the guard enforce — what was actually granted.
 */
export function issueMcpToken(
  staffId: string,
  activeOrg: string,
  ttlSeconds = 3600,
  clientId?: string,
  scopes?: string[],
  concedidoEn?: Date,
  profile: McpProfile = 'manual',
): string {
  const payload: Record<string, unknown> = { sub: staffId, org: activeOrg }
  if (clientId) payload.cid = clientId
  payload.scp = scopes ?? ['mcp:read']
  // El acceso emitido en una renovación hereda la fecha de la autorización original: si la contraseña
  // cambió entre validar y emitir, su `iat` sería posterior al corte y viviría su hora completa.
  if (concedidoEn) payload.gat = Math.floor(concedidoEn.getTime() / 1000)
  return jwt.sign(payload, getSecret(), {
    audience: profile === 'directory' ? MCP_DIRECTORY_AUDIENCE : MCP_AUDIENCE,
    expiresIn: ttlSeconds,
  })
}

/**
 * La fecha con la que se juzga el corte de sesión: la MÁS VIEJA que trae el token — la de la autorización
 * original de su cadena (`gat`), si la tiene. Un `gat` posterior nunca rejuvenece al token.
 */
export function emisionDeCadena(payload: Pick<McpTokenPayload, 'iat' | 'gat'>): number | undefined {
  return typeof payload.gat === 'number' && typeof payload.iat === 'number' ? Math.min(payload.iat, payload.gat) : payload.iat
}

/** Verify an MCP token. Rejects any token NOT minted for the MCP audience. */
export function verifyMcpToken(token: string, profile: McpProfile | 'either' = 'manual'): McpTokenPayload {
  const audience =
    profile === 'either' ? [MCP_AUDIENCE, MCP_DIRECTORY_AUDIENCE] : profile === 'directory' ? MCP_DIRECTORY_AUDIENCE : MCP_AUDIENCE
  const decoded = jwt.verify(token, getSecret(), { audience }) as jwt.JwtPayload
  // Issued tokens have exactly one audience. Reject multi-resource tokens rather than broadening a grant.
  if (decoded.aud !== MCP_AUDIENCE && decoded.aud !== MCP_DIRECTORY_AUDIENCE) throw new Error('Invalid MCP token audience')
  const org = (decoded as Record<string, unknown>).org
  if (!decoded.sub || typeof org !== 'string') throw new Error('Invalid MCP token payload')
  const cid = (decoded as Record<string, unknown>).cid
  const scp = (decoded as Record<string, unknown>).scp
  const gat = (decoded as Record<string, unknown>).gat
  return {
    ...(decoded.aud === MCP_DIRECTORY_AUDIENCE ? { profile: 'directory' as const } : {}),
    sub: decoded.sub,
    org,
    cid: typeof cid === 'string' ? cid : undefined,
    scp: Array.isArray(scp) ? scp.filter((s): s is string => typeof s === 'string') : undefined,
    exp: decoded.exp,
    iat: decoded.iat,
    gat: typeof gat === 'number' && Number.isFinite(gat) ? gat : undefined,
  }
}
