import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { searchVerifiedHelp } from '@/services/support/knowledge.service'

export function registerSupportHelpTools(server: McpServer, scope: McpScope): void {
  const guard = createGuard(scope)
  server.tool(
    'avoqado_help_context',
    'Ayuda verificada de Avoqado para Dashboard, POS Android, POS Windows y terminales PAX/Nexgo. Explica pasos publicados o pide la versión y el tipo de equipo cuando hacen falta. Con una sucursal de tu alcance adapta los avisos de permisos y funciones disponibles; sin sucursal ofrece ayuda pública. Sólo explica: no modifica el negocio ni consulta ventas, no envía WhatsApp ni vincula teléfonos. Si no hay guía revisada, ofrece contacto humano. Cada guía trae su texto completo (whole) con sus condiciones y advertencias: no des sus pasos sin ellas.',
    {
      topic: z.string().trim().min(1, 'Escribe tu pregunta.').max(2000, 'La pregunta es demasiado larga.'),
      app: z.enum(['dashboard', 'android', 'windows', 'tpv']).describe('App sobre la que necesitas ayuda.'),
      appVersion: z.string().max(40, 'La versión es demasiado larga.').optional(),
      deviceFamily: z.enum(['PAX', 'NEXGO']).optional(),
      venueId: z.string().cuid('La sucursal no es válida.').optional(),
    },
    async ({ venueId, ...query }) => {
      let context = null
      if (venueId) {
        guard.venueFilter(venueId)
        const access = scope.perVenueAccess.get(venueId)
        context = { staffId: scope.staffId, venueId, orgId: access?.organizationId ?? scope.organizationId ?? scope.activeOrg }
      }
      return text(await searchVerifiedHelp(query, context))
    },
  )
}
