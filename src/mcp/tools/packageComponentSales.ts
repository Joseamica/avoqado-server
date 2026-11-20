import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { venueEndOfDay, venueStartOfDay } from '@/utils/datetime'
import { getUnitsInsidePackages } from '@/services/dashboard/sales-by-item.dashboard.service'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'

const PAGINA = 50
const PAGINA_MAX = 100
const sinAcentos = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/** ¿Es un día AAAA-MM-DD que existe? (el 30 de febrero no; Codex r1 #10: `new Date` lo volvía 2 de marzo). */
function diaExiste(dia: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return false
  const ref = new Date(`${dia}T12:00:00Z`)
  return !isNaN(ref.getTime()) && ref.toISOString().slice(0, 10) === dia
}

/**
 * El mediodía de ese día EN LA ZONA DEL NEGOCIO: ni la zona del proceso (Codex r1 #10) ni el mediodía UTC, que en Auckland ya es el
 * día siguiente (Codex r2 #6).
 */
const mediodiaDelNegocio = (dia: string, tz: string): Date => fromZonedTime(`${dia}T12:00:00`, tz)

/**
 * «Dentro de paquete» por MCP (founder «B», 20-nov-2026, Flautas). Herramienta NUEVA a propósito: `product_sales` está en la tanda
 * certificada del directorio y no se toca. Ésta vive sólo en el modo libre (`/mcp`), fuera de toda tanda de
 * `src/mcp/directory/catalog.ts`. Lee la MISMA consulta que la columna del reporte (`getUnitsInsidePackages`: mismos filtros de
 * órdenes, un renglón por platillo y sin recortes), con el día completo en la zona horaria del negocio.
 */
export function registerPackageComponentSalesTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'package_component_sales',
    'Units of each menu item sold as an EXTRA linked to it — an option of a combo that IS that menu item, e.g. the potato flautas chosen inside a "3 flautas" combo — over a period (default last 30 days). It is the "Dentro de paquete" column of the sales-by-item report: same orders and time zone. Units only, never money (the price is in the main product), and NOT loose sales of the item (those are in product_sales). It uses each extra\'s CURRENT link, so linking or unlinking today also changes past days. Pass venueId; optionally fromDate/toDate (YYYY-MM-DD), name (part of the menu item name) and limit (max 100) / offset.',
    {
      venueId: z.string().describe('Venue to read (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 30 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
      name: z.string().min(1).optional().describe('Only menu items whose name contains this, e.g. "papa"'),
      limit: z.number().int().min(1).max(PAGINA_MAX).optional().describe('Rows per page (default 50, max 100)'),
      offset: z.number().int().min(0).optional().describe('Rows to skip, from the previous page'),
    },
    async ({ venueId, fromDate, toDate, name, limit, offset }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('reports:read', venueId) // the same as the dashboard sales-by-item report
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'Los reportes avanzados') // PRO, like the report
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const malo = [fromDate, toDate].find(d => d !== undefined && !diaExiste(d))
      if (malo !== undefined) return text({ ok: false, error: `La fecha «${malo}» no es válida: usa AAAA-MM-DD (un día que exista).` })
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = venue?.timezone || 'America/Mexico_City'
      // Un día que el calendario del negocio se saltó (Samoa saltó el 30-dic-2011) no existe ahí: se rechaza en vez de leer otro día
      // (Codex r3 #3).
      const sinDia = [fromDate, toDate].find(d => d !== undefined && formatInTimeZone(mediodiaDelNegocio(d, tz), tz, 'yyyy-MM-dd') !== d)
      if (sinDia !== undefined) return text({ ok: false, error: `El día «${sinDia}» no existe en la zona del negocio (${tz}).` })
      const start = venueStartOfDay(tz, fromDate ? mediodiaDelNegocio(fromDate, tz) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
      const end = venueEndOfDay(tz, toDate ? mediodiaDelNegocio(toDate, tz) : undefined)

      // Un renglón por platillo ligado (acotado por el catálogo del negocio), ya ordenados de más a menos unidades.
      const porPlatillo = await getUnitsInsidePackages(venueId, start, end, '')
      const buscado = name ? sinAcentos(name) : null
      const filas = [...porPlatillo.values()]
        .filter(d => !buscado || sinAcentos(d.productName).includes(buscado))
        .map(d => ({ menuItem: d.productName, sku: d.productSku, category: d.categoryName, unitsInsidePackages: d.units }))
      const take = Math.min(Math.max(limit ?? PAGINA, 1), PAGINA_MAX)
      const skip = Math.max(offset ?? 0, 0)

      return text({
        found: true,
        venueId,
        window: { start: start.toISOString(), end: end.toISOString() },
        timezone: tz,
        total: filas.length,
        totalUnitsInsidePackages: filas.reduce((acc, f) => acc + f.unitsInsidePackages, 0),
        items: filas.slice(skip, skip + take),
        hasMore: skip + take < filas.length,
      })
    },
  )
}
