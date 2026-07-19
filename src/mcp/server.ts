import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { verifyMcpToken } from './mcpToken'
import { resolveScope, type McpScope } from './scope'
import logger from '@/config/logger'
import { moduleService, MODULE_CODES } from '@/services/modules/module.service'
import { instrumentTools } from './instrument'
import { registerVenueTools } from './tools/venues'
import { registerSalesTools } from './tools/sales'
import { registerOrderTools } from './tools/orders'
import { registerTerminalTools } from './tools/terminals'
import { registerReservationTools } from './tools/reservations'
import { registerInventoryTools } from './tools/inventory'
import { registerSerializedTools } from './tools/serialized'
import { registerProcurementTools } from './tools/procurement'
import { registerCfdiTools } from './tools/cfdi'
import { registerCommissionTools } from './tools/commissions'
import { registerSubscriptionTools } from './tools/subscriptions'
import { registerMenuTools } from './tools/menu'
import { registerStaffTools } from './tools/staff'
import { registerReviewTools } from './tools/reviews'
import { registerCustomerTools } from './tools/customers'
import { registerCustomerGroupTools } from './tools/customerGroups'
import { registerCreditPackTools } from './tools/creditPacks'
import { registerShiftTools } from './tools/shifts'
import { registerDiscountTools } from './tools/discounts'
import { registerServiceChargeTools } from './tools/service-charges'
import { registerPaymentTools } from './tools/payments'
import { registerOverviewTools } from './tools/overview'
import { registerTableTools } from './tools/tables'
import { registerFeatureTools } from './tools/features'
import { registerDeliveryChannelTools } from './tools/deliveryChannels'
import { registerDeliveryActivationTools } from './tools/deliveryActivation'
import { registerProductTools } from './tools/products'
import { registerTrendTools } from './tools/trends'
import { registerOrganizationTools } from './tools/organizations'
import { registerPaymentLinkTools } from './tools/paymentLinks'
import { registerLoyaltyTools } from './tools/loyalty'
import { registerReferralTools } from './tools/referrals'
import { registerSeatTools } from './tools/seats'
import { registerPlanAdminTools } from './tools/planAdmin'
import { registerSaleVerificationTools } from './tools/saleVerifications'
import { registerManualSaleTools } from './tools/manualSale'
import { registerPromoterLocationTools } from './tools/promoterLocation'
import { registerTerminalLocationTools } from './tools/terminalLocation'
import { registerAccountingTools } from './tools/accounting'
import { registerActivityLogTools } from './tools/activity-log'
import { registerMerchantRoutingTools } from './tools/merchantRouting'
import { registerPrinterTools } from './tools/printers'
import { registerCashOutTools } from './tools/cash-out'
import { registerWhiteLabelOpsTools } from './tools/whiteLabelOps'

/**
 * Server-level guidance the client (Claude/ChatGPT) hands to the model on every connection.
 * Born from a real incident: an operator pasted a COMBINED external sales report (Avoqado POS +
 * their own Stripe webpage + Fitpass) and the assistant summed the FILE and presented $461k as
 * "Avoqado sales" — when Avoqado had actually recorded $125k. The tools were never called. These
 * instructions make the live tools the source of truth and stop the assistant from trusting
 * pasted numbers, while setting the correct expectation about what Avoqado can and cannot see.
 */
const AVOQADO_MCP_INSTRUCTIONS = `These tools expose the LIVE data of the operator's Avoqado venues and are the SOURCE OF TRUTH for what actually happened in Avoqado (sales, payments, orders, inventory, customers, reservations, CFDI…).

When the operator asks about their real numbers:
1. ALWAYS answer by CALLING these tools. Never compute the answer from a file, screenshot, export or figure the user pasted — that data may come from another system and be wrong for Avoqado.
2. If the user provides a report/export/number, treat it as UNVERIFIED. Call the matching tool, compare, and explicitly FLAG any mismatch ("tu archivo dice X, pero en Avoqado son Y"). Never restate the file's numbers as if they were Avoqado's.
3. SCOPE — say this when it matters: Avoqado only records money that flows THROUGH Avoqado (in-person POS terminal + cash, Avoqado payment links, Avoqado-processed card/CFDI). It does NOT see the venue's OTHER systems — their own Stripe webpage, Fitpass, other apps. So a combined/external report is normally LARGER than Avoqado and will NOT reconcile; that is expected, not a data error.
4. Money is Mexican pesos in major units (e.g. 150.50, never cents). Dates are venue-local (America/Mexico_City).`

/** Flags gating PlayTelecom / white-label-only tool groups, computed once per connection. */
export interface ToolRegistrationFlags {
  serializedEnabled: boolean
  whiteLabelEnabled: boolean
}

/**
 * Register every MCP tool group onto `server` for the given scope.
 *
 * Generic tools (venues, sales, orders, inventory, …) are ALWAYS registered — they already
 * gate their own data access per-venue/per-permission at call time. The PlayTelecom / SIM
 * custody / white-label tool groups are only USEFUL to venues with those modules enabled, and
 * listing them for every other tenant is confusing catalog noise (data was never leaked — each
 * tool still gates at call-time — this only controls whether the tool is advertised at all).
 */
export function registerAllTools(server: McpServer, scope: McpScope, flags: ToolRegistrationFlags): void {
  registerVenueTools(server, scope)
  registerSalesTools(server, scope)
  registerOrderTools(server, scope)
  registerTerminalTools(server, scope)
  registerReservationTools(server, scope)
  registerInventoryTools(server, scope)
  registerProcurementTools(server, scope)
  registerCfdiTools(server, scope)
  registerCommissionTools(server, scope)
  registerSubscriptionTools(server, scope)
  registerMenuTools(server, scope)
  registerStaffTools(server, scope)
  registerReviewTools(server, scope)
  registerCustomerTools(server, scope)
  registerCustomerGroupTools(server, scope)
  registerCreditPackTools(server, scope)
  registerShiftTools(server, scope)
  registerDiscountTools(server, scope)
  registerServiceChargeTools(server, scope)
  registerPaymentTools(server, scope)
  registerOverviewTools(server, scope)
  registerTableTools(server, scope)
  registerFeatureTools(server, scope)
  registerDeliveryChannelTools(server, scope)
  registerDeliveryActivationTools(server, scope)
  registerProductTools(server, scope)
  registerTrendTools(server, scope)
  registerOrganizationTools(server, scope)
  registerPaymentLinkTools(server, scope)
  registerSeatTools(server, scope)
  registerLoyaltyTools(server, scope)
  registerReferralTools(server, scope)
  registerPlanAdminTools(server, scope)
  registerAccountingTools(server, scope)
  registerActivityLogTools(server, scope)
  registerMerchantRoutingTools(server, scope)
  registerPrinterTools(server, scope)

  if (flags.serializedEnabled) {
    registerSerializedTools(server, scope)
    registerSaleVerificationTools(server, scope)
    registerManualSaleTools(server, scope)
    registerCashOutTools(server, scope)
  }

  if (flags.whiteLabelEnabled) {
    registerPromoterLocationTools(server, scope)
    // terminal_location is white-label-only (gates on isWhiteLabelOrg at call time) — register it
    // here so non-white-label connections don't see it in their tool catalog either.
    registerTerminalLocationTools(server, scope)
    // White-label dashboard ops (attendance, presence, promoter deposits/detail, org analytics).
    registerWhiteLabelOpsTools(server, scope)
  }
}

/** Build a per-request MCP server bound to the caller's resolved scope. */
async function buildServerForIdentity(staffId: string, activeOrg: string, scopes?: string[]): Promise<McpServer> {
  const scope = await resolveScope(staffId, activeOrg)
  // Thread the connection's granted OAuth scopes onto the scope so the guard can enforce mcp:write
  // on writes. Undefined (dev/legacy token) → the guard leaves access unrestricted.
  if (scopes && scopes.length) scope.scopes = scopes

  const server = new McpServer({ name: 'avoqado-customer-mcp', version: '0.1.0' }, { instructions: AVOQADO_MCP_INSTRUCTIONS })
  instrumentTools(server, { staffId, org: activeOrg }) // log every tool call (must run BEFORE registering tools)

  const [serializedEnabled, whiteLabelEnabled] = await Promise.all([
    moduleService.anyVenueHasModule(scope.allowedVenueIds, MODULE_CODES.SERIALIZED_INVENTORY),
    moduleService.anyVenueHasModule(scope.allowedVenueIds, MODULE_CODES.WHITE_LABEL_DASHBOARD),
  ])
  registerAllTools(server, scope, { serializedEnabled, whiteLabelEnabled })
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
    let scopes: string[] | undefined
    const extra = (req as { auth?: { extra?: Record<string, unknown> } }).auth?.extra
    if (extra && typeof extra.staffId === 'string' && typeof extra.activeOrg === 'string') {
      staffId = extra.staffId
      activeOrg = extra.activeOrg
      // provider.verifyAccessToken threads the token's real granted scopes here (undefined for legacy).
      if (Array.isArray(extra.scopes)) scopes = extra.scopes.filter((s): s is string => typeof s === 'string')
    } else {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      const payload = verifyMcpToken(token) // throws on bad / expired / wrong-audience → 401 below
      staffId = payload.sub
      activeOrg = payload.org
      scopes = payload.scp
    }
    const server = await buildServerForIdentity(staffId, activeOrg, scopes)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    // The old bare `catch {}` swallowed EVERY error as a silent 401 — which made connect
    // failures invisible (a bad token and a server-side error looked identical). Log it, and
    // return 401 only for genuine auth failures; everything else (scope resolution, DB,
    // transport) is a 500 so the client doesn't get stuck re-authenticating against a server bug.
    const message = (err as Error)?.message ?? String(err)
    const isAuth = /token|unauthorized|audience|expired|jwt|invalid_grant/i.test(message)
    logger.error('[MCP] connect failed', { mcp: true, status: isAuth ? 401 : 500, message })
    if (!res.headersSent) res.status(isAuth ? 401 : 500).json({ error: isAuth ? 'unauthorized' : 'server_error' })
  }
}
