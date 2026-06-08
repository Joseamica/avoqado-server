import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { TableStatus } from '@prisma/client'

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
}
