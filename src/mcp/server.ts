import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { verifyMcpToken } from './mcpToken'
import { resolveScope } from './scope'
import { registerVenueTools } from './tools/venues'

/** Build a per-request MCP server bound to the caller's resolved scope. */
async function buildServerForRequest(authHeader: string | undefined): Promise<McpServer> {
  const token = (authHeader ?? '').replace(/^Bearer\s+/i, '')
  const { sub, org } = verifyMcpToken(token) // throws on bad / expired / wrong-audience token → 401 below
  const scope = await resolveScope(sub, org)

  const server = new McpServer({ name: 'avoqado-customer-mcp', version: '0.1.0' })
  registerVenueTools(server, scope)
  return server
}

/**
 * Express handler for POST /mcp (stateless per request).
 * Auth: a bearer MCP-audience token (see mcpToken.ts). Scope: per-request via resolveScope.
 */
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  try {
    const server = await buildServerForRequest(req.headers.authorization)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch {
    if (!res.headersSent) res.status(401).json({ error: 'unauthorized' })
  }
}
