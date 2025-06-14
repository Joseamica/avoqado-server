//src/communication/rabbitmq/commandListener.ts
import { Client } from 'pg'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { CommandPayload, publishCommand } from './publisher'

export class CommandListener {
  private pgClient: Client | null = null
  private isProcessing = false
  private reconnectTimeout: NodeJS.Timeout | null = null
  private isShuttingDown = false

  constructor(private connectionString: string) {}

  async start(): Promise<void> {
    logger.info('🎧 Starting PostgreSQL LISTEN/NOTIFY command listener...')
    await this.connect()
  }

  private async connect(): Promise<void> {
    if (this.isShuttingDown) return

    try {
      // Create a dedicated connection for LISTEN/NOTIFY
      this.pgClient = new Client({
        connectionString: this.connectionString,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000, // Enviar la primera señal después de 10s de inactividad
      })

      this.pgClient.on('error', err => {
        logger.error('❌ PostgreSQL client error:', err)
        this.scheduleReconnect()
      })

      this.pgClient.on('end', () => {
        logger.warn('🚪 PostgreSQL connection ended')
        this.scheduleReconnect()
      })

      await this.pgClient.connect()
      logger.info('✅ Connected to PostgreSQL for LISTEN/NOTIFY (with Keep-Alive enabled)')

      // Listen for notifications
      await this.pgClient.query('LISTEN new_pos_command')

      this.pgClient.on('notification', async msg => {
        if (msg.channel === 'new_pos_command' && msg.payload) {
          await this.handleNotification(msg.payload)
        }
      })

      // Process any commands that might have been added while disconnected
      await this.processExistingCommands()
    } catch (error) {
      logger.error('🔥 Failed to connect to PostgreSQL:', error)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.isShuttingDown || this.reconnectTimeout) return

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      this.connect()
    }, 5000)
  }

  private async handleNotification(payload: string): Promise<void> {
    try {
      const notification = JSON.parse(payload)
      logger.info(`📬 Received notification for command ${notification.id}`)

      // Process the specific command
      await this.processCommand(notification.id)
    } catch (error) {
      logger.error('❌ Error handling notification:', error)
    }
  }

  private async processCommand(commandId: string): Promise<void> {
    // Prevent concurrent processing of the same command
    if (this.isProcessing) {
      logger.info('🔄 Already processing a command, queuing...')
      // You could implement a queue here if needed
      setTimeout(() => this.processCommand(commandId), 1000)
      return
    }

    this.isProcessing = true

    try {
      // Fetch the full command with venue data
      const command = await prisma.posCommand.findUnique({
        where: { id: commandId },
        include: { venue: true },
      })

      if (!command || command.status !== 'PENDING') {
        logger.info(`⏭️ Command ${commandId} already processed or not found`)
        return
      }

      // Mark as processing
      await prisma.posCommand.update({
        where: { id: command.id },
        data: {
          status: 'PROCESSING',
          lastAttemptAt: new Date(),
        },
      })

      if (!command.venue.posType) {
        throw new Error(`Venue ${command.venueId} doesn't have a posType configured`)
      }

      // Build routing key
      const posType = command.venue.posType.toLowerCase()
      const routingKey = `command.${posType}.${command.venueId}`

      // Build message payload
      const messagePayload: CommandPayload = {
        entity: command.entityType,
        action: command.commandType,
        payload: command.payload,
      }

      // Publish to RabbitMQ
      await publishCommand(routingKey, messagePayload)

      logger.info(`✅ Command ${command.id} published successfully`)
    } catch (error: any) {
      logger.error(`❌ Error processing command ${commandId}:`, error)

      // Mark as failed
      await prisma.posCommand.update({
        where: { id: commandId },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          errorMessage: error.message,
        },
      })
    } finally {
      this.isProcessing = false
    }
  }

  private async processExistingCommands(): Promise<void> {
    logger.info('🔍 Checking for existing pending commands...')

    const pendingCommands = await prisma.posCommand.findMany({
      where: { status: 'PENDING' },
      take: 10,
      orderBy: { createdAt: 'asc' },
    })

    if (pendingCommands.length > 0) {
      logger.info(`📦 Found ${pendingCommands.length} pending commands to process`)

      for (const command of pendingCommands) {
        await this.processCommand(command.id)
      }
    }
  }

  async stop(): Promise<void> {
    logger.info('🛑 Stopping command listener...')
    this.isShuttingDown = true

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.pgClient) {
      try {
        await this.pgClient.query('UNLISTEN new_pos_command')
        await this.pgClient.end()
      } catch (error) {
        logger.error('Error closing PostgreSQL connection:', error)
      }
      this.pgClient = null
    }

    logger.info('✅ Command listener stopped')
  }
}
