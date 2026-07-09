import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard, ScopeError } from '../guard'
import { text } from '../respond'
import { serializedInventoryService } from '@/services/serialized-inventory/serializedInventory.service'
import { simCustodyService } from '@/services/serialized-inventory/custody.service'
import { auditMcpWrite } from '../audit'
import { ROLE_HIERARCHY } from '@/lib/permissions'
import { StaffRole } from '@prisma/client'
import { moduleService, MODULE_CODES } from '@/services/modules/module.service'
import { stockDashboardService } from '@/services/stock-dashboard/stockDashboard.service'
import { simRegistrationService } from '@/services/serialized-inventory/simRegistration.service'
import { hasPermission } from '@/services/access/access.service'

const SERIALIZED_OFF_MSG = 'El inventario serializado no está activo en este local (módulo SERIALIZED_INVENTORY apagado).'

// Plain-Spanish gloss for each custody state, so the SIM custody timeline reads
// like the dashboard instead of raw enum values.
const CUSTODY_STATE_ES: Record<string, string> = {
  ADMIN_HELD: 'En almacén (sin supervisor)',
  SUPERVISOR_HELD: 'En poder del supervisor',
  PROMOTER_PENDING: 'Asignado a promotor (pendiente de aceptar en TPV)',
  PROMOTER_HELD: 'En poder del promotor (vendible)',
  PROMOTER_REJECTED: 'Rechazado por el promotor (requiere recolección del supervisor)',
  SOLD: 'Vendido',
}

export function registerSerializedTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  /** Org-level gate: caller must hold `sim-custody:approve-registration` in SOME venue of the active org. Mirrors cash-out's requireOrgReadAccess. */
  function requireOrgApprovalAccess(): string {
    if (!scope.activeOrg) {
      throw new ScopeError('No hay una organización activa en esta conexión — reconéctate eligiendo una organización.')
    }
    for (const access of scope.perVenueAccess.values()) {
      if (access.organizationId === scope.activeOrg && hasPermission(access, 'sim-custody:approve-registration')) return scope.activeOrg
    }
    throw new ScopeError('Missing permission sim-custody:approve-registration in this organization')
  }

  server.tool(
    'serialized_inventory',
    'Inventory of serialized items (SIMs, barcoded units, certificates) across your venues, counted by status: AVAILABLE, SOLD, RETURNED, DAMAGED. Pass venueId to focus one venue. (Org-level items not tied to a venue are not counted here.)',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
    },
    async ({ venueId }) => {
      const where = guard.venueFilter(venueId) // throws if out of scope
      // SERIALIZED_INVENTORY is a MODULE (VenueModule), gated platform-wide via moduleService
      // .isModuleEnabled (NOT the Feature/tier resolver) — incl. its org-level fallback. Filter to
      // venues where the module is actually on, so only module-enabled venues (e.g. PlayTelecom) see it.
      const requestedIds = venueId ? [venueId] : scope.allowedVenueIds
      const enabledFlags = await Promise.all(requestedIds.map(id => moduleService.isModuleEnabled(id, MODULE_CODES.SERIALIZED_INVENTORY)))
      const entitledIds = requestedIds.filter((_, i) => enabledFlags[i])
      if (entitledIds.length === 0) {
        return text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG })
      }
      where.venueId = { in: entitledIds }
      const grouped = await prisma.serializedItem.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      })
      const byStatus: Record<string, number> = {}
      for (const g of grouped) byStatus[g.status] = g._count._all
      const total = Object.values(byStatus).reduce((a, b) => a + b, 0)
      return text({
        venuesInScope: venueId ? 1 : scope.allowedVenueIds.length,
        available: byStatus.AVAILABLE ?? 0,
        sold: byStatus.SOLD ?? 0,
        total,
        byStatus,
      })
    },
  )

  server.tool(
    'mark_serialized_item',
    'Mark a serialized item (SIM / ICCID / barcode) as RETURNED (frees it back into inventory / the custody chain and unlinks it from the order it was sold on) or DAMAGED (removes it from the sellable chain). Identify it by serial number within a venue you can access. IMPORTANT: this changes INVENTORY state only — it does NOT refund the customer or reverse the payment. Any money refund is separate (cash by hand, or a card refund done physically on the terminal). By DEFAULT it only PREVIEWS; call again with confirm:true to apply. This WRITES — requires inventory:adjust.',
    {
      venueId: z.string().describe('Venue that owns the item (must be in your scope)'),
      serialNumber: z.string().min(1).describe('Serial number / ICCID / barcode of the item'),
      action: z.enum(['returned', 'damaged']).describe("'returned' reverses a sale; 'damaged' marks it unsellable"),
      confirm: z.boolean().optional().describe('Must be true to actually change the item state; without it you get a preview'),
    },
    async ({ venueId, serialNumber, action, confirm }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('inventory:adjust', venueId) // write gate (per-venue role)
      // SERIALIZED_INVENTORY is a MODULE — gate the same way the platform does (isModuleEnabled,
      // incl. org-level fallback), NOT the Feature/tier resolver. Only module-on venues can write.
      if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
        return text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG })
      }
      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          change: {
            serialNumber,
            action,
            effect:
              action === 'returned'
                ? 'libera el SIM al inventario y lo desliga de la orden (NO reembolsa al cliente)'
                : 'marca el item como no vendible',
          },
          message: `Esto marcará el serial "${serialNumber}" como ${action === 'returned' ? 'DEVUELTO — libera el SIM al inventario y lo desliga de la venta, pero NO reembolsa al cliente (el reembolso, si aplica, se maneja aparte: efectivo a mano o tarjeta en la terminal)' : 'DAÑADO (no vendible)'}. Confirma con el operador; luego vuelve a llamar con confirm:true.`,
        })
      }
      try {
        const item =
          action === 'returned'
            ? await serializedInventoryService.markAsReturned(venueId, serialNumber)
            : await serializedInventoryService.markAsDamaged(venueId, serialNumber)
        await auditMcpWrite(scope, {
          action: 'SERIALIZED_ITEM_MARKED',
          entity: 'SerializedItem',
          entityId: item.id,
          venueId,
          data: { serialNumber: item.serialNumber, status: item.status, action },
        })
        return text({ ok: true, item: { serialNumber: item.serialNumber, status: item.status, custodyState: item.custodyState } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'sim_custody',
    'Chain of custody (cadena de custodia) of ONE serialized item — a SIM / ICCID / barcoded unit — in an organization you can access. Given the serial number, returns the item\'s CURRENT custody state (in the warehouse / with a supervisor / with a promoter / sold), who currently holds it (supervisor + promoter), and the full timeline of every handoff: who passed it to whom, when, the state change, the actor, and the reason (e.g. employee terminated, damaged SIM). Answers "¿quién tiene este SIM ahora? ¿por las manos de quién pasó? ¿quién lo perdió?". Only for venues with the SERIALIZED_INVENTORY module (e.g. telecom). Pass venueId + serialNumber.',
    {
      venueId: z.string().describe('A venue in the org that owns the item (must be in your scope) — used for the module gate'),
      serialNumber: z.string().min(1).describe('Serial number / ICCID / barcode of the item'),
    },
    async ({ venueId, serialNumber }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      // SERIALIZED_INVENTORY is a MODULE — gate exactly like the platform (isModuleEnabled, incl.
      // org-level fallback), NOT the Feature/tier resolver. Only module-on venues may read custody.
      if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
        return text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG })
      }
      // M2 role gate: the custody chain (forensic "who lost/holds this SIM") is management-level
      // visibility. Mirror the dashboard timeline controller, which requires OWNER/ADMIN/MANAGER/
      // SUPERADMIN (simCustody.dashboard.controller listEvents) — so a low-role staffer in scope
      // can't read the org-wide custody history the dashboard would 403.
      const callerRole = scope.perVenueAccess.get(venueId)?.role
      if (!callerRole || ROLE_HIERARCHY[callerRole] < ROLE_HIERARCHY[StaffRole.MANAGER]) {
        return text({ ok: false, error: 'Solo OWNER, ADMIN o MANAGER pueden ver la cadena de custodia de un serial.' })
      }
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
      const orgId = venue?.organizationId
      // Case-insensitive serial lookup (legacy lowercase rows exist — serial bug class).
      // Scope to THIS venue or its org so an operator never reads another org's custody chain.
      const item = await prisma.serializedItem.findFirst({
        where: {
          serialNumber: { equals: serialNumber, mode: 'insensitive' as const },
          OR: [{ venueId }, ...(orgId ? [{ organizationId: orgId }] : [])],
        },
        select: {
          id: true,
          serialNumber: true,
          status: true,
          custodyState: true,
          assignedSupervisor: { select: { firstName: true, lastName: true } },
          assignedPromoter: { select: { firstName: true, lastName: true } },
        },
      })
      if (!item) {
        return text({ ok: false, error: `No encontré un ítem serializado con serial "${serialNumber}" en tu organización.` })
      }
      const events = await prisma.serializedItemCustodyEvent.findMany({
        where: { serializedItemId: item.id },
        orderBy: { createdAt: 'asc' }, // chronological: first handoff → latest
        take: 200,
      })
      // Events use plain String staff FKs (survive Staff deletion for forensics) — resolve names in one query.
      const staffIds = [...new Set(events.flatMap(e => [e.fromStaffId, e.toStaffId, e.actorStaffId].filter((id): id is string => !!id)))]
      const staff = staffIds.length
        ? await prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, firstName: true, lastName: true } })
        : []
      const nameOf = new Map(staff.map(s => [s.id, `${s.firstName} ${s.lastName}`.trim()]))
      // Resolve to a name; NEVER fall back to the raw staff id (M2 — don't leak internal identifiers
      // for staff deleted since the event). A deleted actor still shows in the chain, just anonymized.
      const who = (id: string | null) => (id ? (nameOf.get(id) ?? '(empleado eliminado)') : null)
      const fullName = (p: { firstName: string | null; lastName: string | null } | null) =>
        p ? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || null : null

      return text({
        venueId,
        item: {
          serialNumber: item.serialNumber,
          status: item.status,
          custodyState: item.custodyState,
          custodyStateLabel: CUSTODY_STATE_ES[item.custodyState] ?? item.custodyState,
          heldBySupervisor: fullName(item.assignedSupervisor),
          heldByPromoter: fullName(item.assignedPromoter),
        },
        eventCount: events.length,
        timeline: events.map(e => ({
          at: e.createdAt.toISOString(),
          eventType: e.eventType,
          fromState: e.fromState,
          toState: e.toState,
          fromStaff: who(e.fromStaffId),
          toStaff: who(e.toStaffId),
          actor: who(e.actorStaffId),
          reason: e.reason ?? null,
        })),
      })
    },
  )

  server.tool(
    'change_sim_category',
    'OWNER-only: reclassify one or many serialized items (SIM / ICCID) to a different org-level category (e.g. move SIMs from "SIM de Evento" to "SIM de Intercambio"). Use this to CORRECT a wrong SIM type — including SIMs that were ALREADY SOLD: pass allowSold:true and it reclassifies them too. IMPORTANT: this only changes the SIM\'s TYPE as it shows in the reports (weekly/monthly SIM-type breakdowns read the live category); it NEVER touches the sale, the amount, the promoter, or the custody chain. Only for venues with the SERIALIZED_INVENTORY module (telecom / white-label). By DEFAULT it only PREVIEWS; call again with confirm:true to apply. This WRITES.',
    {
      venueId: z
        .string()
        .describe('A venue in the org that owns the SIMs (must be in your scope) — used for the module gate and to resolve the org'),
      serialNumbers: z.array(z.string().min(1)).min(1).max(500).describe('ICCIDs / serial numbers to reclassify (max 500)'),
      categoryName: z
        .string()
        .min(1)
        .describe('Target category name, e.g. "SIM de Intercambio" (resolved to an org-level category, case-insensitive)'),
      allowSold: z
        .boolean()
        .optional()
        .describe(
          'Set true to reclassify SOLD SIMs too (correction path — only the SIM type in reports changes, the sale is untouched). Default false: sold SIMs are rejected with SIM_SOLD.',
        ),
      confirm: z.boolean().optional().describe('Must be true to actually apply; without it you get a preview'),
    },
    async ({ venueId, serialNumbers, categoryName, allowSold, confirm }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      // SERIALIZED_INVENTORY is a MODULE — gate exactly like the platform (isModuleEnabled, incl.
      // org-level fallback). Only module-on venues (telecom / white-label) may reclassify SIMs.
      if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
        return text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG })
      }
      // Write-scope (mcp:write) + the platform permission gate, evaluated for THIS venue.
      guard.requirePermission('serialized-inventory:change-category', venueId)
      // Extra MCP restriction (founder request): reclassifying SIMs — especially sold ones — is
      // OWNER-only here, stricter than the dashboard (OWNER/ADMIN). SUPERADMIN is above OWNER.
      const access = scope.perVenueAccess.get(venueId)
      const callerRole = access?.role
      if (!callerRole || ROLE_HIERARCHY[callerRole] < ROLE_HIERARCHY[StaffRole.OWNER]) {
        return text({ ok: false, error: 'Solo un OWNER puede cambiar la categoría de SIMs desde aquí.' })
      }
      const organizationId = access?.organizationId
      if (!organizationId) {
        return text({ ok: false, error: 'No pude resolver la organización de este venue.' })
      }

      // Resolve the target category name → id within the org (matches the service's own
      // OR: [org-level, venue-in-org] category scope). Case-insensitive.
      const categories = await prisma.itemCategory.findMany({
        where: { OR: [{ organizationId }, { venue: { organizationId } }] },
        select: { id: true, name: true },
      })
      const target = categories.find(c => c.name.trim().toLowerCase() === categoryName.trim().toLowerCase())
      if (!target) {
        return text({
          ok: false,
          error: `No encontré la categoría "${categoryName}" en esta organización.`,
          availableCategories: categories.map(c => c.name),
        })
      }

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          change: {
            serialCount: serialNumbers.length,
            toCategory: target.name,
            allowSold: allowSold ?? false,
          },
          message:
            `Esto reclasificará ${serialNumbers.length} SIM(s) a la categoría "${target.name}"` +
            `${allowSold ? ', INCLUYENDO los que ya estén vendidos (solo cambia su tipo en los reportes; la venta NO se toca)' : ' (los SIMs ya vendidos serán rechazados con SIM_SOLD; usa allowSold:true para incluirlos)'}.` +
            ' Confirma con el operador; luego vuelve a llamar con confirm:true.',
        })
      }

      try {
        const result = await simCustodyService.changeCategory({
          actor: { staffId: scope.staffId, organizationId, role: callerRole },
          serialNumbers,
          categoryId: target.id,
          allowSold: allowSold ?? false,
        })
        await auditMcpWrite(scope, {
          action: 'SERIALIZED_ITEM_CATEGORY_CHANGED',
          entity: 'SerializedItem',
          entityId: venueId, // bulk op — no single entity; anchor the MCP audit on the venue
          venueId,
          data: {
            toCategoryId: target.id,
            toCategoryName: target.name,
            allowSold: allowSold ?? false,
            summary: result.summary,
          },
        })
        return text({
          ok: result.summary.failed === 0,
          toCategory: target.name,
          allowSold: allowSold ?? false,
          summary: result.summary,
          results: result.results,
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'serialized_stock_by_category',
    'Serialized inventory (SIMs) broken down BY CATEGORY/TYPE across your organization: for each type (e.g. "SIM de Intercambio", "SIM de Evento", "$100 de Promotor", "e-SIM"), how many are AVAILABLE vs SOLD. Counts the ORG-LEVEL pool (PlayTelecom registers SIMs at org level, not per store). Answers "¿cuántas SIM de cada tipo tengo disponibles / vendidas?". Only for venues with the SERIALIZED_INVENTORY module. Pass venueId (any venue in the org — used for the module gate and to resolve the org).',
    { venueId: z.string().describe('A venue in the org (must be in your scope) — for the module gate + org resolution') },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:read', venueId)
      if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
        return text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG })
      }
      const access = scope.perVenueAccess.get(venueId)
      const orgId = access?.organizationId
      if (!orgId) return text({ ok: false, error: 'No pude resolver la organización de este venue.' })
      const rows = await serializedInventoryService.getOrgStockByCategory(orgId, scope.allowedVenueIds)
      return text({
        orgId,
        categories: rows.map(r => ({ category: r.category.name, available: r.available, sold: r.sold })),
        totalAvailable: rows.reduce((a, r) => a + r.available, 0),
        totalSold: rows.reduce((a, r) => a + r.sold, 0),
      })
    },
  )

  server.tool(
    'list_serialized_items',
    'List INDIVIDUAL serialized items (SIMs / ICCIDs) in your organization, including the ORG-LEVEL pool (venueId=null). Filter by status (AVAILABLE / SOLD / RETURNED / DAMAGED), by category name, by custody state, or by the promoter currently holding them (assignedPromoterId). Paginated (returns `total`). Answers "lista los SIMs disponibles", "¿qué SIMs trae el promotor X?". Only for venues with the SERIALIZED_INVENTORY module. Pass venueId (any venue in the org — for the module gate + org resolution).',
    {
      venueId: z.string().describe('A venue in the org (must be in your scope) — for the module gate + org resolution'),
      status: z.enum(['AVAILABLE', 'SOLD', 'RETURNED', 'DAMAGED']).optional().describe('Filter by item status'),
      categoryName: z.string().optional().describe('Filter by category/type name (case-insensitive, resolved to an org category)'),
      custodyState: z
        .enum(['ADMIN_HELD', 'SUPERVISOR_HELD', 'PROMOTER_PENDING', 'PROMOTER_HELD', 'PROMOTER_REJECTED', 'SOLD'])
        .optional()
        .describe('Filter by custody state'),
      assignedPromoterId: z.string().optional().describe('Only items currently held by this promoter (staffId)'),
      limit: z.number().int().positive().max(200).optional().describe('Max items (default 50)'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0)'),
    },
    async ({ venueId, status, categoryName, custodyState, assignedPromoterId, limit, offset }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:read', venueId)
      if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
        return text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG })
      }
      const orgId = scope.perVenueAccess.get(venueId)?.organizationId
      if (!orgId) return text({ ok: false, error: 'No pude resolver la organización de este venue.' })
      let categoryId: string | undefined
      if (categoryName) {
        const cats = await prisma.itemCategory.findMany({
          where: { OR: [{ organizationId: orgId }, { venue: { organizationId: orgId } }] },
          select: { id: true, name: true },
        })
        const match = cats.find(c => c.name.trim().toLowerCase() === categoryName.trim().toLowerCase())
        if (!match)
          return text({ ok: false, error: `No encontré la categoría "${categoryName}".`, availableCategories: cats.map(c => c.name) })
        categoryId = match.id
      }
      const { items, total } = await serializedInventoryService.listOrgItems({
        orgId,
        allowedVenueIds: scope.allowedVenueIds,
        categoryId,
        status: status as never,
        custodyState: custodyState as never,
        assignedPromoterId,
        skip: offset ?? 0,
        take: limit ?? 50,
      })
      return text({
        orgId,
        total,
        count: items.length,
        items: items.map(i => ({
          serialNumber: i.serialNumber,
          status: i.status,
          custodyState: i.custodyState,
          category: i.category?.name ?? null,
          venueId: i.venueId,
        })),
      })
    },
  )

  server.tool(
    'serialized_low_stock',
    'Alerta de SIMs por acabarse por CATEGORÍA/tipo, según el mínimo configurado por tienda (StockAlertConfig). Responde "¿qué tipo de SIM se me está acabando?". Solo venues con SERIALIZED_INVENTORY. Pass venueId. Este es el equivalente, para inventario serializado (SIMs), de low_stock — low_stock NO cubre SIMs.',
    { venueId: z.string().describe('Venue (must be in your scope)') },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:read', venueId)
      if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
        return text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG })
      }
      const alerts = await stockDashboardService.getLowStockAlerts(venueId)
      return text({
        venueId,
        count: alerts.length,
        alerts: alerts.map(a => ({
          category: a.categoryName,
          currentStock: a.currentStock,
          minimumStock: a.minimumStock,
          alertLevel: a.alertLevel,
        })),
      })
    },
  )

  server.tool(
    'serialized_stock_movements',
    'Feed de movimientos recientes de inventario serializado (SIMs): registros, ventas, devoluciones y daños, con quién los tiene/tuvo (promotor, supervisor o almacén). Responde "¿qué ha pasado con las SIMs últimamente?" / "¿quién registró/vendió tal SIM?". Solo venues con SERIALIZED_INVENTORY. Pass venueId; opcionalmente limit, fromDate/toDate (YYYY-MM-DD) y responsibleStaffId para filtrar.',
    {
      venueId: z.string().describe('Venue (must be in your scope)'),
      limit: z.number().int().positive().max(200).optional().describe('Max movements (default 20)'),
      fromDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Filter from this day (YYYY-MM-DD), inclusive'),
      toDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Filter up to this day (YYYY-MM-DD), inclusive'),
      responsibleStaffId: z
        .string()
        .optional()
        .describe('Only movements for this responsible staffId (promoter/supervisor); use "__admin_held__" for warehouse-held items'),
    },
    async ({ venueId, limit, fromDate, toDate, responsibleStaffId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:read', venueId)
      if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
        return text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG })
      }
      const movements = await stockDashboardService.getRecentMovements(venueId, limit ?? 20, {
        ...(fromDate ? { dateFrom: new Date(fromDate) } : {}),
        ...(toDate ? { dateTo: new Date(toDate) } : {}),
        ...(responsibleStaffId ? { responsibleStaffId } : {}),
      })
      return text({
        venueId,
        count: movements.length,
        movements: movements.map(m => ({
          serialNumber: m.serialNumber,
          category: m.categoryName,
          type: m.type,
          at: new Date(m.timestamp).toISOString(),
          venue: m.venueName,
          registeredBy: m.userName,
          soldBy: m.soldByName ?? null,
          soldAtVenue: m.soldAtVenueName ?? null,
          itemCount: m.itemCount ?? null,
          responsible: m.responsible,
        })),
      })
    },
  )

  server.tool(
    'serialized_stock_trend',
    'Tendencia diaria de stock disponible vs ventas de inventario serializado (SIMs) en los últimos N días — un punto por día. Responde "¿cómo ha ido bajando/subiendo el stock?" / "¿cuántas SIMs se vendieron por día?". Solo venues con SERIALIZED_INVENTORY. Pass venueId; opcionalmente days (default 14).',
    {
      venueId: z.string().describe('Venue (must be in your scope)'),
      days: z.number().int().positive().max(90).optional().describe('Number of days back (default 14)'),
    },
    async ({ venueId, days }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:read', venueId)
      if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
        return text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG })
      }
      const trend = await stockDashboardService.getStockVsSales(venueId, days ?? 14)
      return text({ venueId, days: days ?? 14, trend })
    },
  )

  server.tool(
    'serialized_stock_metrics',
    'Resumen de métricas de inventario serializado (SIMs) para un venue: piezas totales, valor total estimado, piezas disponibles, vendidas hoy y vendidas esta semana. Responde "¿cuánto stock tengo?" / "¿cuánto llevo vendido hoy/esta semana en SIMs?". Solo venues con SERIALIZED_INVENTORY. Pass venueId.',
    { venueId: z.string().describe('Venue (must be in your scope)') },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory:read', venueId)
      if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
        return text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG })
      }
      const metrics = await stockDashboardService.getStockMetrics(venueId)
      return text({ venueId, ...metrics })
    },
  )

  server.tool(
    'sim_pending_approvals',
    'Cola de aprobaciones de SIMs pendientes en tu organización. queue="registration" = solicitudes de registro de SIMs de promotores (SimRegistrationRequest PENDING); queue="stock" = SIMs ya registrados que requieren visto bueno del OWNER (requiresOwnerApproval). Responde "¿qué SIMs/stock tengo pendiente de aprobar?".',
    {
      queue: z.enum(['registration', 'stock']).describe('Which approval queue to read'),
      limit: z.number().int().positive().max(200).optional().describe('Page size, queue="stock" only (default 50)'),
      cursor: z.string().optional().describe('Pagination cursor, queue="stock" only (from a previous call\'s nextCursor)'),
      search: z.string().optional().describe('Filter by serial number substring, queue="stock" only'),
    },
    async ({ queue, limit, cursor, search }) => {
      const orgId = requireOrgApprovalAccess() // throws ScopeError if not permitted in the active org
      if (queue === 'registration') {
        const [requests, count] = await Promise.all([simRegistrationService.listPending(orgId), simRegistrationService.countPending(orgId)])
        return text({ queue, orgId, count, requests })
      }
      const [page, count] = await Promise.all([
        simRegistrationService.listPendingStockApprovals(orgId, { cursor, limit, search }),
        simRegistrationService.countPendingStockApprovals(orgId),
      ])
      return text({ queue, orgId, count, ...page })
    },
  )
}
