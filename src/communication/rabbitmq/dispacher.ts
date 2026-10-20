import { posSyncService } from '../../services/pos-sync/posSync.service'
import { processPosOrderEvent, processPosOrderDeleteEvent } from '../../services/pos-sync/posSyncOrder.service'
import { PosRechazadoPorIva, rechazarSiIvaEncendido, registrarRechazo } from '../../services/pos-sync/exclusionIva'

// Importa aquí los otros servicios que necesitarás (shiftService, paymentService, etc.)
import logger from '../../config/logger'

/**
 * Procesa un evento de RabbitMQ relacionado con el POS.
 * El nombre de la cola se utiliza para determinar qué servicio debe manejar el evento.
 * La función utiliza un switch para dirigir el evento al servicio correcto.
 * @param routingKey - El nombre de la cola que se usó para enviar el evento.
 * @param payload - El contenido del evento.
 */
export const dispatchPosEvent = async (routingKey: string, payload: any) => {
  const keyParts = routingKey.split('.') // ej: ['pos', 'softrestaurant', 'order', 'created']
  if (keyParts.length < 4) return

  const posType = keyParts[1] // Extract posType from routing key
  const entity = keyParts[2]
  const event = keyParts[3]

  logger.info(`[Dispatcher] Despachando evento: ${entity}.${event}`)

  // Plan 6b (spec §5.4): exclusión inversa ANTES del primer efecto (personal, mesa y turno se escriben antes de la transacción de la orden).
  if (await rechazarSiIvaEncendido(payload?.venueId, `${entity}.${event}`)) return

  try {
    await despachar(entity, event, posType, payload)
  } catch (error) {
    // La carrera: el negocio se encendió después de la revisión de arriba y la guardia de la transacción lo vio. Es el ÚNICO lugar que
    // convierte el rechazo en ACK + rastro; cualquier otro error sigue a la cola muerta como hoy.
    if (error instanceof PosRechazadoPorIva) {
      await registrarRechazo(error.venueId, `${entity}.${event}`)
      return
    }
    throw error
  }
}

async function despachar(entity: string, event: string, posType: string, payload: any): Promise<void> {
  // Usamos un switch para dirigir el evento al servicio correcto
  switch (entity) {
    case 'order':
      if (event === 'created' || event === 'updated') {
        await processPosOrderEvent(payload)
      } else if (event === 'deleted') {
        await processPosOrderDeleteEvent(payload)
      }
      break

    case 'orderitem':
      // Todos los eventos (created, updated, deleted) van al mismo procesador.
      // El payload contiene la información necesaria para que el servicio decida si
      // crear, actualizar o borrar el item.
      if (['created', 'updated', 'deleted'].includes(event)) {
        // Usamos el servicio exportado desde el objeto principal
        await posSyncService.processPosOrderItemEvent(payload)
      } else {
        logger.warn(`[Dispatcher] Evento de orderitem no soportado: ${event}`)
      }
      break

    case 'staff':
      if (event === 'created' || event === 'updated') {
        await posSyncService.processPosStaffEvent(payload)
      }
      break

    case 'shift':
      if (event === 'created' || event === 'updated' || event === 'closed') {
        await posSyncService.processPosShiftEvent(payload, event)
      } else {
        logger.warn(`[Dispatcher] Evento de shift no soportado: ${event}`)
      }
      break

    case 'area':
      if (event === 'created' || event === 'updated') {
        await posSyncService.processPosAreaEvent(payload)
      }
      break
    case 'system':
      if (event === 'heartbeat') {
        await posSyncService.processPosHeartbeat(payload, posType)
      }
      break

    // ... otros casos para 'payment', 'product', etc.

    default:
      logger.warn(`[Dispatcher] No se encontró un manejador para la entidad: ${entity}`)
      break
  }
}
