import { hasPermission } from '@/services/access/access.service'
import logger from '@/config/logger'
import type { McpScope } from './scope'

const SENSITIVE_PAYMENT_FIELDS = ['maskedPan', 'referenceNumber', 'authorizationNumber'] as const

export class ScopeError extends Error {}

/**
 * OAuth scope enforcement: a WRITE action requires the mcp:write scope. Read actions
 * (:read / :view / :list) never do. Only relevant when the token actually carries scopes
 * (scope.scopes present) — dev/legacy tokens without scopes keep full access.
 *
 * OBSERVE-ONLY BY DEFAULT: to de-risk rollout we only LOG what WOULD be blocked (with the
 * granted scopes) unless MCP_ENFORCE_WRITE_SCOPE=true. Deploy → watch logs to confirm real
 * Claude/ChatGPT clients actually request mcp:write (no legit writes appear in the "would be
 * blocked" line) → THEN flip the flag on. This way a client that unexpectedly requests
 * read-only can't silently break writes for everyone the moment we ship.
 *
 * Exported (not just embedded in requirePermission) so ORG-level write gates — which have no
 * single venueId to hand to requirePermission (saleVerifications' requireOrgPermission,
 * manualSale's requireManualSaleAccess) — participate in the same kill-switch. Without this,
 * flipping MCP_ENFORCE_WRITE_SCOPE would block venue writes but let the highest-risk org
 * writes (approve/reopen/edit a sale) through.
 */
export function enforceWriteScope(scope: McpScope, permission: string): void {
  const isRead = /:(read|view|list)$/.test(permission)
  if (!isRead && scope.scopes && !scope.scopes.includes('mcp:write')) {
    const enforce = process.env.MCP_ENFORCE_WRITE_SCOPE === 'true'
    logger.warn(
      enforce
        ? '[MCP] write blocked: token lacks mcp:write scope'
        : '[MCP] write would be blocked (observe-only): token lacks mcp:write scope',
      {
        mcp: true,
        staffId: scope.staffId,
        activeOrg: scope.activeOrg,
        permission,
        grantedScopes: scope.scopes,
        enforced: enforce,
      },
    )
    if (enforce) {
      throw new ScopeError(`Esta conexión es de solo lectura (falta el scope mcp:write); "${permission}" es una acción de escritura.`)
    }
  }
}

export function createGuard(scope: McpScope) {
  return {
    /** The venue filter EVERY query must spread into its `where`. Throws on out-of-scope. */
    venueFilter(requestedVenueId?: string): { venueId: { in: string[] } } {
      if (requestedVenueId) {
        if (!scope.allowedVenueIds.includes(requestedVenueId)) {
          // Visible-in-logs (alertable) denial. The MCP is LLM-driven, so a spike of
          // out-of-scope venue attempts = probing worth surfacing. Not persisted to
          // ActivityLog on purpose (hot path; would flood the audit trail).
          logger.warn('[MCP] venue out of scope (denied)', {
            mcp: true,
            staffId: scope.staffId,
            activeOrg: scope.activeOrg,
            requestedVenueId,
          })
          throw new ScopeError(
            `Venue ${requestedVenueId} is not in your scope. Esta conexión está limitada a tu organización activa — usa list_my_organizations para ver tus organizaciones; si el venue pertenece a otra, desconecta y vuelve a conectar eligiéndola. NO uses otro venue como sustituto.`,
          )
        }
        return { venueId: { in: [requestedVenueId] } }
      }
      return { venueId: { in: scope.allowedVenueIds } }
    },
    /** Gate an action by permission, evaluated for a SPECIFIC venue (roles differ per venue). */
    requirePermission(permission: string, venueId: string): void {
      enforceWriteScope(scope, permission)
      const access = scope.perVenueAccess.get(venueId)
      if (!access || !hasPermission(access, permission)) {
        // Visible-in-logs (alertable) denial; a spike = an LLM probing for access.
        // Winston only (not ActivityLog) — hot path, keep the audit trail clean.
        logger.warn('[MCP] permission denied', {
          mcp: true,
          staffId: scope.staffId,
          activeOrg: scope.activeOrg,
          permission,
          venueId,
        })
        throw new ScopeError(`Missing permission ${permission} for venue ${venueId}`)
      }
    },
    /** Strip sensitive payment fields before any result leaves for the LLM vendor. */
    redact<T>(rows: T[]): T[] {
      return rows.map(row => {
        const copy = { ...(row as Record<string, unknown>) }
        for (const f of SENSITIVE_PAYMENT_FIELDS) delete copy[f]
        return copy as T
      })
    },
  }
}
