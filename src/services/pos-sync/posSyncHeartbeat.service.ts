import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { publishCommand } from '../../communication/rabbitmq/publisher'
import { PosStatus } from '@prisma/client'

// Este es un placeholder para tu servicio de alertas real (email, Slack, etc.)
async function sendHighPriorityAlert(venueId: string, reason: string) {
  logger.error(
    `🚨 ALERTA DE MÁXIMA PRIORIDAD 🚨\nVenue: ${venueId}\nMotivo: ${reason}\nSe requiere intervención manual para reconciliar los datos.`,
  )
  // Aquí integrarías SendGrid, Twilio, Slack, etc.
}

/**
 * Envía un comando de error de configuración al servicio POS de Windows
 * indicando que debe corregir su configuración de venueId.
 */
async function sendConfigurationErrorCommand(venueId: string, instanceId: string, errorType: string, posType: string) {
  try {
    const routingKey = `command.${posType}.configuration.error`
    const commandPayload = {
      entity: 'Configuration',
      action: 'ERROR',
      payload: {
        errorType,
        invalidVenueId: venueId,
        instanceId,
        message: `El venueId '${venueId}' no existe en la base de datos. Por favor, configure un venueId válido en el servicio POS.`,
        timestamp: new Date().toISOString(),
        requiresReconfiguration: true,
      },
    }

    await publishCommand(routingKey, commandPayload)
    logger.info(`[Heartbeat Service] 📤 Comando de error de configuración enviado para venueId ${venueId}`)
  } catch (error) {
    logger.error(`[Heartbeat Service] Error enviando comando de configuración para venueId ${venueId}:`, error)
  }
}

/**
 * Procesa un payload de heartbeat desde el producer del POS.
 */
export async function processPosHeartbeat(payload: { venueId: string; instanceId: string; producerVersion: string }, posType?: string) {
  const { venueId, instanceId, producerVersion } = payload
  logger.info(`[Heartbeat Service] ❤️ Recibido latido para Venue ${venueId} con InstanceId ${instanceId}`)

  try {
    // First verify that the venue exists
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
    })

    if (!venue) {
      logger.error(`[Heartbeat Service] Venue ${venueId} no existe en la base de datos. Enviando comando de error de configuración.`)

      // Send configuration error command back to the Windows POS service
      // Use posType from routing key if available, otherwise default to 'softrestaurant'
      await sendConfigurationErrorCommand(venueId, instanceId, 'INVALID_VENUE_ID', posType || 'softrestaurant')
      return
    }

    const existingStatus = await prisma.posConnectionStatus.findUnique({
      where: { venueId },
    })

    // Si es el primer heartbeat o el InstanceId no ha cambiado
    if (!existingStatus || existingStatus.instanceId === instanceId) {
      await prisma.posConnectionStatus.upsert({
        where: { venueId },
        update: {
          status: 'ONLINE',
          instanceId: instanceId,
          producerVersion: producerVersion,
          lastHeartbeatAt: new Date(),
          venue: {
            update: {
              posStatus: PosStatus.CONNECTED,
            },
          },
        },
        create: {
          venue: { connect: { id: venueId } },
          status: 'ONLINE',
          instanceId: instanceId,
          producerVersion: producerVersion,
          lastHeartbeatAt: new Date(),
        },
      })
      // logger.info(`[Heartbeat Service] Estado de Venue ${venueId} actualizado a ONLINE.`)
    } else {
      // ¡ALERTA! El InstanceId ha cambiado. La BD del POS fue probablemente restaurada.
      await prisma.posConnectionStatus.update({
        where: { venueId },
        data: {
          status: 'NEEDS_RECONCILIATION',
          instanceId: instanceId, // Guardamos el nuevo InstanceId
          producerVersion: producerVersion,
          lastHeartbeatAt: new Date(),
          venue: {
            update: {
              posStatus: PosStatus.ERROR,
            },
          },
        },
      })

      await sendHighPriorityAlert(
        venueId,
        `Se detectó un cambio de InstanceId para el POS. El anterior era ${existingStatus.instanceId}, el nuevo es ${instanceId}. La base de datos pudo haber sido restaurada.`,
      )
    }
  } catch (error) {
    logger.error(`[Heartbeat Service] Error procesando el heartbeat para Venue ${venueId}:`, error)
  }
}
