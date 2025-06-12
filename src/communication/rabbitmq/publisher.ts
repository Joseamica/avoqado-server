import logger from '../../config/logger'
import { getRabbitMQChannel, POS_COMMANDS_EXCHANGE } from './connection'

// ✅ Definimos el tipo que faltaba
export interface CommandPayload {
  [key: string]: any
}

export const publishCommand = async (routingKey: string, payload: CommandPayload): Promise<void> => {
  const channel = getRabbitMQChannel()
  const message = Buffer.from(JSON.stringify(payload))

  try {
    logger.info(`📤 Publicando comando con routing key [${routingKey}]`)

    // ✅ Implementación correcta de Publisher Confirms
    const published = channel.publish(
      POS_COMMANDS_EXCHANGE,
      routingKey,
      message,
      { persistent: true }, // Mensaje persistente
    )

    if (published) {
      // Esperamos la confirmación del bróker. Si hay un error, lanzará una excepción.
      await channel.waitForConfirms()
      logger.info(`✅ Comando [${routingKey}] confirmado por el bróker.`)
    } else {
      logger.error(`🔥 Falla al publicar [${routingKey}]: El buffer del canal está lleno.`)
      // Aquí se podría implementar una lógica de reintento
      throw new Error('El buffer del canal de RabbitMQ está lleno.')
    }
  } catch (error) {
    logger.error(`🔥 Error al publicar y confirmar comando [${routingKey}]:`, error)
    // Tu worker de PosCommand debería capturar este error, marcar el comando como FAILED y reintentarlo más tarde.
    throw error
  }
}
