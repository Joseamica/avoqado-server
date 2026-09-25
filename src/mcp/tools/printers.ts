/**
 * PRINT_STATIONS — MCP read tools (feature gratis/core, sin plan gate).
 *
 * Lectura (list_printers · list_print_stations · print_routing_preview) + UNA escritura: la casilla de
 * pantalla de cocina (set_print_station_kitchen_display), sólo Avoqado y en 2 pasos (invariante MCP #4).
 * El resto de la configuración (impresoras/estaciones/ruteo) se hace desde el dashboard.
 * Todo scoped al venue del operador (guard.venueFilter) + requirePermission('printers:read').
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  getGateway,
  getRouting,
  KITCHEN_DISPLAY_NOT_READY_NOTICE,
  listPrinters,
  listStations,
  previewRouting,
  setKitchenDisplay,
} from '@/services/dashboard/printStation.dashboard.service'
import { auditMcpWrite } from '../audit'
import { createGuard } from '../guard'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { text } from '../respond'
import type { McpScope } from '../scope'

export function registerPrinterTools(server: McpServer, scope: McpScope): void {
  const guard = createGuard(scope)

  server.tool(
    'list_printers',
    "List the physical printers of a venue (PRINT_STATIONS) plus its print gateway (the single always-on device that owns the printers on the LAN). Shows each printer's name, connection type, address, paper width, charset and last known status. Connection type POS_INTERNAL means the POS device's own built-in printer (Sunmi): it has NO address and each ticket prints on the device that charged the sale. Also returns leftMarginChars: how many character columns the POS shifts printing to the right (ESC/POS `GS L`), which is how a narrow 58mm roll mounted with adapters inside an 80mm print head is kept on the paper — 0 means no shift, and a non-zero value on an 80mm printer means someone calibrated it for a narrow roll. Read-only — requires printers:read.",
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
          hasKitchenDisplay: s.hasKitchenDisplay,
        })),
        hasDefault: routing.hasDefault,
        unroutedCategories: routing.unroutedCategories,
        pantallaDeCocina: stations.some(s => s.hasKitchenDisplay) ? KITCHEN_DISPLAY_NOT_READY_NOTICE : undefined,
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

  server.tool(
    'set_print_station_kitchen_display',
    'Turn ON/OFF "Se atiende con pantalla de cocina" (kitchen display) for ONE print station. While NO active station of the venue has it, sales from the POS do NOT create kitchen-display tickets (the printed kitchen ticket is unaffected). Stage 1: ONLY Avoqado staff (superadmin) may change it, because the kitchen display is not finished for customers yet. Two steps: the first call only previews; call again with confirm:true to save.',
    {
      venueId: z.string().describe('Venue (must be in your scope)'),
      stationId: z.string().describe('Print station id (see list_print_stations)'),
      enabled: z.boolean().describe('true = the station is served with a kitchen display'),
      confirm: z.boolean().optional().describe('Set true on the SECOND call to actually save'),
    },
    async ({ venueId, stationId, enabled, confirm }) => {
      guard.venueFilter(venueId)
      if (!scope.isSuperAdmin) {
        return text({
          ok: false,
          error: 'Sólo Avoqado puede cambiar la pantalla de cocina en esta etapa.',
          aviso: KITCHEN_DISPLAY_NOT_READY_NOTICE,
        })
      }
      guard.requirePermission('printers:manage', venueId)
      requireWriteScopeAlways(scope, 'printers:manage', 'decide si las ventas de este negocio crean comandas para la pantalla de cocina')

      const estacion = (await listStations(venueId)).find(s => s.id === stationId)
      if (!estacion) return text({ ok: false, error: 'Esa estación no existe en este negocio.' })

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          mensaje: `Vas a ${enabled ? 'PRENDER' : 'APAGAR'} la pantalla de cocina en «${estacion.name}». Vuelve a llamar con confirm:true para guardarlo.`,
          antes: { hasKitchenDisplay: estacion.hasKitchenDisplay },
          despues: { hasKitchenDisplay: enabled },
          aviso: KITCHEN_DISPLAY_NOT_READY_NOTICE,
        })
      }

      const guardada = await setKitchenDisplay(venueId, stationId, enabled, scope.staffId)
      await auditMcpWrite(scope, {
        action: 'PRINT_STATION_KITCHEN_DISPLAY_SET',
        entity: 'PrintStation',
        entityId: stationId,
        venueId,
        data: { enabled, previous: estacion.hasKitchenDisplay },
      })
      return text({
        ok: true,
        station: { id: guardada.id, name: guardada.name, hasKitchenDisplay: guardada.hasKitchenDisplay },
        aviso: KITCHEN_DISPLAY_NOT_READY_NOTICE,
      })
    },
  )
}
