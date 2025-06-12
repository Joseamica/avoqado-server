import { ConsumeMessage } from 'amqplib'
import { getRabbitMQChannel, POS_EVENTS_EXCHANGE, AVOQADO_EVENTS_QUEUE } from './connection'
import { dispatchPosEvent } from './dispacher'
import logger from '../../config/logger'

const handleMessage = async (msg: ConsumeMessage | null) => {
  if (!msg) return

  const channel = getRabbitMQChannel()
  try {
    const payload = JSON.parse(msg.content.toString())
    const routingKey = msg.fields.routingKey

    logger.info(`📥 Mensaje recibido con routing key [${routingKey}]`)

    await dispatchPosEvent(routingKey, payload)

    channel.ack(msg)
    logger.info(`👍 Mensaje [${routingKey}] procesado y confirmado.`)
  } catch (error) {
    logger.error(`🔥 Error al procesar mensaje [${msg.fields.routingKey}]. Enviando a Dead-Letter Queue.`, error)
    channel.nack(msg, false, false)
  }
}

export const startEventConsumer = async () => {
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
