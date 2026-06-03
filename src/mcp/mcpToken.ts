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
}

/** Issue a short-lived, audience-bound MCP token. Distinct from dashboard /api/v1 tokens. */
export function issueMcpToken(staffId: string, activeOrg: string, ttlSeconds = 3600): string {
  return jwt.sign({ sub: staffId, org: activeOrg }, getSecret(), { audience: MCP_AUDIENCE, expiresIn: ttlSeconds })
}

/** Verify an MCP token. Rejects any token NOT minted for the MCP audience. */
export function verifyMcpToken(token: string): McpTokenPayload {
  const decoded = jwt.verify(token, getSecret(), { audience: MCP_AUDIENCE }) as jwt.JwtPayload
  const org = (decoded as Record<string, unknown>).org
  if (!decoded.sub || typeof org !== 'string') throw new Error('Invalid MCP token payload')
  return { sub: decoded.sub, org }
}
