import { connect, ChannelModel, Connection, ConfirmChannel } from 'amqplib'
import { RABBITMQ_URL } from '../../config/env'
import logger from '@/config/logger'

// Declaramos las variables que mantendrán el estado de la conexión
let channelModel: ChannelModel | null = null
let connection: Connection | null = null
let channel: ConfirmChannel | null = null
let isConnecting = false // Una bandera para evitar múltiples intentos de reconexión simultáneos

// --- Nombres de nuestra topología ---
export const POS_EVENTS_EXCHANGE = 'pos_events_exchange'
export const POS_COMMANDS_EXCHANGE = 'pos_commands_exchange'
export const AVOQADO_EVENTS_QUEUE = 'avoqado_events_queue'
const DEAD_LETTER_EXCHANGE = 'dead_letter_exchange'
const AVOQADO_EVENTS_DLQ = 'avoqado_events_dead_letter_queue'

const connectWithRetry = async (): Promise<void> => {
  // Si ya estamos en proceso de conexión, no hacemos nada más
  if (isConnecting) return
  isConnecting = true

  try {
    logger.info('🐰 Conectando a RabbitMQ...')
    channelModel = await connect(RABBITMQ_URL)

    // Get the actual connection from the channel model
    connection = channelModel.connection

    channel = await channelModel.createConfirmChannel()

    // Verificaciones explícitas para satisfacer a TypeScript
    if (!channel) {
      throw new Error('No se pudo crear el canal.')
    }

    logger.info('✅🐰 Conexión con RabbitMQ establecida.')

    // --- Configuración de la Topología ---
    await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true })
    await channel.assertQueue(AVOQADO_EVENTS_DLQ, { durable: true })
    await channel.bindQueue(AVOQADO_EVENTS_DLQ, DEAD_LETTER_EXCHANGE, 'dead-letter')

    await channel.assertExchange(POS_EVENTS_EXCHANGE, 'topic', { durable: true })
    await channel.assertExchange(POS_COMMANDS_EXCHANGE, 'topic', { durable: true })

    await channel.assertQueue(AVOQADO_EVENTS_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
        'x-dead-letter-routing-key': 'dead-letter',
      },
    })
    logger.info('🐰 Topología de RabbitMQ asegurada.')

    // --- Manejadores de Eventos de la Conexión ---
    connection.on('error', (err: Error) => {
      logger.error('❌ Error de conexión con RabbitMQ:', err.message)
    })

    connection.on('close', () => {
      logger.warn('🚪 Conexión con RabbitMQ cerrada. Reintentando...')
      channelModel = null
      connection = null
      channel = null
      isConnecting = false
      setTimeout(connectWithRetry, 5000) // Reintenta en 5 segundos
    })

    isConnecting = false // La conexión fue exitosa, reseteamos la bandera
  } catch (error) {
    logger.error('🔥 Falla al conectar con RabbitMQ, reintentando...', error)
    isConnecting = false
    setTimeout(connectWithRetry, 5000)
  }
}

// Función principal para iniciar y obtener la conexión
export const connectToRabbitMQ = async (): Promise<void> => {
  logger.info('🐰 Connecting to RabbitMQ...')

  if (!channel) {
    await connectWithRetry()
  }
}

export const closeRabbitMQConnection = async (): Promise<void> => {
  try {
    let closedSomething = false
    if (channel) {
      await channel.close()
      channel = null
      closedSomething = true
    }
    if (channelModel) {
      await channelModel.close()
      channelModel = null
      connection = null
      closedSomething = true
    }
    if (closedSomething) {
      logger.info('✅ Conexión con RabbitMQ cerrada correctamente.')
    }
  } catch (error) {
    logger.error('❌ Error al cerrar la conexión con RabbitMQ:', error)
  }
}

// Función para obtener el canal de forma segura en otras partes de la app
export const getRabbitMQChannel = (): ConfirmChannel => {
  if (!channel) {
    throw new Error('El canal de RabbitMQ no ha sido inicializado. Asegúrate de llamar a connectToRabbitMQ() al iniciar la aplicación.')
  }
  return channel
}

// Add function to get connection if needed
export const getRabbitMQConnection = (): Connection => {
  if (!connection) {
    throw new Error('La conexión de RabbitMQ no ha sido inicializada. Asegúrate de llamar a connectToRabbitMQ() al iniciar la aplicación.')
  }
  return connection
}
