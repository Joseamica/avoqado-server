import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { verifyMcpToken } from './mcpToken'
import { resolveScope } from './scope'
import { instrumentTools } from './instrument'
import { registerVenueTools } from './tools/venues'
import { registerSalesTools } from './tools/sales'
import { registerOrderTools } from './tools/orders'
import { registerTerminalTools } from './tools/terminals'
import { registerReservationTools } from './tools/reservations'
import { registerInventoryTools } from './tools/inventory'
import { registerCfdiTools } from './tools/cfdi'
import { registerCommissionTools } from './tools/commissions'
import { registerSubscriptionTools } from './tools/subscriptions'
import { registerMenuTools } from './tools/menu'
import { registerStaffTools } from './tools/staff'
import { registerReviewTools } from './tools/reviews'
import { registerCustomerTools } from './tools/customers'
import { registerShiftTools } from './tools/shifts'
import { registerDiscountTools } from './tools/discounts'
import { registerPaymentTools } from './tools/payments'
import { registerOverviewTools } from './tools/overview'
import { registerTableTools } from './tools/tables'
import { registerFeatureTools } from './tools/features'
import { registerProductTools } from './tools/products'
import { registerTrendTools } from './tools/trends'
import { registerOrganizationTools } from './tools/organizations'
import { registerPaymentLinkTools } from './tools/paymentLinks'
import { registerLoyaltyTools } from './tools/loyalty'
import { registerSeatTools } from './tools/seats'
import { registerPlanAdminTools } from './tools/planAdmin'

/** Build a per-request MCP server bound to the caller's resolved scope. */
async function buildServerForIdentity(staffId: string, activeOrg: string): Promise<McpServer> {
  const scope = await resolveScope(staffId, activeOrg)

  const server = new McpServer({ name: 'avoqado-customer-mcp', version: '0.1.0' })
  instrumentTools(server, { staffId, org: activeOrg }) // log every tool call (must run BEFORE registering tools)
  registerVenueTools(server, scope)
  registerSalesTools(server, scope)
  registerOrderTools(server, scope)
  registerTerminalTools(server, scope)
  registerReservationTools(server, scope)
  registerInventoryTools(server, scope)
  registerCfdiTools(server, scope)
  registerCommissionTools(server, scope)
  registerSubscriptionTools(server, scope)
  registerMenuTools(server, scope)
  registerStaffTools(server, scope)
  registerReviewTools(server, scope)
  registerCustomerTools(server, scope)
  registerShiftTools(server, scope)
  registerDiscountTools(server, scope)
  registerPaymentTools(server, scope)
  registerOverviewTools(server, scope)
  registerTableTools(server, scope)
  registerFeatureTools(server, scope)
  registerProductTools(server, scope)
  registerTrendTools(server, scope)
  registerOrganizationTools(server, scope)
  registerPaymentLinkTools(server, scope)
  registerSeatTools(server, scope)
  registerLoyaltyTools(server, scope)
  registerPlanAdminTools(server, scope)
  return server
}

/**
 * Express handler for POST /mcp (stateless per request).
 * Phase 1: requireBearerAuth populated req.auth.extra ({ staffId, activeOrg }) via
 * provider.verifyAccessToken. Phase-0 dev server passes a raw bearer header instead.
 */
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  try {
    let staffId: string
    let activeOrg: string
    const extra = (req as { auth?: { extra?: Record<string, unknown> } }).auth?.extra
    if (extra && typeof extra.staffId === 'string' && typeof extra.activeOrg === 'string') {
      staffId = extra.staffId
      activeOrg = extra.activeOrg
    } else {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      const payload = verifyMcpToken(token) // throws on bad / expired / wrong-audience → 401 below
      staffId = payload.sub
      activeOrg = payload.org
    }
    const server = await buildServerForIdentity(staffId, activeOrg)
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
