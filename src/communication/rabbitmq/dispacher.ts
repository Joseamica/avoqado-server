import { posSyncService } from '../../services/integration/posSync.service'
// Importa aquí los otros servicios que necesitarás (shiftService, paymentService, etc.)
import logger from '../../config/logger'

export const dispatchPosEvent = async (routingKey: string, payload: any) => {
  const keyParts = routingKey.split('.') // ej: ['pos', 'softrestaurant', 'order', 'created']
  if (keyParts.length < 4) return

  const entity = keyParts[2]
  const event = keyParts[3]

  logger.info(`[Dispatcher] Despachando evento: ${entity}.${event}`)

  // Usamos un switch para dirigir el evento al servicio correcto
  switch (entity) {
    case 'order':
      // Si el evento es 'created' o 'updated', ambos pueden ser manejados por la misma lógica de upsert
      if (event === 'created' || event === 'updated') {
        await posSyncService.processPosOrderEvent(payload)
      }
      // TODO: Añadir un 'else if (event === 'closed')' para llamar a otro método del servicio
      break

    case 'staff':
      if (event === 'created' || event === 'updated') {
        await posSyncService.processPosStaffEvent(payload)
      }
      break

    case 'shift':
      if (event === 'opened' || event === 'closed') {
        await posSyncService.processPosShiftEvent(payload, event)
      } else {
        logger.warn(`[Dispatcher] Evento de shift no soportado: ${event}`)
      }
      break

    // ... otros casos para 'payment', 'product', etc.

    default:
      logger.warn(`[Dispatcher] No se encontró un manejador para la entidad: ${entity}`)
      break
  }
}
