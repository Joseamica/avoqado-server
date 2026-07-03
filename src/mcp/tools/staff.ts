import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { inviteTeamMember, updateTeamMember } from '@/services/dashboard/team.dashboard.service'
import { ROLE_HIERARCHY } from '@/lib/permissions'
import { StaffRole } from '@prisma/client'

// SUPERADMIN deliberately excluded — an agent must never be able to grant it.
const INVITE_ROLE_MAP: Record<string, StaffRole> = {
  owner: StaffRole.OWNER,
  admin: StaffRole.ADMIN,
  manager: StaffRole.MANAGER,
  cashier: StaffRole.CASHIER,
  waiter: StaffRole.WAITER,
  kitchen: StaffRole.KITCHEN,
  host: StaffRole.HOST,
  viewer: StaffRole.VIEWER,
}

export function registerStaffTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_staff',
    'List the team (roster) of a venue you can access: each member\'s name, role and whether their account is active. Optionally filter by name or only active members. Pass venueId. Answers "who works here / who is on my team?". For sales performance use staff_ranking instead.',
    {
      venueId: z.string().describe('Venue whose team to list (must be in your scope)'),
      search: z.string().optional().describe('Filter by name (partial, case-insensitive)'),
      activeOnly: z.boolean().optional().describe('Only active accounts'),
      limit: z.number().int().positive().max(200).optional().describe('Max members to return (default 200)'),
    },
    async ({ venueId, search, activeOnly, limit }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('teams:read', venueId) // read gate — mirror the dashboard's checkPermission
      const rows = await prisma.staffVenue.findMany({
        where: {
          ...where,
          ...(activeOnly || search
            ? {
                staff: {
                  ...(activeOnly ? { active: true } : {}),
                  ...(search
                    ? {
                        OR: [
                          { firstName: { contains: search, mode: 'insensitive' as const } },
                          { lastName: { contains: search, mode: 'insensitive' as const } },
                        ],
                      }
                    : {}),
                },
              }
            : {}),
        },
        select: { role: true, staff: { select: { firstName: true, lastName: true, active: true } } },
        orderBy: [{ role: 'asc' }, { staff: { firstName: 'asc' } }],
        take: limit ?? 200,
      })
      return text({
        venueId,
        count: rows.length,
        staff: rows.map(r => ({ name: `${r.staff.firstName} ${r.staff.lastName}`.trim(), role: r.role, active: r.staff.active })),
      })
    },
  )

  server.tool(
    'staff_detail',
    'Detail of ONE team member of a venue you can access, found by name: their account status and the role they hold at EACH of your venues where they work. The drill-down after list_staff — answers "¿qué rol tiene Juan? ¿en qué locales trabaja? ¿está activo?". Does NOT expose contact details (email/phone). If the name matches several people it returns them so you can be specific. Pass venueId + name.',
    {
      venueId: z.string().describe('Venue to search within (must be in your scope)'),
      name: z.string().min(1).describe('Team member name or part of it'),
    },
    async ({ venueId, name }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('teams:read', venueId) // read gate — mirror the dashboard's checkPermission
      const matches = await prisma.staffVenue.findMany({
        where: {
          ...base,
          staff: {
            OR: [
              { firstName: { contains: name, mode: 'insensitive' as const } },
              { lastName: { contains: name, mode: 'insensitive' as const } },
            ],
          },
        },
        select: { staffId: true, staff: { select: { firstName: true, lastName: true, active: true } } },
        take: 5,
      })
      if (matches.length === 0) {
        return text({ found: false, error: `No encontré ningún miembro del equipo que coincida con "${name}" en este local.` })
      }
      if (matches.length > 1) {
        return text({
          found: false,
          ambiguous: true,
          error: `"${name}" coincide con varias personas — sé más específico.`,
          matches: matches.map(m => `${m.staff.firstName} ${m.staff.lastName}`.trim()),
        })
      }

      const m = matches[0]
      // The role they hold at each of the CALLER's venues (scope-limited — never reveals venues outside scope).
      const assignments = await prisma.staffVenue.findMany({
        where: { staffId: m.staffId, ...guard.venueFilter() },
        select: { role: true, venue: { select: { name: true } } },
        orderBy: { venue: { name: 'asc' } },
      })
      return text({
        found: true,
        staff: { name: `${m.staff.firstName} ${m.staff.lastName}`.trim(), active: m.staff.active },
        venues: assignments.map(a => ({ venue: a.venue?.name ?? null, role: a.role })),
      })
    },
  )

  server.tool(
    'invite_staff',
    '🔴 CRITICAL (grants access). Invite a NEW team member to a venue you can access — sends them an invitation (email when an email is given). By DEFAULT this only PREVIEWS the invite; to actually send it you must call again with confirm:true. Pass first/last name, their role, and optionally an email + message. SUPERADMIN cannot be granted here. This WRITES — requires teams:invite.',
    {
      venueId: z.string().describe('Venue to invite into (must be in your scope)'),
      firstName: z.string().min(1).describe('First name'),
      lastName: z.string().min(1).describe('Last name'),
      role: z
        .enum(['owner', 'admin', 'manager', 'cashier', 'waiter', 'kitchen', 'host', 'viewer'])
        .describe('Role to grant (no superadmin)'),
      email: z.string().optional().describe('Email to send the invitation to'),
      message: z.string().optional().describe('Optional personal message in the invite'),
      confirm: z.boolean().optional().describe('Must be true to actually send the invite; without it you get a preview'),
    },
    async ({ venueId, firstName, lastName, role, email, message, confirm }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('teams:invite', venueId) // write gate (per-venue role)
      const mappedRole = INVITE_ROLE_MAP[role]

      // Role ceiling: the AI can never grant a role ABOVE the connected user's own
      // role at this venue (least-privilege on the LLM surface). teams:invite alone
      // would otherwise let a MANAGER mint an OWNER/ADMIN. requirePermission already
      // proved an access entry exists for this venue, so callerRole is defined.
      const callerLevel = ROLE_HIERARCHY[scope.perVenueAccess.get(venueId)?.role as StaffRole] ?? 0
      if ((ROLE_HIERARCHY[mappedRole] ?? 0) > callerLevel) {
        return text({
          ok: false,
          error: `No puedes otorgar el rol ${mappedRole}: es superior a tu propio rol. Solo puedes invitar con un rol igual o menor al tuyo.`,
        })
      }

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { name: `${firstName} ${lastName}`.trim(), role: mappedRole, email: email ?? null },
          message: `Esto INVITARÁ a ${firstName} ${lastName} como ${mappedRole}${email ? ` y le enviará un correo a ${email}` : ''}. Vuelve a llamar con confirm:true para enviar.`,
        })
      }

      try {
        const result = await inviteTeamMember(venueId, scope.staffId, {
          firstName,
          lastName,
          role: mappedRole,
          ...(email ? { email } : {}),
          ...(message ? { message } : {}),
        })
        await auditMcpWrite(scope, {
          action: 'STAFF_INVITED',
          entity: 'Invitation',
          entityId: (result.invitation as { id?: string } | null)?.id ?? 'invitation',
          venueId,
          data: { name: `${firstName} ${lastName}`.trim(), role: mappedRole, email: email ?? null, emailSent: result.emailSent },
        })
        return text({
          ok: true,
          invited: {
            name: `${firstName} ${lastName}`.trim(),
            role: mappedRole,
            emailSent: result.emailSent,
            inviteLink: result.inviteLink ?? null,
          },
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'update_staff_member',
    "🔴 CRITICAL (changes access). Change a team member's ROLE and/or ACTIVATE/DEACTIVATE them in a venue you can access, found by name. Deactivating blocks their access (it does NOT delete them); the service refuses to remove the last administrator. SUPERADMIN cannot be granted. By DEFAULT this only PREVIEWS the change (current → new); to apply it call again with confirm:true. This WRITES — requires teams:update.",
    {
      venueId: z.string().describe('Venue where the member works (must be in your scope)'),
      name: z.string().min(1).describe('Team member name or part of it'),
      role: z
        .enum(['owner', 'admin', 'manager', 'cashier', 'waiter', 'kitchen', 'host', 'viewer'])
        .optional()
        .describe('New role (omit to keep; no superadmin)'),
      active: z.boolean().optional().describe('true = activate, false = deactivate (omit to keep)'),
      confirm: z.boolean().optional().describe('Must be true to actually apply; without it you get a preview'),
    },
    async ({ venueId, name, role, active, confirm }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('teams:update', venueId) // write gate (per-venue role)
      if (role === undefined && active === undefined) return text({ ok: false, error: 'Pasa al menos role o active.' })

      const matches = await prisma.staffVenue.findMany({
        where: {
          ...base,
          staff: {
            OR: [
              { firstName: { contains: name, mode: 'insensitive' as const } },
              { lastName: { contains: name, mode: 'insensitive' as const } },
            ],
          },
        },
        select: { id: true, staffId: true, role: true, staff: { select: { firstName: true, lastName: true, active: true } } },
        take: 5,
      })
      if (matches.length === 0) return text({ ok: false, error: `No encontré ningún miembro que coincida con "${name}" en este local.` })
      if (matches.length > 1) {
        return text({
          ok: false,
          ambiguous: true,
          error: `"${name}" coincide con varias personas — sé más específico.`,
          matches: matches.map(m => `${m.staff.firstName} ${m.staff.lastName}`.trim()),
        })
      }

      const m = matches[0]
      const fullName = `${m.staff.firstName} ${m.staff.lastName}`.trim()
      const newRole = role ? INVITE_ROLE_MAP[role] : undefined

      // Role ceiling (least-privilege on the LLM surface). requirePermission already
      // proved an access entry exists for this venue, so callerLevel is defined.
      //   1. can't change your OWN role/status via the agent (self-escalation),
      //   2. can't manage a member who already OUTRANKS you,
      //   3. can't GRANT a role above your own.
      const callerLevel = ROLE_HIERARCHY[scope.perVenueAccess.get(venueId)?.role as StaffRole] ?? 0
      if (m.staffId === scope.staffId) {
        return text({ ok: false, error: 'No puedes cambiar tu propio rol o estado desde el agente. Pídeselo a otro administrador.' })
      }
      if ((ROLE_HIERARCHY[m.role] ?? 0) > callerLevel) {
        return text({ ok: false, error: `No puedes modificar a ${fullName}: su rol (${m.role}) es superior al tuyo.` })
      }
      if (newRole && (ROLE_HIERARCHY[newRole] ?? 0) > callerLevel) {
        return text({ ok: false, error: `No puedes otorgar el rol ${newRole}: es superior a tu propio rol.` })
      }

      const changes = {
        ...(newRole && newRole !== m.role ? { role: { from: m.role, to: newRole } } : {}),
        ...(active !== undefined && active !== m.staff.active ? { active: { from: m.staff.active, to: active } } : {}),
      }
      if (Object.keys(changes).length === 0) return text({ ok: false, error: `${fullName} ya está exactamente así — nada que cambiar.` })

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { member: fullName, changes },
          message: `Esto CAMBIARÁ a ${fullName}: ${JSON.stringify(changes)}. Vuelve a llamar con confirm:true para aplicar.`,
        })
      }

      try {
        await updateTeamMember(venueId, m.id, {
          ...(newRole ? { role: newRole } : {}),
          ...(active !== undefined ? { active } : {}),
          performedBy: scope.staffId,
        })
        await auditMcpWrite(scope, {
          action: 'STAFF_MEMBER_UPDATED',
          entity: 'StaffVenue',
          entityId: m.id,
          venueId,
          data: { member: fullName, changes },
        })
        return text({ ok: true, member: fullName, applied: changes })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
