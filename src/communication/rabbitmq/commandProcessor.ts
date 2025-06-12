import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { CommandPayload, publishCommand } from './publisher'

let isProcessing = false

export async function processPendingCommands(): Promise<void> {
  if (isProcessing) {
    logger.info('🔄 Command processor is already running. Skipping...')
    return
  }

  isProcessing = true

  try {
    // 1. Find a limited number of pending commands to avoid overload
    const pendingCommands = await prisma.posCommand.findMany({
      where: { status: 'PENDING' },
      take: 10,
      orderBy: { createdAt: 'asc' }, // Process oldest first
      include: { venue: true }, // Include Venue to get posType
    })

    if (pendingCommands.length === 0) {
      return
    }

    logger.info(`📬 Found ${pendingCommands.length} pending commands. Processing...`)

    for (const command of pendingCommands) {
      try {
        // 2. Mark command as processing
        await prisma.posCommand.update({
          where: { id: command.id },
          data: {
            status: 'PROCESSING',
            lastAttemptAt: new Date(),
          },
        })

        // Validate venue has posType
        if (!command.venue.posType) {
          throw new Error(`Venue ${command.venueId} does not have a posType configured.`)
        }

        // 3. Build routing key dynamically
        const posType = command.venue.posType.toLowerCase()
        const routingKey = `command.${posType}.${command.venueId}`

        // 4. Create message payload with action
        const messagePayload: CommandPayload = {
          entity: command.entityType, // 'Order'
          action: command.commandType, // 'CREATE'
          payload: command.payload, // Original payload with data
        }

        // 5. Try to publish command to RabbitMQ
        await publishCommand(routingKey, messagePayload)

        logger.info(`✅ Command ${command.id} published successfully to RabbitMQ.`)

        // Optionally, you could mark it as 'PUBLISHED' here if you want that intermediate state
        // await prisma.posCommand.update({
        //   where: { id: command.id },
        //   data: { status: 'PUBLISHED' }
        // })
      } catch (error: any) {
        // If publication fails, mark as FAILED for manual review or retry
        logger.error(`❌ Error publishing command ${command.id}:`, error)

        await prisma.posCommand.update({
          where: { id: command.id },
          data: {
            status: 'FAILED',
            attempts: { increment: 1 },
            errorMessage: error.message,
          },
        })
      }
    }
  } catch (error) {
    logger.error('🚨 Fatal error in command processor:', error)
  } finally {
    isProcessing = false
  }
}

// Export a function to process a specific command by ID (useful for testing or manual processing)
export async function processCommandById(commandId: string): Promise<void> {
  try {
    const command = await prisma.posCommand.findUnique({
      where: { id: commandId },
      include: { venue: true },
    })

    if (!command) {
      throw new Error(`Command ${commandId} not found`)
    }

    if (command.status !== 'PENDING') {
      logger.warn(`Command ${commandId} is not in PENDING status. Current status: ${command.status}`)
      return
    }

    // Process just this command
    await processPendingCommands()
  } catch (error) {
    logger.error(`Error processing command ${commandId}:`, error)
    throw error
  }
}
