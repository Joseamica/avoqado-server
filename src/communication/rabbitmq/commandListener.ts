//src/communication/rabbitmq/commandListener.ts
import { Client } from 'pg'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { CommandPayload, publishCommand } from './publisher'

export type PosCommandDeliveryResult = 'COMPLETED' | 'FAILED' | 'SKIPPED'

const OPEN_RETRY_BASE_MS = 60_000
const OPEN_RETRY_MAX_MS = 15 * 60_000

function openRetryAt(attemptedAt: Date, previousAttempts: number): Date {
  const exponent = Math.min(Math.max(previousAttempts, 0), 30)
  const delay = Math.min(OPEN_RETRY_BASE_MS * 2 ** exponent, OPEN_RETRY_MAX_MS)
  return new Date(attemptedAt.getTime() + delay)
}

/**
 * Claims and delivers one command. The status transition is the cross-process
 * mutex: only one server can move PENDING -> PROCESSING, so LISTEN/NOTIFY and a
 * request-side best-effort delivery may race safely.
 */
export async function deliverPosCommand(commandId: string, attemptedAt = new Date()): Promise<PosCommandDeliveryResult> {
  const claimed = await prisma.posCommand.updateMany({
    where: {
      id: commandId,
      status: 'PENDING',
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: attemptedAt } }],
    },
    data: { status: 'PROCESSING', lastAttemptAt: attemptedAt },
  })

  if (claimed.count !== 1) {
    logger.info(`⏭️ Command ${commandId} already claimed, completed or not found`)
    return 'SKIPPED'
  }

  let durableOpen = false
  let previousAttempts = 0
  try {
    const command = await prisma.posCommand.findUnique({
      where: { id: commandId },
      include: { venue: true },
    })
    if (!command) throw new Error(`Command ${commandId} disappeared after claim`)
    if (!command.venue.posType) throw new Error(`Venue ${command.venueId} doesn't have a posType configured`)
    durableOpen = command.entityType === 'Shift' && command.action === 'OPEN' && command.dedupeKey != null
    previousAttempts = command.attempts

    const routingKey = `command.${command.venue.posType.toLowerCase()}.${command.venueId}`
    const messagePayload: CommandPayload = {
      entity: command.entityType,
      action: command.action ?? command.commandType,
      payload: command.payload,
    }

    await publishCommand(routingKey, messagePayload)

    await prisma.posCommand.updateMany({
      where: { id: command.id, status: 'PROCESSING' },
      data: { status: 'COMPLETED', completedAt: new Date(), nextAttemptAt: null, errorMessage: null },
    })
    logger.info(`✅ Command ${command.id} published successfully`)
    return 'COMPLETED'
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`❌ Error processing command ${commandId}:`, error)
    if (durableOpen) {
      await prisma.posCommand.updateMany({
        where: { id: commandId, status: 'PROCESSING' },
        data: {
          status: 'PENDING',
          attempts: { increment: 1 },
          nextAttemptAt: openRetryAt(attemptedAt, previousAttempts),
          errorMessage: message,
        },
      })
    } else {
      await prisma.posCommand.updateMany({
        where: { id: commandId, status: 'PROCESSING' },
        data: { status: 'FAILED', attempts: { increment: 1 }, errorMessage: message },
      })
    }
    return 'FAILED'
  }
}

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
      logger.info('🐘 Connected to PostgreSQL for LISTEN/NOTIFY (with Keep-Alive enabled)')

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

  private async processCommand(commandId: string, attemptedAt = new Date()): Promise<void> {
    // Prevent concurrent processing of the same command
    if (this.isProcessing) {
      logger.info('🔄 Already processing a command, queuing...')
      // You could implement a queue here if needed
      setTimeout(() => this.processCommand(commandId), 1000)
      return
    }

    this.isProcessing = true

    try {
      await deliverPosCommand(commandId, attemptedAt)
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
