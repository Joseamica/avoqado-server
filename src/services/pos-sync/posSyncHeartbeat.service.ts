import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

// Este es un placeholder para tu servicio de alertas real (email, Slack, etc.)
async function sendHighPriorityAlert(venueId: string, reason: string) {
  logger.error(
    `🚨 ALERTA DE MÁXIMA PRIORIDAD 🚨\nVenue: ${venueId}\nMotivo: ${reason}\nSe requiere intervención manual para reconciliar los datos.`,
  )
  // Aquí integrarías SendGrid, Twilio, Slack, etc.
}

/**
 * Procesa un payload de heartbeat desde el producer del POS.
 */
export async function processPosHeartbeat(payload: { venueId: string; instanceId: string; producerVersion: string }) {
  const { venueId, instanceId, producerVersion } = payload
  logger.info(`[Heartbeat Service] ❤️ Recibido latido para Venue ${venueId} con InstanceId ${instanceId}`)

  try {
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
        },
        create: {
          venue: { connect: { id: venueId } },
          status: 'ONLINE',
          instanceId: instanceId,
          producerVersion: producerVersion,
          lastHeartbeatAt: new Date(),
        },
      })
      logger.info(`[Heartbeat Service] Estado de Venue ${venueId} actualizado a ONLINE.`)
    } else {
      // ¡ALERTA! El InstanceId ha cambiado. La BD del POS fue probablemente restaurada.
      await prisma.posConnectionStatus.update({
        where: { venueId },
        data: {
          status: 'NEEDS_RECONCILIATION',
          instanceId: instanceId, // Guardamos el nuevo InstanceId
          producerVersion: producerVersion,
          lastHeartbeatAt: new Date(),
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
