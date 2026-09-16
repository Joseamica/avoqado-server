import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { listPaymentEffects } from '@/services/tpv/paymentEffectsRead.service'

export function registerPaymentEffectTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'list_payment_effects',
    'Consulta los trabajos derivados de pagos registrados: recibo, reseña, comisiones, referidos y el costo de transacción (comisión del procesador) cuando quedó pendiente. Elige un establecimiento y estado: PENDING (pendientes, predeterminado), PROCESSING (en ejecución), DONE (terminados) o DEAD_LETTER (necesitan revisión). Un costo pendiente dice por qué en lastError: AWAITING_SETTLEMENT_CONFIGURATION (falta configurar la liquidación de esa afiliación), AFFILIATION_PRICING_UNRESOLVED (al cobrar, la afiliación que cobró NO tenía tarifa contratada: es un hecho histórico, configurar una tarifa hoy no lo resuelve — hace falta acreditar ese cargo explícitamente), PRICING_CAPTURE_FAILED (al cobrar no se pudo leer la tarifa; tampoco se reconstruye después: misma acreditación explícita), INVALID_PRICING_SNAPSHOT (la tarifa congelada en el cobro no es legible), AWAITING_ACCREDITED_CARD_DATA (el cobro nació del aviso del procesador y la terminal todavía no acreditó el tipo de tarjeta: se espera su registro, nunca se calcula con un tipo supuesto) y AWAITING_ACCREDITED_CARD_DATA_OVERDUE (la misma espera, ya vencido el plazo: revisar esa terminal), VENUE_TRANSACTION_MISSING (falta el movimiento financiero de la venta), TRANSACTION_COST_FAILED (fallo al calcular; se reintenta). Incluye el total del filtro y nextCursor para recorrer todas las páginas. No reintenta trabajos ni modifica dinero.',
    {
      venueId: z.string().min(1, 'Indica el establecimiento'),
      status: z
        .enum(['PENDING', 'PROCESSING', 'DONE', 'DEAD_LETTER'], { errorMap: () => ({ message: 'Selecciona un estado válido' }) })
        .optional(),
      kind: z
        .enum(['REVIEW', 'RECEIPT', 'REFERRAL', 'COMMISSION', 'TRANSACTION_COST'], {
          errorMap: () => ({ message: 'Selecciona un tipo de trabajo válido' }),
        })
        .optional(),
      paymentId: z.string().optional().describe('Filtrar por el identificador exacto del pago'),
      limit: z
        .number({ invalid_type_error: 'El tamaño de página debe ser numérico' })
        .int('Indica un número entero')
        .positive('El tamaño de página debe ser positivo')
        .optional()
        .describe('Tamaño de página; 50 por defecto y máximo 100'),
      cursor: z.string().max(300, 'El cursor de página no es válido').optional().describe('nextCursor devuelto por la página anterior'),
    },
    async input => {
      guard.venueFilter(input.venueId)
      guard.requirePermission('payments:read', input.venueId)
      return text(await listPaymentEffects(input))
    },
  )
}
