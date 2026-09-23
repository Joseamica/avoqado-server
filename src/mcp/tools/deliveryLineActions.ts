import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listDeliveryLineActions } from '@/services/mobile/kdsOutOfStock.mobile.service'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

/**
 * «No tengo este artículo» (KDS de reparto, Tarea 14): SÓLO LECTURA a propósito. Pedir el retiro
 * le manda un aviso al cliente final en la app de delivery y no se deshace — una escritura así
 * desde el MCP necesitaría confirmación en dos pasos y una decisión del founder.
 */
export function registerDeliveryLineActionTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'delivery_line_actions',
    'Los artículos que la cocina pidió RETIRAR de un pedido de delivery (Uber Eats, etc.) porque se acabaron, y en qué quedó cada aviso: PENDING (esperando al proveedor), UNCERTAIN (el proveedor no confirmó; una persona puede reintentar desde canRetryAt), CONFIRMED (retirado; el cliente ya fue avisado) o REJECTED (el proveedor no lo aceptó, p. ej. porque el pedido ya estaba listo). "settlement" dice si ya se devolvió el dinero de ese artículo; "unreflectedInProvider" marca un retiro confirmado que el proveedor sigue sin reflejar tras 24 h (hay que revisar ese pedido). Responde "¿qué artículos se quitaron de los pedidos de Uber? ¿quedó alguno sin confirmar?". Pass venueId y, opcional, orderId (la venta) y limit (máx. 100). Más recientes primero; hasMore indica que hay más. Solo lectura.',
    {
      venueId: z.string().describe('Venue (debe estar en tu scope)'),
      orderId: z.string().optional().describe('Id de la venta de delivery, para ver sólo ese pedido'),
      limit: z.number().int().min(1).max(100).optional().describe('Cuántos traer (por defecto 50, máximo 100)'),
    },
    async ({ venueId, orderId, limit }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('orders:read', venueId)
      return text(await listDeliveryLineActions(venueId, { orderId, limit }))
    },
  )
}
