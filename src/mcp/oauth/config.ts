/** Customer-MCP OAuth config. Issuer/resource come from env; sane localhost defaults for dev. */
export const MCP_ISSUER_URL = new URL(process.env.MCP_ISSUER_URL ?? 'http://localhost:12344')
export const MCP_RESOURCE_URL = new URL(process.env.MCP_RESOURCE_URL ?? `${MCP_ISSUER_URL.origin}/mcp`)

export const ACCESS_TTL_SECONDS = 3600 // 1h — short, per review §7
export const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30 // 30d
export const AUTH_CODE_TTL_SECONDS = 60 // single-use, 1 min

// The connector both READS and performs ACTIONS on the user's behalf (every write is permission-gated
// to the connected user's per-venue role, confirm-gated when high-impact, and audited). Advertise both
// so the OAuth metadata + consent are truthful — NOT read-only. (verifyAccessToken returns this set.)
export const MCP_SCOPES_SUPPORTED = ['mcp:read', 'mcp:write']
