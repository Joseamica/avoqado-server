/**
 * PRINT_STATIONS — MCP read tools (feature gratis/core, sin plan gate).
 *
 * Solo lectura en v1 (list_printers · list_print_stations · print_routing_preview).
 * La escritura (configurar impresoras/estaciones/ruteo) se hace desde el dashboard;
 * cuando se exponga por MCP será confirm-gated en 2 pasos (invariante MCP #4).
 * Todo scoped al venue del operador (guard.venueFilter) + requirePermission('printers:read').
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getGateway, getRouting, listPrinters, listStations, previewRouting } from '@/services/dashboard/printStation.dashboard.service'
import { createGuard } from '../guard'
import { text } from '../respond'
import type { McpScope } from '../scope'

export function registerPrinterTools(server: McpServer, scope: McpScope): void {
  const guard = createGuard(scope)

  server.tool(
    'list_printers',
    "List the physical printers of a venue (PRINT_STATIONS) plus its print gateway (the single always-on device that owns the printers on the LAN). Shows each printer's name, connection type, address, paper width, charset and last known status. Read-only — requires printers:read.",
    {
      venueId: z.string().describe('Venue to inspect (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('printers:read', venueId)
      const [printers, gateway] = await Promise.all([listPrinters(venueId), getGateway(venueId)])
      return text({
        ok: true,
        gateway: gateway
          ? { terminalId: gateway.terminalId, address: gateway.address, active: gateway.active, lastHeartbeat: gateway.lastHeartbeat }
          : null,
        printers,
        nota: gateway
          ? undefined
          : 'Este venue no tiene un gateway de impresión designado — sin él las comandas no se rutean. Configúralo en el dashboard (Impresoras y estaciones).',
      })
    },
  )

  server.tool(
    'list_print_stations',
    'List the print stations of a venue (e.g. Cocina, Barra) with their assigned printer and which one is the default fallback (PRINT_STATIONS). Also returns how many menu categories have NO route AND no default (they would print a marked "SIN ESTACIÓN" ticket). Read-only — requires printers:read.',
    {
      venueId: z.string().describe('Venue to inspect (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('printers:read', venueId)
      const [stations, routing] = await Promise.all([listStations(venueId), getRouting(venueId)])
      return text({
        ok: true,
        stations: stations.map(s => ({
          id: s.id,
          name: s.name,
          printer: s.printer
            ? { id: s.printer.id, name: s.printer.name, active: s.printer.active, lastStatus: s.printer.lastStatus }
            : null,
          copies: s.copies,
          isDefault: s.isDefault,
          active: s.active,
        })),
        hasDefault: routing.hasDefault,
        unroutedCategories: routing.unroutedCategories,
        nota:
          !routing.hasDefault && routing.unroutedCategories > 0
            ? `${routing.unroutedCategories} categoría(s) sin ruta y sin estación default: sus productos imprimirían una comanda marcada "SIN ESTACIÓN". Asigna una estación o marca un default.`
            : undefined,
      })
    },
  )

  server.tool(
    'print_routing_preview',
    'Simulate where a set of products would print for a venue (PRINT_STATIONS) — same routing engine the POS uses. Give product ids (from list_menu) and quantities; get back one ticket per station with only its items ("estos 2 tacos → Cocina, esta cerveza → Barra"). Read-only — requires printers:read.',
    {
      venueId: z.string().describe('Venue to simulate (must be in your scope)'),
      items: z
        .array(z.object({ productId: z.string().describe('Product id (see list_menu)'), quantity: z.number().int().min(1) }))
        .min(1)
        .describe('Products + quantities to route'),
    },
    async ({ venueId, items }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('printers:read', venueId)
      const result = await previewRouting(venueId, { items })
      return text({
        ok: true,
        ...result,
        nota: result.unrouted
          ? 'Al menos un producto no tiene ruta ni estación default: imprimiría una comanda marcada "SIN ESTACIÓN".'
          : undefined,
      })
    },
  )
}
