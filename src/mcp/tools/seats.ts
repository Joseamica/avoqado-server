import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { getVenueSeatStatus, getDowngradePreview, scheduleDowngradeToFree } from '@/services/dashboard/seatReconciliation.service'

/**
 * MCP tools for the Free-tier seat cap + Pro→Free downgrade reconciliation:
 *  - get_venue_seat_status     (read)  — cap / current / can-add / exempt
 *  - get_venue_downgrade_preview (read) — who'd be affected by a downgrade
 *  - downgrade_venue_to_free   (write) — schedule the downgrade keeping ≤2 users
 * Kept in lockstep with the dashboard plan portal + seatReconciliation.service.
 */
export function registerSeatTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'get_venue_seat_status',
    'Free-tier user-seat status for a venue you can access: the seat cap (null = unlimited on a paid plan or grandfathered venue), how many seats are in use right now broken down into ACTIVE non-support users and OUTSTANDING (pending, not-yet-expired) invitations, the combined total, whether another user can still be invited/added, and whether the venue is exempt (grandfathered) from the cap. Pending invitations COUNT against the cap (a venue at the cap via pending invites can\'t send more). Answers "¿cuántos usuarios puedo tener? ¿ya llegué al límite (contando invitaciones pendientes)? ¿puedo agregar a alguien más?". Pass venueId. Read-only — does not add, remove or change any user.',
    {
      venueId: z.string().describe('Venue whose seat status to read (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const status = await getVenueSeatStatus(venueId)
      return text({
        venueId,
        cap: status.cap, // null = unlimited (paid plan or grandfathered)
        active: status.active, // active, non-SUPERADMIN users
        pending: status.pending, // outstanding (pending, not-yet-expired) invitations — also count against the cap
        current: status.current, // active + pending — total seats counting against the cap
        allowed: status.allowed, // whether one more seat can be added/invited right now
        exempt: status.exempt, // grandfathered → cap never enforced
      })
    },
  )

  server.tool(
    'get_venue_downgrade_preview',
    'Preview what a Pro→Free downgrade would require for a venue you can access. Free allows only 2 active users; if the venue has more, the owner must choose who stays and the rest get DEACTIVATED (not deleted) when the paid period ends. Returns whether a choice is required, the cap, the current active-user count, the max you may keep, and the roster to pick from (the OWNER is flagged isOwner and is always kept). Read-only — schedules nothing. To actually downgrade, use downgrade_venue_to_free.',
    {
      venueId: z.string().describe('Venue to preview the downgrade for (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId) // throws ScopeError if out of scope
      const preview = await getDowngradePreview(venueId)
      return text(preview)
    },
  )

  server.tool(
    'downgrade_venue_to_free',
    'Schedule a Pro→Free downgrade for a venue you can access, choosing which users stay. The paid plan is canceled at PERIOD END (the venue keeps Pro until then); when it drops to Free, every active user NOT in keepStaffVenueIds is DEACTIVATED (not deleted — reactivated if they return to Pro). Free cap is 2 users; the OWNER must be included and is always kept. Reactivating the plan before period end cancels this. This WRITES — requires billing:subscriptions:manage. Call get_venue_downgrade_preview first to get the roster (staffVenueId values) and whether a choice is required. Returns the updated plan state.',
    {
      venueId: z.string().describe('Venue to downgrade (must be in your scope)'),
      keepStaffVenueIds: z
        .array(z.string())
        .describe(
          'staffVenueId values to KEEP active on Free (≤2, MUST include the owner). Empty only when the venue is already at/under the cap.',
        ),
      confirm: z.boolean().optional().describe('Must be true to actually schedule the downgrade; without it you get a preview'),
    },
    async ({ venueId, keepStaffVenueIds, confirm }) => {
      guard.venueFilter(venueId) // throws ScopeError if out of scope
      guard.requirePermission('billing:subscriptions:manage', venueId) // write gate (per-venue role)
      if (!confirm) {
        // High-impact (plan/billing + deactivates users) → never act on a vague request without confirmation.
        return text({
          ok: false,
          requiresConfirmation: true,
          change: { label: 'Plan', from: 'PRO', to: 'FREE (al fin del periodo)', keepUsers: keepStaffVenueIds.length },
          message: `Esto AGENDARÁ la baja del plan PRO → FREE al FIN DEL PERIODO. Mantendrá ${keepStaffVenueIds.length} usuario(s) activo(s); el resto se DESACTIVA (reversible si vuelves a PRO). Revisa el roster con get_venue_downgrade_preview, confirma con el operador, y vuelve a llamar con confirm:true.`,
        })
      }
      try {
        const planState = await scheduleDowngradeToFree(venueId, keepStaffVenueIds)
        await auditMcpWrite(scope, {
          action: 'PLAN_DOWNGRADE_SCHEDULED',
          entity: 'Venue',
          entityId: venueId,
          venueId,
          data: { keepStaffVenueIds, tier: 'FREE' },
        })
        return text({ ok: true, planState })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
