import cron from 'node-cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'

const HEARTBEAT_TIMEOUT_MINUTES = 3 // Si no recibimos heartbeat en 3 mins, se considera OFFLINE

async function checkPosConnections() {
  logger.info('[Monitor Job] 🩺 Verificando estado de conexiones del POS...')

  try {
    const timeoutThreshold = new Date(Date.now() - HEARTBEAT_TIMEOUT_MINUTES * 60 * 1000)

    // Busca todas las conexiones que están ONLINE pero cuyo último latido es más antiguo que nuestro umbral de tiempo.
    const offlineVenues = await prisma.posConnectionStatus.findMany({
      where: {
        status: 'ONLINE',
        lastHeartbeatAt: {
          lt: timeoutThreshold,
        },
      },
    })

    if (offlineVenues.length > 0) {
      const offlineVenueIds = offlineVenues.map(v => v.venueId)
      logger.warn(`[Monitor Job] 🐰 Se detectaron ${offlineVenues.length} conexiones de POS inactivas: ${offlineVenueIds.join(', ')}`)

      // Actualiza su estado a OFFLINE en la base de datos
      await prisma.posConnectionStatus.updateMany({
        where: {
          venueId: {
            in: offlineVenueIds,
          },
        },
        data: {
          status: 'OFFLINE',
        },
      })

      // Aquí puedes enviar una alerta de baja prioridad al equipo de soporte
      // alertSupportTeam(`Los siguientes venues están OFFLINE: ${offlineVenueIds.join(', ')}`);
    } else {
      logger.info('[Monitor Job] ✅ Todas las conexiones activas del POS están saludables.')
    }
  } catch (error) {
    logger.error('[Monitor Job] ❌ Error al verificar las conexiones del POS:', error)
  }
}

/**
 * Inicia el cron job para monitorear las conexiones del POS.
 * Se ejecuta cada 5 minutos.
 */
export function startPosConnectionMonitor() {
  logger.info(`[Monitor Job] ⏰ Monitor de conexiones POS iniciado. Se ejecutará cada 5 minutos.`)
  cron.schedule('*/5 * * * *', checkPosConnections)
}
