import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { publishCommand } from '../../communication/rabbitmq/publisher'
import { PosStatus } from '@prisma/client'

// Venue validation cache to reduce database load
interface VenueValidationCache {
  [venueId: string]: {
    isValid: boolean
    lastValidated: Date
    consecutiveFailures: number
  }
}

const venueCache: VenueValidationCache = {}
const VENUE_CACHE_DURATION_MS = 5 * 60 * 1000 // 5 minutes
const MAX_RETRY_ATTEMPTS = 3
const RETRY_DELAY_BASE_MS = 1000 // Start with 1 second delay

// Este es un placeholder para tu servicio de alertas real (email, Slack, etc.)
async function sendHighPriorityAlert(venueId: string, reason: string) {
  logger.error(
    `🚨 ALERTA DE MÁXIMA PRIORIDAD 🚨\nVenue: ${venueId}\nMotivo: ${reason}\nSe requiere intervención manual para reconciliar los datos.`,
  )
  // Aquí integrarías SendGrid, Twilio, Slack, etc.
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Check database connection health
 */
async function checkDatabaseHealth(): Promise<{ isHealthy: boolean; error?: string }> {
  try {
    await prisma.$queryRaw`SELECT 1`
    return { isHealthy: true }
  } catch (error) {
    logger.error('[Heartbeat Service] Database health check failed:', error)
    return {
      isHealthy: false,
      error: error instanceof Error ? error.message : 'Unknown database error',
    }
  }
}

/**
 * Validate venue existence with retry logic and caching
 */
async function validateVenueWithRetry(venueId: string): Promise<{
  isValid: boolean
  venue?: any
  error?: string
  fromCache?: boolean
}> {
  const now = new Date()
  const cached = venueCache[venueId]

  // Check cache first
  if (cached && now.getTime() - cached.lastValidated.getTime() < VENUE_CACHE_DURATION_MS) {
    if (cached.isValid) {
      logger.debug(`[Heartbeat Service] Venue ${venueId} validated from cache`)
      return { isValid: true, fromCache: true }
    } else if (cached.consecutiveFailures >= MAX_RETRY_ATTEMPTS) {
      // Don't retry if we've already failed too many times recently
      logger.warn(`[Heartbeat Service] Venue ${venueId} failed validation recently, using cached result`)
      return { isValid: false, fromCache: true, error: 'Venue failed validation recently' }
    }
  }

  // Attempt database validation with retry logic
  let lastError: string = ''

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      logger.debug(`[Heartbeat Service] Attempting venue validation for ${venueId} (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`)

      // Check database health first
      const healthCheck = await checkDatabaseHealth()
      if (!healthCheck.isHealthy) {
        throw new Error(`Database unhealthy: ${healthCheck.error}`)
      }

      const venue = await prisma.venue.findUnique({
        where: { id: venueId },
        select: { id: true, name: true, posStatus: true },
      })

      if (venue) {
        // Success - update cache
        venueCache[venueId] = {
          isValid: true,
          lastValidated: now,
          consecutiveFailures: 0,
        }
        logger.debug(`[Heartbeat Service] Venue ${venueId} validated successfully on attempt ${attempt}`)
        return { isValid: true, venue }
      } else {
        // Venue doesn't exist
        lastError = `Venue ${venueId} not found in database`
        logger.warn(`[Heartbeat Service] ${lastError} (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`)
        break // Don't retry for non-existent venues
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error during venue validation'
      logger.error(`[Heartbeat Service] Venue validation attempt ${attempt} failed for ${venueId}:`, error)

      if (attempt < MAX_RETRY_ATTEMPTS) {
        const delay = RETRY_DELAY_BASE_MS * Math.pow(2, attempt - 1) // Exponential backoff
        logger.info(`[Heartbeat Service] Retrying venue validation in ${delay}ms...`)
        await sleep(delay)
      }
    }
  }

  // All attempts failed - update cache
  const failures = (cached?.consecutiveFailures || 0) + 1
  venueCache[venueId] = {
    isValid: false,
    lastValidated: now,
    consecutiveFailures: failures,
  }

  logger.error(`[Heartbeat Service] Venue validation failed for ${venueId} after ${MAX_RETRY_ATTEMPTS} attempts. Error: ${lastError}`)
  return { isValid: false, error: lastError }
}

/**
 * Envía un comando de error de configuración al servicio POS de Windows
 * indicando que debe corregir su configuración de venueId.
 */
async function sendConfigurationErrorCommand(
  venueId: string,
  instanceId: string,
  errorType: string,
  posType: string,
  additionalInfo?: {
    errorDetails?: string
    databaseHealth?: boolean
    consecutiveFailures?: number
  },
) {
  try {
    const cached = venueCache[venueId]
    const routingKey = `command.${posType}.configuration.error`

    let message = `El venueId '${venueId}' no existe en la base de datos. Por favor, configure un venueId válido en el servicio POS.`

    if (additionalInfo?.databaseHealth === false) {
      message = `Error de conectividad con la base de datos al validar venueId '${venueId}'. Detalles: ${additionalInfo.errorDetails}`
    } else if (additionalInfo?.consecutiveFailures && additionalInfo.consecutiveFailures > 1) {
      message = `El venueId '${venueId}' ha fallado validación ${additionalInfo.consecutiveFailures} veces consecutivas. ${additionalInfo.errorDetails || 'Verificar configuración.'}`
    }

    const commandPayload = {
      entity: 'Configuration',
      action: 'ERROR',
      payload: {
        errorType,
        invalidVenueId: venueId,
        instanceId,
        message,
        timestamp: new Date().toISOString(),
        requiresReconfiguration: true,
        additionalInfo: {
          errorDetails: additionalInfo?.errorDetails,
          databaseHealthy: additionalInfo?.databaseHealth,
          consecutiveFailures: additionalInfo?.consecutiveFailures || cached?.consecutiveFailures || 1,
          lastSuccessfulValidation: cached?.isValid ? cached.lastValidated.toISOString() : null,
        },
      },
    }

    await publishCommand(routingKey, commandPayload)
    logger.info(
      `[Heartbeat Service] 📤 Comando de error de configuración enviado para venueId ${venueId} (fallos consecutivos: ${additionalInfo?.consecutiveFailures || 1})`,
    )
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
    // Use robust venue validation with retry logic and caching
    const validationResult = await validateVenueWithRetry(venueId)

    if (!validationResult.isValid) {
      const cached = venueCache[venueId]
      const errorDetails = validationResult.error || 'Unknown validation error'

      logger.error(
        `[Heartbeat Service] Venue ${venueId} validación falló. Error: ${errorDetails}. ${validationResult.fromCache ? '(desde cache)' : '(consulta DB)'}`,
      )

      // Only send error command if this is not a database connectivity issue
      // or if we've tried multiple times
      if (!validationResult.fromCache || (cached && cached.consecutiveFailures >= 2)) {
        const isDatabaseIssue = errorDetails.includes('Database unhealthy') || errorDetails.includes('connection')

        await sendConfigurationErrorCommand(venueId, instanceId, 'INVALID_VENUE_ID', posType || 'softrestaurant', {
          errorDetails,
          databaseHealth: !isDatabaseIssue,
          consecutiveFailures: cached?.consecutiveFailures,
        })
      } else {
        logger.warn(
          `[Heartbeat Service] Venue ${venueId} validación falló, pero posponienda error por posible problema temporal de conectividad`,
        )
      }
      return
    }

    const venue = validationResult.venue

    if (validationResult.fromCache) {
      logger.debug(`[Heartbeat Service] Venue ${venueId} validado exitosamente desde cache`)
    } else {
      logger.info(`[Heartbeat Service] Venue ${venueId} validado exitosamente desde base de datos`)
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
