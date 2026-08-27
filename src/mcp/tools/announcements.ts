import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { text } from '../respond'
import { getAnnouncementForStaff, listAnnouncementsForStaff } from '@/services/announcements/announcementRead.service'

/**
 * Anuncios de plataforma que Avoqado le mandó a ESTA persona.
 *
 * 🔴 No hay filtro por venue ni permiso propio: el anuncio es global y la autorización
 * es la PERTENENCIA — sólo se listan los que tienen una `Notification` de este staff.
 * Es el mismo criterio que usan las rutas HTTP, no una regla paralela.
 */
export function registerAnnouncementTools(server: McpServer, scope: McpScope) {
  server.tool(
    'list_announcements',
    'Novedades y avisos que Avoqado te ha enviado: funciones nuevas, promociones de plan, mantenimientos. Devuelve sólo los que te llegaron a ti, del más reciente al más viejo, con si ya lo leíste. Úsalo cuando el usuario pregunte "¿qué hay de nuevo?", "¿qué novedades hay en Avoqado?" o "¿me llegó algún aviso?".',
    {
      limit: z.number().int().min(1).max(50).default(10).describe('Cuántos avisos devolver'),
      unreadOnly: z.boolean().default(false).describe('Sólo los que no has leído'),
    },
    async ({ limit, unreadOnly }) => {
      // 🔴 Pasa por el MISMO camino autorizado que HTTP. Consultar `Notification` aquí
      // por separado dejaba una lectura no autorizada por la puerta de al lado: la fila
      // de entrega es fabricable, así que hay que revalidar la audiencia.
      const announcements = await listAnnouncementsForStaff(scope.staffId, { limit, unreadOnly })
      return text({ count: announcements.length, announcements })
    },
  )

  server.tool(
    'get_announcement',
    'El contenido completo de un aviso de Avoqado, incluido su contenido ampliado (fotos, ficha técnica, lista de puntos). Úsalo cuando el usuario quiera el detalle de una novedad que list_announcements devolvió.',
    { announcementId: z.string().describe('El id del aviso, tal como lo devuelve list_announcements') },
    async ({ announcementId }) => {
      // Lanza ForbiddenError si a esta persona no se le repartió: misma regla que en HTTP.
      const announcement = await getAnnouncementForStaff(announcementId, scope.staffId)
      return text({ announcement })
    },
  )
}
