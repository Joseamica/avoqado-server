import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { text } from '../context'
import { resolveActor, confirmGuard } from '../writes'
import { updateTeamMember } from '@/services/dashboard/team.dashboard.service'

const ROLES = ['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'HOST', 'VIEWER'] as const

export function registerUserTools(server: McpServer) {
  server.tool(
    'update_user',
    "Update a team member (staff) at a venue: their venue role, active flag, and/or PIN. Venue-scoped. Wraps the team service. PREVIEW unless confirm:true.",
    {
      venueId: z.string().describe('Venue the staff belongs to (use list_venues)'),
      teamMemberId: z.string().describe('The staff member id'),
      role: z.enum(ROLES).optional().describe('New venue role'),
      active: z.boolean().optional().describe('Activate (true) or deactivate (false) the member'),
      pin: z.string().optional().describe('New PIN'),
      performedBy: z.string().optional().describe('Acting staff id; defaults to MCP_ADMIN_STAFF_ID'),
      confirm: z.boolean().default(false).describe('false = preview only; true = execute'),
    },
    async ({ venueId, teamMemberId, role, active, pin, performedBy, confirm }) => {
      const actor = resolveActor(performedBy)
      if (role === undefined && active === undefined && pin === undefined) {
        return text({ error: 'Provide at least one of: role, active, pin' })
      }

      const updates: Record<string, unknown> = { performedBy: actor }
      if (role !== undefined) updates.role = role
      if (active !== undefined) updates.active = active
      if (pin !== undefined) updates.pin = pin

      return confirmGuard({
        tool: 'update_user',
        actor,
        confirm,
        // PIN is masked in the audit record.
        args: { venueId, teamMemberId, role, active, pinChanged: pin !== undefined },
        preview: {
          venue: venueId,
          teamMember: teamMemberId,
          changes: {
            ...(role !== undefined && { role }),
            ...(active !== undefined && { active }),
            ...(pin !== undefined && { pin: '*** (will change)' }),
          },
        },
        execute: () => updateTeamMember(venueId, teamMemberId, updates as never),
      })
    },
  )
}
