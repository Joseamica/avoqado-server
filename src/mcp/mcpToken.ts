import jwt from 'jsonwebtoken'

export const MCP_AUDIENCE = 'avoqado-mcp'

function getSecret(): jwt.Secret {
  const secret = process.env.ACCESS_TOKEN_SECRET
  if (!secret) throw new Error('ACCESS_TOKEN_SECRET is not set')
  return secret
}

export interface McpTokenPayload {
  sub: string // Staff.id
  org: string // active organization id
  cid?: string // OAuth client id (Phase 1); absent for dev-server tokens
  scp?: string[] // granted OAuth scopes; absent for dev-server/legacy tokens (→ treated as full)
  exp?: number // expiry (epoch seconds) — required by the SDK bearer middleware
}

/**
 * Issue a short-lived, audience-bound MCP token. Distinct from dashboard /api/v1 tokens.
 * WHY embed scopes (`scp`): the granted OAuth scope used to be dropped at mint time, so a client
 * connected with only `mcp:read` still carried an all-powerful token. Carrying the real scopes lets
 * verifyAccessToken report — and the guard enforce — what was actually granted.
 */
export function issueMcpToken(staffId: string, activeOrg: string, ttlSeconds = 3600, clientId?: string, scopes?: string[]): string {
  const payload: Record<string, unknown> = { sub: staffId, org: activeOrg }
  if (clientId) payload.cid = clientId
  if (scopes && scopes.length) payload.scp = scopes
  return jwt.sign(payload, getSecret(), { audience: MCP_AUDIENCE, expiresIn: ttlSeconds })
}

/** Verify an MCP token. Rejects any token NOT minted for the MCP audience. */
export function verifyMcpToken(token: string): McpTokenPayload {
  const decoded = jwt.verify(token, getSecret(), { audience: MCP_AUDIENCE }) as jwt.JwtPayload
  const org = (decoded as Record<string, unknown>).org
  if (!decoded.sub || typeof org !== 'string') throw new Error('Invalid MCP token payload')
  const cid = (decoded as Record<string, unknown>).cid
  const scp = (decoded as Record<string, unknown>).scp
  return {
    sub: decoded.sub,
    org,
    cid: typeof cid === 'string' ? cid : undefined,
    scp: Array.isArray(scp) ? scp.filter((s): s is string => typeof s === 'string') : undefined,
    exp: decoded.exp,
  }
}
