import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fetchKdsCourier } from '@/services/mobile/kds.mobile.service'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

/**
 * "¿Quién trae este pedido?" — Tarea 8 del KDS de reparto. Sólo lectura, mismo permiso que
 * ver el tablero de cocina (`orders:read`): un error del proveedor o "aún no hay nadie" no
 * son secretos, se dejan pasar tal cual como los escribió `fetchKdsCourier`.
 */
export function registerDeliveryCourierTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'delivery_courier',
    'Quién trae AHORA MISMO un pedido de delivery (Uber Eats, etc.), cuando el proveedor ya le asignó repartidor: nombre, teléfono con el código para poder llamarlo, y su vehículo. "supported:false" significa que ese canal no ofrece este dato; "assigned:false" significa que sí lo ofrece pero todavía nadie recogió el pedido (o ya se cerró). Responde "¿quién trae mi pedido? ¿ya viene el repartidor?". Pass venueId y kdsOrderId (el id de la comanda tal como aparece en el tablero de cocina, no el de la venta). Solo lectura.',
    {
      venueId: z.string().describe('Venue de la comanda (debe estar en tu scope)'),
      kdsOrderId: z.string().describe('Id de la comanda del tablero de cocina'),
    },
    async ({ venueId, kdsOrderId }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('orders:read', venueId)
      const courier = await fetchKdsCourier(venueId, kdsOrderId)
      return text(courier)
    },
  )
}
