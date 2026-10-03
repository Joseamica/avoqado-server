import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { hasPermission } from '@/services/access/access.service'
import { venueHasServicePayAccess } from '@/services/dashboard/staffPay/acceso'
import { detallePersona, reportePeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { listarNiveles, nivelesVigentes } from '@/services/dashboard/staffPay/niveles.service'
import { listarTablas } from '@/services/dashboard/staffPay/tablas.service'
import { hoyLocal } from '@/services/dashboard/staffPay/periodos'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

const sedeArg = z.string().min(1).max(64).optional().describe('Only this venue of the organization (default: all venues you can read)')
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Any day inside the pay period, YYYY-MM-DD venue-local (default: today)')

export function registerStaffPayTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  const puedeLeer = async (venueId: string): Promise<string | null> => {
    guard.venueFilter(venueId) // lanza si la sede está fuera del alcance
    const access = scope.perVenueAccess.get(venueId)
    if (!access || !hasPermission(access, 'staffpay:read')) return 'Necesitas el permiso staffpay:read en esta sede.'
    if (!(await venueHasServicePayAccess(venueId))) return 'Pago por servicio no está activo en este negocio; pídelo a Avoqado.'
    return null
  }

  server.tool(
    'staff_service_pay_summary',
    'Pay-per-service earnings for the current (open) pay period of a venue you can access: total, classes paid, staff count, exceptions (classes that cannot be valued yet and why) and a per-person total. Amounts in Mexican pesos. Covers every venue of the organization you can read; partial=true means some venues were left out for lack of permission. Requires staffpay:read.',
    {
      venueId: z.string().min(1).max(64).describe('Venue in your scope'),
      fecha,
      sede: sedeArg,
      offset: z.number().int().min(0).optional().describe('Offset for the per-person list'),
      limit: z.number().int().positive().max(100).optional().describe('Max people (default 50)'),
    },
    async ({ venueId, fecha: f, sede, offset, limit }) => {
      const no = await puedeLeer(venueId)
      if (no) return text({ ok: false, error: no })
      return text(await reportePeriodo({ userId: scope.staffId, venueId, fecha: f, sede, offset: offset ?? 0, limit: limit ?? 50 }))
    },
  )

  server.tool(
    'staff_service_pay_detail',
    'Class-by-class breakdown of one staff member pay in the open pay period: date, venue, class, seats counted, how they were counted, level, amount, or the exception that blocks it. Paginated with a cursor. Amounts in Mexican pesos. Requires staffpay:read.',
    {
      venueId: z.string().min(1).max(64).describe('Venue in your scope'),
      staffId: z.string().min(1).max(64).describe('Staff member to break down'),
      fecha,
      sede: sedeArg,
      cursor: z.string().optional().describe('nextCursor from the previous page'),
      limit: z.number().int().positive().max(100).optional().describe('Max classes (default 50)'),
    },
    async ({ venueId, staffId, fecha: f, sede, cursor, limit }) => {
      const no = await puedeLeer(venueId)
      if (no) return text({ ok: false, error: no })
      return text(await detallePersona({ userId: scope.staffId, venueId, staffId, fecha: f, sede, despuesDe: cursor, limit: limit ?? 50 }))
    },
  )

  server.tool(
    'staff_service_pay_config',
    'How pay-per-service is configured: the pay levels of the organization, which level each person has and since when, and the pay tables of the venue (seats occupied × level = amount) with the version in force on the given date. Requires staffpay:read.',
    { venueId: z.string().min(1).max(64).describe('Venue in your scope'), fecha },
    async ({ venueId, fecha: f }) => {
      const no = await puedeLeer(venueId)
      if (no) return text({ ok: false, error: no })
      const v = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true, timezone: true } })
      if (!v) return text({ ok: false, error: 'Sede no encontrada' })
      const dia = f ?? hoyLocal(v.timezone || 'America/Mexico_City')
      const [niveles, asignaciones, tablas] = await Promise.all([listarNiveles(v.organizationId), nivelesVigentes(v.organizationId, dia), listarTablas(venueId, dia)])
      return text({ fecha: dia, niveles, asignaciones, tablas })
    },
  )
}
