import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { TableStatus } from '@prisma/client'
import { moveOrderToTable, assignOrderWaiter } from '@/services/tpv/table.tpv.service'
import { compWholeOrder } from '@/services/mobile/comp-item.mobile.service'
import { updateOrderDetails, splitOrderItems } from '@/services/mobile/order.mobile.service'

const STATUS_MAP: Record<string, TableStatus> = {
  available: TableStatus.AVAILABLE,
  occupied: TableStatus.OCCUPIED,
  reserved: TableStatus.RESERVED,
  cleaning: TableStatus.CLEANING,
}

export function registerTableTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'tables_status',
    'Live table/floor status for a venue you can access: every table with its number, area/section, capacity, status (available/occupied/reserved/cleaning) and — when occupied — the live order on it (order number, total, paid, remaining balance, payment status, opened-at). Plus a count by status. Answers "¿qué mesas tengo ocupadas / libres ahorita? ¿cuánto lleva la mesa 12?". Pass venueId; optionally filter by area. (Dine-in venues; appointment/retail venues may simply have no tables.)',
    {
      venueId: z.string().describe('Venue whose tables to read (must be in your scope)'),
      area: z.string().optional().describe('Filter to one area/section by name (partial, case-insensitive)'),
      includeInactive: z.boolean().optional().describe('Include inactive/archived tables (default: only active)'),
    },
    async ({ venueId, area, includeInactive }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const tables = await prisma.table.findMany({
        where: {
          ...base,
          ...(includeInactive ? {} : { active: true }),
          ...(area ? { area: { name: { contains: area, mode: 'insensitive' as const } } } : {}),
        },
        select: {
          number: true,
          capacity: true,
          status: true,
          area: { select: { name: true } },
          currentOrder: {
            select: { orderNumber: true, total: true, paidAmount: true, remainingBalance: true, paymentStatus: true, createdAt: true },
          },
        },
        orderBy: { number: 'asc' },
      })

      const byStatus: Record<string, number> = {}
      for (const t of tables) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1

      return text({
        venueId,
        total: tables.length,
        byStatus, // { AVAILABLE: n, OCCUPIED: n, RESERVED: n, CLEANING: n }
        tables: tables.map(t => ({
          number: t.number,
          area: t.area?.name ?? null,
          capacity: t.capacity,
          status: t.status,
          order: t.currentOrder
            ? {
                orderNumber: t.currentOrder.orderNumber,
                total: Number(t.currentOrder.total),
                paid: Number(t.currentOrder.paidAmount),
                balance: Number(t.currentOrder.remainingBalance),
                paymentStatus: t.currentOrder.paymentStatus,
                openedAt: t.currentOrder.createdAt.toISOString(),
              }
            : null,
        })),
      })
    },
  )

  server.tool(
    'list_areas',
    'The areas / sections of a venue you can access (e.g. Terraza, Barra, Salón): each with its description and how many tables it has. Answers "¿qué áreas / secciones tengo?". Pass venueId. (For live occupancy use tables_status.)',
    {
      venueId: z.string().describe('Venue whose areas to list (must be in your scope)'),
    },
    async ({ venueId }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const areas = await prisma.area.findMany({
        where,
        select: { name: true, description: true, _count: { select: { tables: true } } },
        orderBy: { name: 'asc' },
      })
      return text({
        venueId,
        count: areas.length,
        areas: areas.map(a => ({ name: a.name, description: a.description, tables: a._count.tables })),
      })
    },
  )

  server.tool(
    'set_table_status',
    'Set the status of a table in a venue you can access, found by its number: available, occupied, reserved or cleaning. Safety: a table with a live (open) order CANNOT be marked available — close/pay that order first. This WRITES — it changes the floor; requires tables:update. Pass venueId + table number + the new status.',
    {
      venueId: z.string().describe('Venue that owns the table (must be in your scope)'),
      number: z.string().min(1).describe('Table number, e.g. "12"'),
      status: z.enum(['available', 'occupied', 'reserved', 'cleaning']).describe('New status for the table'),
    },
    async ({ venueId, number, status }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('tables:update', venueId) // write gate (per-venue role)
      const table = await prisma.table.findFirst({
        where: { ...where, number, active: true },
        select: { id: true, number: true, status: true, currentOrderId: true },
      })
      if (!table) return text({ ok: false, error: `No encontré la mesa "${number}" activa en este local.` })

      const target = STATUS_MAP[status]
      // Don't strand an open tab: a table with a live order can't be freed to AVAILABLE here.
      if (target === TableStatus.AVAILABLE && table.currentOrderId) {
        return text({ ok: false, error: `La mesa ${number} tiene una cuenta abierta — ciérrala o cóbrala antes de marcarla disponible.` })
      }

      try {
        const updated = await prisma.table.update({
          where: { id: table.id },
          data: { status: target },
          select: { number: true, status: true },
        })
        await auditMcpWrite(scope, {
          action: 'TABLE_STATUS_SET',
          entity: 'Table',
          entityId: table.id,
          venueId,
          data: { number: updated.number, from: table.status, to: updated.status },
        })
        return text({ ok: true, table: { number: updated.number, status: updated.status } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'move_table_check',
    'TABLE_SERVICE: move the OPEN check (cuenta) from one table to another in a venue you can access — Square\'s "Mover". The order keeps its items/courses; the source table is released and the target becomes occupied. Fails if the target is occupied/reserved or the order is already paid. This WRITES; requires orders:update. Pass venueId + source table number + target table number.',
    {
      venueId: z.string().describe('Venue that owns both tables (must be in your scope)'),
      fromNumber: z.string().min(1).describe('Table number the check is on now, e.g. "8"'),
      toNumber: z.string().min(1).describe('Destination table number, e.g. "12"'),
    },
    async ({ venueId, fromNumber, toNumber }) => {
      const where = guard.venueFilter(venueId)
      guard.requirePermission('orders:update', venueId)
      const source = await prisma.table.findFirst({
        where: { ...where, number: fromNumber, active: true },
        select: { id: true, number: true, currentOrderId: true },
      })
      if (!source) return text({ ok: false, error: `No encontré la mesa "${fromNumber}" activa en este local.` })
      if (!source.currentOrderId) return text({ ok: false, error: `La mesa ${fromNumber} no tiene cuenta abierta.` })
      const target = await prisma.table.findFirst({
        where: { ...where, number: toNumber, active: true },
        select: { id: true },
      })
      if (!target) return text({ ok: false, error: `No encontré la mesa "${toNumber}" activa en este local.` })

      try {
        await moveOrderToTable(venueId, source.currentOrderId, target.id)
        await auditMcpWrite(scope, {
          action: 'TABLE_CHECK_MOVED',
          entity: 'Order',
          entityId: source.currentOrderId,
          venueId,
          data: { from: fromNumber, to: toNumber },
        })
        return text({ ok: true, moved: { orderId: source.currentOrderId, from: fromNumber, to: toNumber } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'assign_table_check',
    'TABLE_SERVICE: reassign the OPEN check (cuenta) of a table to another waiter/staff member — Square\'s "Asignar". Sales attribution (tips, corte) follows the new waiter. This WRITES; requires orders:update. Pass venueId + table number + the staff member (id, or a name to search).',
    {
      venueId: z.string().describe('Venue that owns the table (must be in your scope)'),
      number: z.string().min(1).describe('Table number whose check to reassign, e.g. "8"'),
      staff: z.string().min(1).describe('Staff id, or a name fragment to search among the venue staff'),
    },
    async ({ venueId, number, staff }) => {
      const where = guard.venueFilter(venueId)
      guard.requirePermission('orders:update', venueId)
      const table = await prisma.table.findFirst({
        where: { ...where, number, active: true },
        select: { id: true, currentOrderId: true },
      })
      if (!table) return text({ ok: false, error: `No encontré la mesa "${number}" activa en este local.` })
      if (!table.currentOrderId) return text({ ok: false, error: `La mesa ${number} no tiene cuenta abierta.` })

      // Resolve staff: exact id first, then name search within the venue.
      let staffId = staff
      const byId = await prisma.staffVenue.findFirst({ where: { venueId, staffId: staff }, select: { staffId: true } })
      if (!byId) {
        const matches = await prisma.staffVenue.findMany({
          where: {
            venueId,
            staff: {
              OR: [{ firstName: { contains: staff, mode: 'insensitive' } }, { lastName: { contains: staff, mode: 'insensitive' } }],
            },
          },
          select: { staffId: true, staff: { select: { firstName: true, lastName: true } } },
          take: 5,
        })
        if (matches.length === 0) return text({ ok: false, error: `No encontré personal "${staff}" en este local.` })
        if (matches.length > 1) {
          return text({
            ok: false,
            error: 'Hay varias coincidencias — especifica mejor.',
            matches: matches.map(m => ({ id: m.staffId, name: `${m.staff.firstName} ${m.staff.lastName}` })),
          })
        }
        staffId = matches[0].staffId
      }

      try {
        const result = await assignOrderWaiter(venueId, table.currentOrderId, staffId)
        await auditMcpWrite(scope, {
          action: 'TABLE_CHECK_ASSIGNED',
          entity: 'Order',
          entityId: table.currentOrderId,
          venueId,
          data: { table: number, staffId, staffName: result.staffName },
        })
        return text({ ok: true, assigned: { table: number, waiter: result.staffName } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'comp_table_check',
    'TABLE_SERVICE: comp the ENTIRE open check of a table ("Cortesía en la cuenta") — every line stays visible but stops costing money; totals recompute. Blocked once the order is paid/partially paid. This WRITES money; requires orders:update. Pass venueId + table number + reason.',
    {
      venueId: z.string().describe('Venue that owns the table (must be in your scope)'),
      number: z.string().min(1).describe('Table number whose check to comp, e.g. "8"'),
      reason: z.string().min(1).describe('Reason for the comp (e.g. "Reclamo del cliente")'),
    },
    async ({ venueId, number, reason }) => {
      const where = guard.venueFilter(venueId)
      guard.requirePermission('orders:update', venueId)
      const table = await prisma.table.findFirst({
        where: { ...where, number, active: true },
        select: { id: true, currentOrderId: true },
      })
      if (!table) return text({ ok: false, error: `No encontré la mesa "${number}" activa en este local.` })
      if (!table.currentOrderId) return text({ ok: false, error: `La mesa ${number} no tiene cuenta abierta.` })
      try {
        const result = await compWholeOrder({ venueId, orderId: table.currentOrderId, reason })
        await auditMcpWrite(scope, {
          action: 'TABLE_CHECK_COMPED',
          entity: 'Order',
          entityId: table.currentOrderId,
          venueId,
          data: { table: number, reason, items: result.itemsComped, amount: result.compedAmount },
        })
        return text({ ok: true, comped: { table: number, items: result.itemsComped, amount: result.compedAmount } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'set_table_check_details',
    "TABLE_SERVICE: update the open check's metadata on a table — display name (nombre), notes (notas), covers (comensales) and/or attached customer. Never touches money. This WRITES; requires orders:update. Pass venueId + table number + any of the fields.",
    {
      venueId: z.string().describe('Venue that owns the table (must be in your scope)'),
      number: z.string().min(1).describe('Table number whose check to update, e.g. "8"'),
      name: z.string().optional().describe('Check display name; empty string clears it'),
      notes: z.string().optional().describe('Check notes (alergias, ocasión...); empty string clears'),
      covers: z.number().int().min(1).max(200).optional().describe('Comensales'),
      customerId: z.string().optional().describe('Customer id to attach; empty string detaches'),
    },
    async ({ venueId, number, name, notes, covers, customerId }) => {
      const where = guard.venueFilter(venueId)
      guard.requirePermission('orders:update', venueId)
      const table = await prisma.table.findFirst({
        where: { ...where, number, active: true },
        select: { id: true, currentOrderId: true },
      })
      if (!table) return text({ ok: false, error: `No encontré la mesa "${number}" activa en este local.` })
      if (!table.currentOrderId) return text({ ok: false, error: `La mesa ${number} no tiene cuenta abierta.` })
      try {
        const result = await updateOrderDetails(venueId, table.currentOrderId, { name, notes, covers, customerId })
        await auditMcpWrite(scope, {
          action: 'TABLE_CHECK_DETAILS_SET',
          entity: 'Order',
          entityId: table.currentOrderId,
          venueId,
          data: { table: number, ...result },
        })
        return text({ ok: true, details: result })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'split_table_check',
    "TABLE_SERVICE: split the open check of a table into a SECOND check on the SAME table (Square's separate checks) by moving specific items. Pass venueId + table number + the item ids to move (list them first via tables_status/find_order). At least one item must stay. This WRITES; requires orders:update.",
    {
      venueId: z.string().describe('Venue that owns the table (must be in your scope)'),
      number: z.string().min(1).describe('Table number whose check to split, e.g. "8"'),
      itemIds: z.array(z.string()).min(1).describe('OrderItem ids to move to the new check'),
    },
    async ({ venueId, number, itemIds }) => {
      const where = guard.venueFilter(venueId)
      guard.requirePermission('orders:update', venueId)
      const table = await prisma.table.findFirst({
        where: { ...where, number, active: true },
        select: { id: true, currentOrderId: true },
      })
      if (!table) return text({ ok: false, error: `No encontré la mesa "${number}" activa en este local.` })
      if (!table.currentOrderId) return text({ ok: false, error: `La mesa ${number} no tiene cuenta abierta.` })
      try {
        const result = await splitOrderItems(venueId, table.currentOrderId, itemIds)
        await auditMcpWrite(scope, {
          action: 'TABLE_CHECK_SPLIT',
          entity: 'Order',
          entityId: table.currentOrderId,
          venueId,
          data: { table: number, newOrder: result.created.orderNumber, items: itemIds.length },
        })
        return text({ ok: true, split: result })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
