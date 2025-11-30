/**
 * TPV Command Execution Service
 *
 * Handles the actual delivery of commands to TPV terminals via Socket.IO.
 * Integrates with command-queue.service.ts for offline queue management.
 *
 * Responsibilities:
 * - Send commands to online terminals
 * - Process offline queue when terminals reconnect
 * - Execute bulk command operations
 * - Process scheduled commands
 * - Handle command ACK flows from terminals
 *
 * Inspired by:
 * - Stripe Terminal action dispatching
 * - MDM push notification patterns
 */

import { TpvCommandType, TpvCommandStatus, TpvCommandResultStatus, BulkCommandOperationStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { NotFoundError, BadRequestError } from '../../errors/AppError'
import { socketManager } from '../../communication/sockets'
import { SocketEventType } from '../../communication/sockets/types'
import { tpvCommandQueueService, QueueCommandInput, CommandQueueResult } from './command-queue.service'

/**
 * Command payload sent to terminal via Socket.IO
 */
export interface CommandPayload {
  commandId: string
  correlationId: string
  type: TpvCommandType
  payload: Record<string, any>
  requiresPin: boolean
  priority: string
  expiresAt: Date
  requestedBy: string
  requestedByName?: string
}

/**
 * Bulk command input for executing same command across multiple terminals
 */
export interface BulkCommandInput {
  terminalIds: string[]
  venueId: string
  commandType: TpvCommandType
  payload?: Record<string, any>
  requestedBy: string
  requestedByName?: string
  scheduledFor?: Date
}

/**
 * Result of bulk command operation
 */
export interface BulkCommandResult {
  operationId: string
  totalTerminals: number
  queued: number
  sent: number
  failed: number
  status: BulkCommandOperationStatus
}

/**
 * TPV Command Execution Service
 */
export class TpvCommandExecutionService {
  private readonly ONLINE_THRESHOLD_MS = 2 * 60 * 1000 // 2 minutes

  /**
   * Execute a single command to a terminal
   * Queues if offline, sends immediately if online
   */
  async executeCommand(input: QueueCommandInput): Promise<CommandQueueResult> {
    // Queue the command (handles validation, offline detection)
    const queueResult = await tpvCommandQueueService.queueCommand(input)

    // If terminal is online and command is ready, send immediately
    if (queueResult.terminalOnline && queueResult.status === 'QUEUED') {
      await this.sendCommandToTerminal(queueResult.commandId)
    }

    return queueResult
  }

  /**
   * Execute bulk command across multiple terminals
   */
  async executeBulkCommand(input: BulkCommandInput): Promise<BulkCommandResult> {
    const { terminalIds, venueId, commandType, payload, requestedBy, requestedByName, scheduledFor } = input

    if (terminalIds.length === 0) {
      throw new BadRequestError('At least one terminal ID is required')
    }

    // Verify all terminals belong to the venue
    const terminals = await prisma.terminal.findMany({
      where: {
        id: { in: terminalIds },
        venueId,
      },
      select: { id: true, name: true },
    })

    if (terminals.length !== terminalIds.length) {
      throw new BadRequestError('Some terminals not found or do not belong to this venue')
    }

    // Create bulk operation record
    const bulkOperation = await prisma.bulkCommandOperation.create({
      data: {
        venueId,
        commandType,
        payload: payload || {},
        terminalIds,
        totalTerminals: terminalIds.length,
        requestedBy,
        requestedByName: requestedByName || 'Unknown',
        scheduledFor,
        status: scheduledFor ? 'PENDING' : 'IN_PROGRESS',
      },
    })

    let queued = 0
    let sent = 0
    let failed = 0

    // Queue commands for each terminal
    for (const terminalId of terminalIds) {
      try {
        const result = await this.executeCommand({
          terminalId,
          venueId,
          commandType,
          payload,
          requestedBy,
          requestedByName,
          scheduledFor,
          bulkOperationId: bulkOperation.id,
        })

        if (result.queued) {
          queued++
        } else {
          sent++
        }
      } catch (error) {
        failed++
        logger.error(`Failed to queue command for terminal ${terminalId}`, {
          error: error instanceof Error ? error.message : 'Unknown error',
          bulkOperationId: bulkOperation.id,
        })
      }
    }

    // Update bulk operation with results
    const finalStatus: BulkCommandOperationStatus =
      failed === terminalIds.length
        ? 'FAILED'
        : sent + queued === terminalIds.length
          ? scheduledFor
            ? 'PENDING'
            : 'COMPLETED'
          : 'PARTIALLY_COMPLETED'

    await prisma.bulkCommandOperation.update({
      where: { id: bulkOperation.id },
      data: {
        completedTerminals: sent,
        failedTerminals: failed,
        status: finalStatus,
        completedAt: finalStatus !== 'PENDING' ? new Date() : undefined,
      },
    })

    logger.info(`Bulk command operation completed`, {
      operationId: bulkOperation.id,
      commandType,
      totalTerminals: terminalIds.length,
      queued,
      sent,
      failed,
    })

    return {
      operationId: bulkOperation.id,
      totalTerminals: terminalIds.length,
      queued,
      sent,
      failed,
      status: finalStatus,
    }
  }

  /**
   * Send a queued command to terminal via Socket.IO
   */
  async sendCommandToTerminal(commandId: string): Promise<void> {
    const command = await prisma.tpvCommandQueue.findUnique({
      where: { id: commandId },
      include: {
        terminal: {
          select: {
            id: true,
            name: true,
            serialNumber: true,
            venueId: true,
            lastHeartbeat: true,
          },
        },
      },
    })

    if (!command) {
      throw new NotFoundError(`Command ${commandId} not found`)
    }

    // Check if terminal is online
    const cutoff = new Date(Date.now() - this.ONLINE_THRESHOLD_MS)
    const isOnline = command.terminal.lastHeartbeat && command.terminal.lastHeartbeat > cutoff

    if (!isOnline) {
      logger.info(`Terminal ${command.terminalId} is offline, command remains queued`, {
        commandId,
        correlationId: command.correlationId,
      })
      return
    }

    // Prepare command payload
    const commandPayload: CommandPayload = {
      commandId: command.id,
      correlationId: command.correlationId,
      type: command.commandType,
      payload: command.payload as Record<string, any>,
      requiresPin: command.requiresPin,
      priority: command.priority,
      expiresAt: command.expiresAt,
      requestedBy: command.requestedBy,
      requestedByName: command.requestedByName || undefined,
    }

    // Send via Socket.IO to the specific terminal
    const server = socketManager.getServer()
    if (!server) {
      logger.error('Socket server not initialized, cannot send command')
      return
    }

    // Emit to venue room (terminals subscribe to their venue room)
    // The terminal will filter by its own ID
    server.to(`venue_${command.terminal.venueId}`).emit(SocketEventType.TPV_COMMAND_SEND, {
      terminalId: command.terminal.serialNumber || command.terminal.id,
      ...commandPayload,
      timestamp: new Date(),
    })

    // Update command status to SENT
    await tpvCommandQueueService.updateCommandStatus(commandId, 'SENT')

    logger.info(`Command sent to terminal ${command.terminalId}`, {
      commandId,
      correlationId: command.correlationId,
      commandType: command.commandType,
      terminalSerialNumber: command.terminal.serialNumber,
    })
  }

  /**
   * Process pending commands when terminal comes online
   * Called from heartbeat processing
   */
  async processOfflineQueue(terminalId: string): Promise<number> {
    const pendingCommands = await tpvCommandQueueService.getPendingCommandsForTerminal(terminalId)

    if (pendingCommands.length === 0) {
      return 0
    }

    logger.info(`Processing ${pendingCommands.length} queued commands for terminal ${terminalId}`)

    let sentCount = 0
    for (const command of pendingCommands) {
      try {
        await this.sendCommandToTerminal(command.id)
        sentCount++
      } catch (error) {
        logger.error(`Failed to send queued command ${command.id}`, {
          error: error instanceof Error ? error.message : 'Unknown error',
          terminalId,
        })
      }
    }

    return sentCount
  }

  /**
   * Handle command ACK from terminal (received acknowledgment)
   */
  async handleCommandAck(commandId: string, terminalId: string, receivedAt: Date): Promise<void> {
    await tpvCommandQueueService.handleCommandAck(commandId, terminalId)

    logger.info(`Command ACK received`, {
      commandId,
      terminalId,
      receivedAt,
    })
  }

  /**
   * Handle command execution started notification from terminal
   */
  async handleCommandStarted(commandId: string, terminalId: string, startedAt: Date): Promise<void> {
    await tpvCommandQueueService.handleCommandStarted(commandId, terminalId)

    logger.info(`Command execution started`, {
      commandId,
      terminalId,
      startedAt,
    })
  }

  /**
   * Handle command execution result from terminal
   */
  async handleCommandResult(
    commandId: string,
    terminalId: string,
    resultStatus: TpvCommandResultStatus,
    message?: string,
    resultData?: Record<string, any>,
  ): Promise<void> {
    await tpvCommandQueueService.handleCommandResult(commandId, terminalId, resultStatus, message, resultData)

    // Update bulk operation progress if applicable
    const command = await prisma.tpvCommandQueue.findUnique({
      where: { id: commandId },
      select: { bulkOperationId: true },
    })

    if (command?.bulkOperationId) {
      await this.updateBulkOperationProgress(command.bulkOperationId)
    }

    logger.info(`Command execution completed`, {
      commandId,
      terminalId,
      resultStatus,
      message,
    })
  }

  /**
   * Cancel a pending or queued command
   */
  async cancelCommand(commandId: string, cancelledBy: string, reason?: string): Promise<void> {
    const command = await prisma.tpvCommandQueue.findUnique({
      where: { id: commandId },
      include: {
        terminal: {
          select: {
            id: true,
            serialNumber: true,
            venueId: true,
            lastHeartbeat: true,
          },
        },
      },
    })

    if (!command) {
      throw new NotFoundError(`Command ${commandId} not found`)
    }

    // Cancel in queue
    await tpvCommandQueueService.cancelCommand(commandId, cancelledBy, reason)

    // If terminal is online, notify it to cancel
    const cutoff = new Date(Date.now() - this.ONLINE_THRESHOLD_MS)
    const isOnline = command.terminal.lastHeartbeat && command.terminal.lastHeartbeat > cutoff

    if (isOnline) {
      const server = socketManager.getServer()
      if (server) {
        server.to(`venue_${command.terminal.venueId}`).emit(SocketEventType.TPV_COMMAND_CANCELLED, {
          terminalId: command.terminal.serialNumber || command.terminal.id,
          commandId: command.id,
          correlationId: command.correlationId,
          cancelledBy,
          reason,
          timestamp: new Date(),
        })
      }
    }

    logger.info(`Command cancelled`, {
      commandId,
      correlationId: command.correlationId,
      cancelledBy,
      reason,
      notifiedTerminal: isOnline,
    })
  }

  /**
   * Process scheduled commands that are due
   * Should be called periodically (every minute)
   */
  async processScheduledCommands(): Promise<number> {
    const now = new Date()

    // Find scheduled commands that are due
    const dueCommands = await prisma.tpvCommandQueue.findMany({
      where: {
        status: 'PENDING',
        scheduledFor: { lte: now },
        expiresAt: { gt: now },
      },
      include: {
        terminal: {
          select: {
            id: true,
            lastHeartbeat: true,
          },
        },
      },
    })

    let processedCount = 0

    for (const command of dueCommands) {
      // Check if terminal is online
      const cutoff = new Date(Date.now() - this.ONLINE_THRESHOLD_MS)
      const isOnline = command.terminal.lastHeartbeat && command.terminal.lastHeartbeat > cutoff

      if (isOnline) {
        try {
          await this.sendCommandToTerminal(command.id)
          processedCount++
        } catch (error) {
          logger.error(`Failed to send scheduled command ${command.id}`, {
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      } else {
        // Update status to QUEUED (waiting for terminal to come online)
        await prisma.tpvCommandQueue.update({
          where: { id: command.id },
          data: { status: 'QUEUED' },
        })
      }
    }

    if (processedCount > 0) {
      logger.info(`Processed ${processedCount} scheduled commands`)
    }

    return processedCount
  }

  /**
   * Update bulk operation progress based on individual command results
   */
  private async updateBulkOperationProgress(bulkOperationId: string): Promise<void> {
    const operation = await prisma.bulkCommandOperation.findUnique({
      where: { id: bulkOperationId },
    })

    if (!operation) return

    // Count completed and failed commands
    const commandStats = await prisma.tpvCommandQueue.groupBy({
      by: ['status'],
      where: { bulkOperationId },
      _count: true,
    })

    let completed = 0
    let failed = 0
    let pending = 0

    for (const stat of commandStats) {
      if (stat.status === 'COMPLETED') {
        completed += stat._count
      } else if (stat.status === 'FAILED' || stat.status === 'EXPIRED' || stat.status === 'CANCELLED') {
        failed += stat._count
      } else {
        pending += stat._count
      }
    }

    // Determine operation status
    let status: BulkCommandOperationStatus = 'IN_PROGRESS'
    if (pending === 0) {
      if (failed === operation.totalTerminals) {
        status = 'FAILED'
      } else if (completed === operation.totalTerminals) {
        status = 'COMPLETED'
      } else {
        status = 'PARTIALLY_COMPLETED'
      }
    }

    await prisma.bulkCommandOperation.update({
      where: { id: bulkOperationId },
      data: {
        completedTerminals: completed,
        failedTerminals: failed,
        status,
        completedAt: pending === 0 ? new Date() : undefined,
      },
    })

    // Broadcast progress to dashboard
    const { broadcastTpvBulkOperationProgress } = await import('../../communication/sockets')
    if (typeof broadcastTpvBulkOperationProgress === 'function') {
      broadcastTpvBulkOperationProgress(operation.venueId, {
        operationId: bulkOperationId,
        commandType: operation.commandType,
        totalTerminals: operation.totalTerminals,
        completedTerminals: completed,
        failedTerminals: failed,
        pendingTerminals: pending,
        status,
        completedAt: pending === 0 ? new Date() : undefined,
      })
    }
  }

  /**
   * Get command status for dashboard display
   */
  async getCommandStatus(commandId: string): Promise<any> {
    const command = await prisma.tpvCommandQueue.findUnique({
      where: { id: commandId },
      include: {
        terminal: {
          select: {
            id: true,
            name: true,
            serialNumber: true,
          },
        },
        history: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    })

    if (!command) {
      throw new NotFoundError(`Command ${commandId} not found`)
    }

    return command
  }

  /**
   * Get bulk operation status
   */
  async getBulkOperationStatus(operationId: string): Promise<any> {
    const operation = await prisma.bulkCommandOperation.findUnique({
      where: { id: operationId },
    })

    if (!operation) {
      throw new NotFoundError(`Bulk operation ${operationId} not found`)
    }

    // Get individual command statuses
    const commands = await prisma.tpvCommandQueue.findMany({
      where: { bulkOperationId: operationId },
      include: {
        terminal: {
          select: {
            id: true,
            name: true,
            serialNumber: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return {
      ...operation,
      commands,
    }
  }
}

// Export singleton instance
export const tpvCommandExecutionService = new TpvCommandExecutionService()
