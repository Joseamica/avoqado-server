import { hasPermission } from '@/services/access/access.service'
import type { McpScope } from './scope'

const SENSITIVE_PAYMENT_FIELDS = ['maskedPan', 'referenceNumber', 'authorizationNumber'] as const

export class ScopeError extends Error {}

export function createGuard(scope: McpScope) {
  return {
    /** The venue filter EVERY query must spread into its `where`. Throws on out-of-scope. */
    venueFilter(requestedVenueId?: string): { venueId: { in: string[] } } {
      if (requestedVenueId) {
        if (!scope.allowedVenueIds.includes(requestedVenueId)) {
          throw new ScopeError(`Venue ${requestedVenueId} is not in your scope`)
        }
        return { venueId: { in: [requestedVenueId] } }
      }
      return { venueId: { in: scope.allowedVenueIds } }
    },
    /** Gate an action by permission, evaluated for a SPECIFIC venue (roles differ per venue). */
    requirePermission(permission: string, venueId: string): void {
      const access = scope.perVenueAccess.get(venueId)
      if (!access || !hasPermission(access, permission)) {
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
