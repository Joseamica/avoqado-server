import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { hasPermission } from '@/services/access/access.service'

export function registerActivityLogTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'get_activity_log',
    "Audit trail for your venue(s): who did what and when — orders (comp/void/discount), payments, refunds, shifts, staff/access changes, inventory receiving and SIM custody, config changes, and manager-PIN authorizations. PAYMENT_WITHOUT_SHIFT means real money was preserved without a cash shift and data.reason distinguishes NO_SHIFT, SHIFT_NOT_OPEN, CLAIM_LOST, SALE_SHIFT_CLOSED, ORDER_AUTHORITY_UNAVAILABLE, or an unclassified historical case; it requires reconciliation. SALE_SHIFT_CLOSED = a sale a terminal recorded offline arrived after its own shift (data.saleShiftId) had been closed: it was NOT added to the new shift, and the closed shift's signed cut was not recalculated. ORDER_AUTHORITY_UNAVAILABLE means the processor may have captured money but the tenant-scoped Order lock was lost, so the requester must reconcile manually without writing into the Order’s current tenant. PERMISSION_OVERRIDE_USED = a manager authorized a blocked action for someone else, one action and one time; the approver is in data.authorizedByStaffVenueId. PERMISSION_OVERRIDE_INSUFFICIENT = someone typed a valid PIN that does NOT carry that permission — the classic internal-fraud signal. PERMISSION_OVERRIDE_REJECTED = an expired or already-used token. PERMISSION_DENIED = a plain denial, no PIN attempted — only WRITE attempts (POST/PUT/PATCH/DELETE) and cross-venue access attempts are recorded; a denied READ is the app asking for a screen the role cannot see and is deliberately not audited, since it flooded the trail and buried real events. ORDER_PREVIOUS_PRICE_HONORED = a POS sale charged the lower price the customer saw on a catalog up to 72 h old instead of today's list price; data.lineas has precioRespetado and precioActual in pesos; an entry with modifierId is an extra (modifier) of that line, priced per unit. COMANDA_OMITIDA_VENTA_TARDIA = a sale a terminal recorded offline arrived more than data.umbralMinutos after it happened, so no kitchen ticket was sent (the counter already handed the order over); data.edadMs and data.fuenteDeLaEdad say how late it was and how that was measured. VENTA_SIN_RED_RECHAZADA / VENTA_SIN_RED_REINTENTANDO / VENTA_SIN_RED_PRECIO_CAMBIADO / VENTA_SIN_RED_TURNO_CERRADO = a sale a terminal recorded offline (money already collected) reached the server with a problem, and the owners and admins got an alert: RECHAZADA = the server did not record it with an answer the terminal treats as final (it stays on the terminal as pending review and may be recorded by hand; data.motivo has the server's answer), REINTENTANDO = not recorded yet but the terminal keeps retrying on its own (a permission or session problem): fix that and it uploads by itself, never record it by hand, PRECIO_CAMBIADO = recorded but the server total no longer matches what was collected (unrecognized displayed price, balance due or overpayment), TURNO_CERRADO = recorded without shift because its own shift was already closed; entityId is the sale key (externalId) and data has terminalSerial, montoCents and orderId. Most recent first. Pass venueId to focus one venue; filter by action code or date range. Requires the activity:read permission (owner-level).",
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      action: z
        .string()
        .optional()
        .describe(
          'Filter by exact action code, e.g. PAYMENT_COMPLETED, PAYMENT_WITHOUT_SHIFT, SIM_CUSTODY_ASSIGNED_TO_PROMOTER or PERMISSION_OVERRIDE_USED (manager-PIN approvals; the approver is in data.authorizedByStaffVenueId)',
        ),
      startDate: z.string().optional().describe('ISO date lower bound (inclusive), venue-local'),
      endDate: z.string().optional().describe('ISO date upper bound (inclusive), venue-local'),
      limit: z.number().int().min(1).max(100).default(25).describe('Max rows'),
    },
    async ({ venueId, action, startDate, endDate, limit }) => {
      // Owner-only: enforce activity:read PER VENUE (mirror the dashboard endpoint gate).
      // Venue-scope isolation alone is not enough — a non-owner staff in scope must not read the audit trail.
      let venueIds: string[]
      if (venueId) {
        guard.requirePermission('activity:read', venueId) // throws if out of scope OR lacking the permission
        venueIds = [venueId]
      } else {
        venueIds = scope.allowedVenueIds.filter(v => {
          const access = scope.perVenueAccess.get(v)
          return !!access && hasPermission(access, 'activity:read')
        })
        if (venueIds.length === 0) return text({ count: 0, logs: [] })
      }

      const where: Record<string, unknown> = { venueId: { in: venueIds } }
      if (action) where.action = action
      if (startDate || endDate) {
        // Parse bare YYYY-MM-DD in the platform tz (STRING, not new Date()) so the day range is
        // host-tz-independent (prod runs UTC). See critical-warnings.md timezone trap.
        const tz = 'America/Mexico_City'
        const createdAt: Record<string, Date> = {}
        if (startDate) createdAt.gte = fromZonedTime(`${startDate}T00:00:00.000`, tz)
        if (endDate) createdAt.lte = fromZonedTime(`${endDate}T23:59:59.999`, tz)
        where.createdAt = createdAt
      }
      const logs = await prisma.activityLog.findMany({
        where: where as any,
        select: {
          id: true,
          action: true,
          entity: true,
          entityId: true,
          data: true,
          createdAt: true,
          venueId: true,
          staff: { select: { firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
      return text({ count: logs.length, logs })
    },
  )
}
