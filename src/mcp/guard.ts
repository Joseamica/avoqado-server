import { hasPermission } from '@/services/access/access.service'
import logger from '@/config/logger'
import type { McpScope } from './scope'

const SENSITIVE_PAYMENT_FIELDS = ['maskedPan', 'referenceNumber', 'authorizationNumber'] as const

export class ScopeError extends Error {}

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
      // OAuth scope enforcement: a WRITE action requires the mcp:write scope. Read actions
      // (:read / :view / :list) never do. Only enforced when the token actually carries scopes
      // (scope.scopes present) — dev/legacy tokens without scopes keep full access until they
      // refresh into a scoped token, so this rolls out without cutting off live connections.
      const isRead = /:(read|view|list)$/.test(permission)
      if (!isRead && scope.scopes && !scope.scopes.includes('mcp:write')) {
        logger.warn('[MCP] write blocked: token lacks mcp:write scope', {
          mcp: true,
          staffId: scope.staffId,
          activeOrg: scope.activeOrg,
          permission,
        })
        throw new ScopeError(`Esta conexión es de solo lectura (falta el scope mcp:write); "${permission}" es una acción de escritura.`)
      }
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
