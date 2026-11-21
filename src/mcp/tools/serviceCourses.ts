import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { createGuard, enforceWriteScope, ScopeError } from '../guard'
import type { McpScope } from '../scope'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import {
  getVenueServiceCourses,
  getOrganizationServiceCourses,
  putVenueServiceCourses,
  putOrganizationServiceCourses,
  setKitchenRelease,
} from '@/services/service-courses/serviceCourse.service'
import { serviceCourseCatalogSchema, MAX_SERVICE_COURSES } from '@/services/service-courses/serviceCourseContract'
import { listKitchenPreparation } from '@/services/kds/kitchenPreparation.service'

export function registerServiceCourseTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'kitchen_preparation',
    'Preparación por producto: tiempos retenidos, pendientes, preparando, listos y entregados, con cantidades por estación. Incluye prioridad urgente y si cocina ya vio el aviso; la prioridad no equivale a listo. Lista paginada; requiere Pro y orders:read. No cambia cobros ni inventario.',
    {
      venueId: z.string(),
      orderId: z.string().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
      history: z.boolean().optional().describe('Completed preparation history for a correction or reopening; separate from active work'),
    },
    async input => {
      guard.venueFilter(input.venueId)
      guard.requirePermission('orders:read', input.venueId)
      return text(await listKitchenPreparation(input.venueId, input))
    },
  )
  const target = { venueId: z.string().optional(), organizationId: z.string().optional() }
  async function authorize(input: { venueId?: string; organizationId?: string }, write = false) {
    if (!!input.venueId === !!input.organizationId) throw new ScopeError('Indica solo venueId o solo organizationId')
    if (input.venueId) {
      guard.venueFilter(input.venueId)
      guard.requirePermission(write ? 'settings:manage' : 'settings:read', input.venueId)
    } else {
      enforceWriteScope(scope, write ? 'settings:manage' : 'settings:read')
      if (input.organizationId !== scope.activeOrg) throw new ScopeError('Reconecta a la organización que quieres configurar')
      if (!scope.isSuperAdmin) {
        const owner = await prisma.staffOrganization.findFirst({
          where: { staffId: scope.staffId, organizationId: input.organizationId, role: 'OWNER', isActive: true, staff: { active: true } },
          select: { id: true },
        })
        if (!owner) throw new ScopeError('Solo el propietario de la organización puede administrar la lista compartida')
      }
    }
  }
  server.tool(
    'service_courses',
    'Service courses (tiempos): effective ordered list, inheritance, revision and Pro access. For a venue it also says kitchenCanRelease (whether the kitchen screen may release held courses). Pass exactly one venueId or organizationId; organization list requires organization OWNER. Venue settings:read.',
    target,
    async input => {
      await authorize(input)
      return text(input.venueId ? await getVenueServiceCourses(input.venueId) : await getOrganizationServiceCourses(input.organizationId!))
    },
  )
  server.tool(
    'configure_kitchen_release',
    'Turn on/off «La cocina puede liberar tiempos desde su pantalla» for ONE venue: when on, kitchen staff can release a held course from the kitchen screen (the register still can). TWO STEPS: preview first, then confirm:true after user authorization. Pro/TABLE_SERVICE and settings:manage. Does not change payments or inventory.',
    { venueId: z.string(), enabled: z.boolean(), confirm: z.boolean().optional() },
    async input => {
      guard.venueFilter(input.venueId)
      guard.requirePermission('settings:manage', input.venueId)
      const current = await getVenueServiceCourses(input.venueId)
      if (!current.enabled) throw new ScopeError('Los tiempos de servicio requieren Pro o acceso a Mesas')
      const label = (on: boolean) => (on ? 'La cocina puede liberar tiempos' : 'Sólo la caja libera tiempos')
      if (!input.confirm)
        return text({
          requiresConfirmation: true,
          venueName: current.venueName,
          preview: `${label(current.kitchenCanRelease)} → ${label(input.enabled)}`,
        })
      const result = await setKitchenRelease(input.venueId, input.enabled, { staffId: scope.staffId, source: 'customer-mcp' })
      await auditMcpWrite(scope, {
        action: 'KITCHEN_RELEASE_MCP_CONFIRMED',
        entity: 'VenueSettings',
        entityId: input.venueId,
        venueId: input.venueId,
        organizationId: current.organizationId,
        data: { before: current.kitchenCanRelease, after: input.enabled },
      })
      return text({ ok: true, venueName: result.venueName, kitchenCanRelease: result.kitchenCanRelease })
    },
  )
  server.tool(
    'configure_service_courses',
    'Rename/add/reorder service courses. TWO STEPS: preview first, then confirm:true after user authorization. Exactly one venueId or organizationId. courses:null restores venue inheritance; shared list requires organization OWNER. Pro/TABLE_SERVICE and settings:manage. Does not change historical orders.',
    {
      ...target,
      courses: z.array(z.unknown()).max(MAX_SERVICE_COURSES).nullable(),
      expectedRevision: z.string().max(64),
      confirm: z.boolean().optional(),
    },
    async input => {
      await authorize(input, true)
      const parsed = input.courses === null && input.venueId ? null : serviceCourseCatalogSchema.parse(input.courses)
      const current = input.venueId
        ? await getVenueServiceCourses(input.venueId)
        : await getOrganizationServiceCourses(input.organizationId!)
      if (!current.enabled) throw new ScopeError('Los tiempos de servicio requieren Pro o acceso a Mesas')
      if (!input.confirm)
        return text({
          requiresConfirmation: true,
          currentRevision: current.revision,
          before: current.courses,
          after: parsed,
          restoreInheritance: parsed === null,
        })
      const save = { expectedRevision: input.expectedRevision, courses: parsed }
      const actor = { staffId: scope.staffId, source: 'customer-mcp' }
      const result = input.venueId
        ? await putVenueServiceCourses(input.venueId, save, actor)
        : await putOrganizationServiceCourses(input.organizationId!, save, actor)
      await auditMcpWrite(scope, {
        action: 'SERVICE_COURSES_MCP_CONFIRMED',
        entity: input.venueId ? 'VenueSettings' : 'Organization',
        entityId: input.venueId ?? input.organizationId!,
        venueId: input.venueId ?? null,
        organizationId: current.organizationId,
        data: { revision: result.revision },
      })
      return text({ ok: true, ...result })
    },
  )
}
