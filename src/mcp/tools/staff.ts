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
import { DateTime } from 'luxon'

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
    'who_is_late_now',
    'Who SHOULD already be at work RIGHT NOW and has not clocked in yet, for ONE venue. Answers "\u00bfya llegaron todos?", "\u00bfqui\u00e9n falta?", "\u00bfqui\u00e9n falta por llegar?" while the day is still happening \u2014 the attendance report answers the same question AFTER the fact. Uses the venue schedule (fixed roster, rotating shifts and exceptions) plus the venue tolerance in minutes; someone without a schedule is never judged, and a day off is never judged. Read-only.',
    {
      venueId: z.string().describe('Venue (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('attendance:read', venueId)
      const { quienVaTarde } = await import('../../services/dashboard/attendanceLiveAlert')
      return text(await quienVaTarde(venueId, new Date()))
    },
  )

  server.tool(
    'work_shifts',
    'Rotating WORK shifts (fase 1 "como Sesame"): the venue\'s shift templates (e.g. Abre 08–16, Cierre 11–19) and the person×day assignments for a date range (max 31 days), with DRAFT/PUBLISHED status. Only PUBLISHED assignments count for attendance and commissions, and only when the venue enabled rotating shifts. Read-only. Pass venueId, from and to (YYYY-MM-DD).',
    {
      venueId: z.string().describe('Venue (must be in your scope)'),
      from: z.string().describe('Start date YYYY-MM-DD'),
      to: z.string().describe('End date YYYY-MM-DD (max 31 days)'),
    },
    async ({ venueId, from, to }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('attendance:read', venueId)
      const { listTemplates, getAssignments } = await import('../../services/dashboard/workShift.service')
      const settings = await prisma.venueSettings.findUnique({ where: { venueId }, select: { rotatingShiftsEnabled: true } })
      const [templates, assignments] = await Promise.all([listTemplates(venueId, true), getAssignments(venueId, from, to)])
      return text({ venueId, rotatingShiftsEnabled: settings?.rotatingShiftsEnabled ?? false, templates, assignments })
    },
  )

  server.tool(
    'list_staff',
    'List the team (roster) of a venue you can access: each member\'s membership id, staff id, name, role and whether their account is active. The IDs can be passed to reservation staff/schedule tools. Optionally filter by name or only active members. Pass venueId. Answers "who works here / who is on my team?". For sales performance use staff_ranking instead.',
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
        select: { id: true, staffId: true, role: true, staff: { select: { firstName: true, lastName: true, active: true } } },
        orderBy: [{ role: 'asc' }, { staff: { firstName: 'asc' } }],
        take: limit ?? 200,
      })
      return text({
        venueId,
        count: rows.length,
        staff: rows.map(r => ({
          staffVenueId: r.id,
          staffId: r.staffId,
          name: `${r.staff.firstName} ${r.staff.lastName}`.trim(),
          role: r.role,
          active: r.staff.active,
        })),
      })
    },
  )

  server.tool(
    'attendance_payroll_summary',
    "Fase 3 del checador — payroll bridge for ONE venue: per-person period numbers a payroll needs (scheduled/worked days, late days + minutes, absences BY TYPE — vacation, paid/unpaid leave, sick leave, justified — and worked hours). ALSO returns OVERTIME per Mexican labour law (LFT art. 66-68). Overtime is AUTHORIZED, not automatic: overtimeMinutes is what the clock MEASURED, and it splits into overtimeApprovedMinutes (someone signed off), overtimePendingMinutes (nobody has reviewed it yet — chase these, unpaid hours must never be invisible) and overtimeDeniedMinutes (reviewed and refused). ONLY the approved minutes are paid, so overtimeDoubleMinutes (first 9 h of EACH week, art. 67) and overtimeTripleMinutes (the excess, art. 68) are computed on the APPROVED total, and overtimeWeeks is its week-by-week breakdown. hasOvertimeViolation is computed on what was MEASURED instead, because breaking the art. 66 caps (over 3 h in one day, or overtime on more than 3 days) already happened whether or not it got authorized. overtimeDaysToReview lists days whose clock-out changed AFTER being authorized. Overtime counts ONLY time worked AFTER the scheduled end, minus breaks taken in that window — arriving early is not overtime. A week the requested range does not fully cover is flagged `parcial`: its double/triple split is not final. Returns MINUTES, never pesos — the hourly wage lives in the venue's payroll system. Use approve_overtime to authorize. Same permission as the dashboard payroll view.",
    {
      venueId: z.string().describe('Venue whose payroll summary to read (must be in your scope)'),
      startDate: z.string().describe('Period start, YYYY-MM-DD (venue-local)'),
      endDate: z.string().describe('Period end, YYYY-MM-DD (max 92 days)'),
    },
    async ({ venueId, startDate, endDate }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('attendance:read', venueId)
      const { getPayrollSummary } = await import('../../services/dashboard/attendancePayroll.service')
      const summary = await getPayrollSummary(venueId, startDate, endDate)
      return text(summary)
    },
  )

  server.tool(
    'approve_overtime',
    'Authorize the overtime worked by ONE person on ONE day, so it can be paid. Mexican labour law (LFT art. 66-68) — the founder decided overtime is NOT paid just because the clock measured it: someone authorizes it, and only the authorized minutes enter the double/triple split. You may authorize LESS than measured (partial: "she stayed 2 h, I approve 1 h") but NEVER more — the server recomputes what the clock actually measured and rejects anything above it. Authorizing 0 means reviewed and DENIED, which is different from not reviewed (no record) — unreviewed overtime shows up as PENDING in attendance_payroll_summary so unpaid hours can never be invisible. Re-authorizing the same day CORRECTS the previous decision, it does not add to it. Two-step: the first call returns a preview, and only a second call with confirm:true writes.',
    {
      venueId: z.string().describe('Venue where the person works (must be in your scope)'),
      staffVenueId: z.string().describe('Membership id of the person (staffVenueId from attendance_payroll_summary), NOT the staffId'),
      date: z.string().describe('Day of the SHIFT, YYYY-MM-DD (venue-local)'),
      minutesApproved: z.number().int().min(0).describe('Minutes to authorize. 0 = reviewed and denied'),
      note: z.string().max(500).optional().describe('Why (optional) — kept in the audit trail'),
      confirm: z.boolean().optional().describe('Set true to actually write; without it you get a preview'),
    },
    async ({ venueId, staffVenueId, date, minutesApproved, note, confirm }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      // Firmar lo que se paga NO es leer un reporte: `:manage`, que los roles de piso no tienen.
      guard.requirePermission('attendance:manage', venueId)

      const { approveOvertime } = await import('../../services/dashboard/overtimeApproval.service')

      // Confirmación de dos pasos: esto decide cuánto se le paga a una persona, y lo dispara un
      // modelo interpretando una petición vaga. La vista previa enseña el ANTES y el DESPUÉS.
      if (!confirm) {
        const { buildAttendanceGrid } = await import('../../services/dashboard/attendance.dashboard.service')
        const { cells } = await buildAttendanceGrid(venueId, date, date)
        const celda = cells.find(c => c.staffVenueId === staffVenueId && c.date === date)
        if (!celda) return text({ ok: false, error: 'No encontré a esa persona ese día en este negocio.' })
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            persona: celda.name,
            dia: date,
            minutosMedidos: celda.overtimeMinutes,
            minutosAAutorizar: minutesApproved,
          },
          message:
            `Vas a autorizar ${minutesApproved} de los ${celda.overtimeMinutes} minutos extra que ` +
            `${celda.name} trabajó el ${date}. Eso es lo que entrará al pago doble/triple. ` +
            `Confirma con confirm:true.`,
        })
      }

      const r = await approveOvertime({
        venueId,
        staffVenueId,
        date,
        minutesApproved,
        approvedById: scope.staffId,
        note,
      })
      return text({ ok: true, ...r })
    },
  )

  server.tool(
    'venue_attendance',
    'Attendance (time clock) of ONE venue you can access: who is clocked in RIGHT NOW, and the clock-in/clock-out records for a date range with hours worked, break minutes and whether a manager already approved or rejected each one. Answers "\u00bfqui\u00e9n est\u00e1 trabajando ahora?", "\u00bfa qu\u00e9 hora lleg\u00f3 Ana?", "\u00bfqu\u00e9 checadas faltan por aprobar?". Staff clock in on the venue terminal or app \u2014 this tool only READS. Pass venueId; omit dates for today. For an ORGANIZATION-wide roll-up with late/absent status, white-label operators have staff_attendance instead.',
    {
      venueId: z.string().describe('Venue whose attendance to read (must be in your scope)'),
      onlyActive: z.boolean().optional().describe('Only who is clocked in right now (ignores the date range)'),
      startDate: z.string().optional().describe('Range start, YYYY-MM-DD (defaults to today)'),
      endDate: z.string().optional().describe('Range end, YYYY-MM-DD (defaults to today)'),
      pendingOnly: z.boolean().optional().describe('Only finished shifts still awaiting a manager decision'),
      limit: z.number().int().positive().max(200).optional().describe('Max records to return (default 100)'),
    },
    async ({ venueId, onlyActive, startDate, endDate, pendingOnly, limit }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      // Same gate as the dashboard route: the roles that review attendance, not the ones that clock in.
      guard.requirePermission('tpv-time-entries:read', venueId)

      if (onlyActive) {
        const active = await prisma.timeEntry.findMany({
          where: { ...where, status: { in: ['CLOCKED_IN', 'ON_BREAK'] } },
          select: { id: true, clockInTime: true, status: true, staff: { select: { firstName: true, lastName: true } } },
          orderBy: { clockInTime: 'asc' },
        })
        return text({
          venueId,
          count: active.length,
          onShift: active.map(e => ({
            timeEntryId: e.id,
            name: `${e.staff.firstName} ${e.staff.lastName}`.trim(),
            since: e.clockInTime,
            onBreak: e.status === 'ON_BREAK',
          })),
        })
      }

      const venue = startDate || endDate ? await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }) : null
      const timezone = venue?.timezone || 'America/Mexico_City'
      const from = startDate ? DateTime.fromISO(startDate, { zone: timezone }).startOf('day').toJSDate() : undefined
      const to = endDate ? DateTime.fromISO(endDate, { zone: timezone }).endOf('day').toJSDate() : undefined

      const rows = await prisma.timeEntry.findMany({
        where: {
          ...where,
          ...(from || to ? { clockInTime: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
          ...(pendingOnly ? { validationStatus: 'PENDING', clockOutTime: { not: null } } : {}),
        },
        select: {
          id: true,
          clockInTime: true,
          clockOutTime: true,
          totalHours: true,
          breakMinutes: true,
          status: true,
          validationStatus: true,
          autoClockOut: true,
          staff: { select: { firstName: true, lastName: true } },
        },
        orderBy: { clockInTime: 'desc' },
        take: limit ?? 100,
      })

      return text({
        venueId,
        count: rows.length,
        entries: rows.map(r => ({
          timeEntryId: r.id,
          name: `${r.staff.firstName} ${r.staff.lastName}`.trim(),
          clockIn: r.clockInTime,
          clockOut: r.clockOutTime,
          hours: r.totalHours == null ? null : Number(r.totalHours),
          breakMinutes: r.breakMinutes ?? 0,
          stillIn: r.clockOutTime === null,
          autoClosedBySystem: r.autoClockOut,
          review: r.validationStatus,
        })),
      })
    },
  )

  server.tool(
    'staff_documents',
    'Documents on file for ONE team member of a venue you can access: type (ID, CURP, social security, contract, certification…), file name, who uploaded it, when, and its expiry date if it has one. 🔴 This is an EXPENSE of TRUST: the underlying files are personal data, so this tool returns only the METADATA — never the file contents or a download link. Answers "\u00bfya tenemos el contrato de Ana?", "\u00bfa qui\u00e9n le vence un certificado?". Requires the dedicated staff-documents:read permission (OWNER/ADMIN), NOT teams:read. Pass venueId + staffId.',
    {
      venueId: z.string().describe('Venue the person works at (must be in your scope)'),
      staffId: z.string().describe('Staff id, from list_staff'),
      expiringOnly: z.boolean().optional().describe('Only documents with an expiry date already set'),
    },
    async ({ venueId, staffId, expiringOnly }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      // Puerta propia: `teams:read` la tiene MANAGER, y un gerente no debe leer el
      // expediente de sus compañeros ni siquiera a través de un agente.
      guard.requirePermission('staff-documents:read', venueId)

      const docs = await prisma.staffDocument.findMany({
        where: {
          ...where,
          staffId,
          deletedAt: null,
          ...(expiringOnly ? { expiresAt: { not: null } } : {}),
        },
        select: {
          id: true,
          type: true,
          label: true,
          fileName: true,
          expiresAt: true,
          createdAt: true,
          uploadedBy: { select: { firstName: true, lastName: true } },
        },
        orderBy: [{ type: 'asc' }, { createdAt: 'desc' }],
      })

      return text({
        venueId,
        staffId,
        count: docs.length,
        // Deliberadamente SIN fileUrl: el agente sabe QUE existe, no puede abrirlo.
        documents: docs.map(d => ({
          documentId: d.id,
          type: d.type,
          label: d.label,
          fileName: d.fileName,
          expiresAt: d.expiresAt,
          uploadedAt: d.createdAt,
          uploadedBy: d.uploadedBy ? `${d.uploadedBy.firstName} ${d.uploadedBy.lastName}`.trim() : null,
        })),
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
