import { ConsumeMessage } from 'amqplib'
import { getRabbitMQChannel, POS_EVENTS_EXCHANGE, AVOQADO_EVENTS_QUEUE } from './connection'
import { dispatchPosEvent } from './dispacher'
import logger from '../../config/logger'

// Deduplication cache: messageId -> timestamp with TTL (time to live)
interface MessageCache {
  [messageId: string]: {
    timestamp: number
    externalId?: string
  }
}

// Cache for recently processed messages (last 5 minutes)
const processedMessages: MessageCache = {}
const MESSAGE_CACHE_TTL = 5 * 60 * 1000 // 5 minutes in milliseconds
const TRANSIENT_REQUEUE_DELAY_MS = 1000

const isTransientShiftConflict = (error: unknown): boolean => {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'SHIFT_CLOSE_IN_PROGRESS' || code === 'SHIFT_CONCURRENT_UPDATE'
}

const waitBeforeRequeue = () => new Promise<void>(resolve => setTimeout(resolve, TRANSIENT_REQUEUE_DELAY_MS))

const warnWithoutThrow = (message: string, error: unknown): void => {
  try {
    logger.warn(message, error)
  } catch {
    // Un logger degradado no puede convertir una recuperación broker-owned en un rejection.
  }
}

// Clean up expired messages from cache every minute
setInterval(() => {
  const now = Date.now()
  for (const messageId in processedMessages) {
    if (now - processedMessages[messageId].timestamp > MESSAGE_CACHE_TTL) {
      delete processedMessages[messageId]
    }
  }
}, 60 * 1000)

// Generate a message ID for deduplication from the message content
const getMessageId = (msg: ConsumeMessage, payload: any): string => {
  // Use message properties for deduplication
  const routingKey = msg.fields.routingKey
  const deliveryTag = msg.fields.deliveryTag.toString()

  // If the payload contains an externalId (like for orders), include it
  const externalId = payload?.orderData?.externalId || payload?.externalId || 'no-external-id'

  // Combine values for a unique message fingerprint
  return `${routingKey}:${externalId}:${msg.properties.messageId || deliveryTag}`
}

const handleMessage = async (msg: ConsumeMessage | null) => {
  if (!msg) return

  const channel = getRabbitMQChannel()
  let messageId: string | undefined
  try {
    const payload = JSON.parse(msg.content.toString())
    const routingKey = msg.fields.routingKey

    // Generate message ID for deduplication
    messageId = getMessageId(msg, payload)
    const externalId = payload?.orderData?.externalId || payload?.externalId

    // Check if we've already processed this message recently
    if (processedMessages[messageId]) {
      logger.info(
        `🔄 Duplicate message detected [${routingKey}] with ID ${messageId} (externalId: ${externalId}). Acknowledging without processing.`,
      )
      channel.ack(msg)
      return
    }

    // Mark this message as processed
    processedMessages[messageId] = {
      timestamp: Date.now(),
      externalId,
    }

    logger.info(`📥 Mensaje recibido con routing key [${routingKey}]`)

    await dispatchPosEvent(routingKey, payload)

    channel.ack(msg)
    logger.info(`👍 Mensaje [${routingKey}] procesado y confirmado.`)
  } catch (error) {
    // La marca se escribió ANTES del dispatch; conservarla tras cualquier error absorbería el
    // requeue o un replay manual como "duplicado" y haría ack sin volver a ejecutar el evento.
    if (messageId) delete processedMessages[messageId]

    if (isTransientShiftConflict(error)) {
      warnWithoutThrow(`⏳ Conflicto transitorio al procesar [${msg.fields.routingKey}]. Reencolando con demora.`, error)
      // Mientras esperamos el mensaje sigue broker-owned/unacked; si el proceso muere RabbitMQ
      // lo devuelve solo. La pausa acotada evita un hot loop con prefetch(1).
      await waitBeforeRequeue()
      try {
        channel.nack(msg, false, true)
      } catch (nackError) {
        // No buscar otro canal ni confirmar: al cerrarse el canal capturado, RabbitMQ ya recupera
        // este mensaje no confirmado. Un segundo nack sobre otro canal sería inválido.
        warnWithoutThrow('⚠️ El canal capturado cerró antes del nack de requeue; RabbitMQ recuperará el mensaje no confirmado.', nackError)
      }
      return
    }

    logger.error(`🔥 Error al procesar mensaje [${msg.fields.routingKey}]. Enviando a Dead-Letter Queue.`, error)
    channel.nack(msg, false, false)
  }
}

export const startEventConsumer = async () => {
  logger.info('👂 Starting POS event consumer...')
  try {
    const channel = getRabbitMQChannel()
    // El patrón de binding para recibir todos los eventos de todos los POS
    const bindingPattern = 'pos.#'

    // ✅ La declaración de la cola (`assertQueue`) se ha eliminado de aquí.
    // Ahora confiamos en que connection.ts ya la ha creado correctamente.

    // Simplemente enlazamos la cola que ya existe al exchange.
    await channel.bindQueue(AVOQADO_EVENTS_QUEUE, POS_EVENTS_EXCHANGE, bindingPattern)

    // Definimos la Calidad de Servicio (cuántos mensajes procesar a la vez)
    channel.prefetch(1) // Empezar con 1 es lo más seguro para operaciones de BD

    logger.info(`👂 Esperando eventos en la cola [${AVOQADO_EVENTS_QUEUE}] con el patrón [${bindingPattern}]`)

    // Empezamos a consumir
    channel.consume(AVOQADO_EVENTS_QUEUE, handleMessage)
  } catch (error) {
    logger.error('🔥 No se pudo iniciar el consumidor de eventos:', error)
  }
}
