/**
 * TPV Command Queue Service
 *
 * Manages the queuing, delivery, and tracking of remote commands to TPV terminals.
 * Implements offline queue support, retry logic, and full ACK tracking.
 *
 * Inspired by:
 * - Stripe Terminal Fleet Management configurations
 * - Fleet MDM command queue patterns
 *
 * Key Features:
 * - Offline Queue: Commands stored until terminal reconnects
 * - Retry Logic: Configurable retry attempts with exponential backoff
 * - Full ACK System: Track command through entire lifecycle
 * - Audit Trail: Complete history of all command executions
 */

import {
  TpvCommandType,
  TpvCommandPriority,
  TpvCommandStatus,
  TpvCommandResultStatus,
  TpvCommandHistoryStatus,
  TpvCommandSource,
  TerminalStatus,
} from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { NotFoundError, BadRequestError } from '../../errors/AppError'
import { broadcastTpvCommandStatusChanged, broadcastTpvCommandQueued, broadcastTpvStatusUpdate } from '../../communication/sockets'

/**
 * Command configuration per type
 * Defines PIN requirements, risk level, and validation rules
 */
const COMMAND_CONFIG: Record<
  TpvCommandType,
  {
    requiresPin: boolean
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
    defaultPriority: TpvCommandPriority
    maxRetries: number
    expirationMinutes: number
    doubleConfirm: boolean
  }
> = {
  LOCK: {
    requiresPin: false,
    riskLevel: 'MEDIUM',
    defaultPriority: 'HIGH',
    maxRetries: 3,
    expirationMinutes: 60,
    doubleConfirm: false,
  },
  UNLOCK: {
    requiresPin: true,
    riskLevel: 'HIGH',
    defaultPriority: 'HIGH',
    maxRetries: 3,
    expirationMinutes: 60,
    doubleConfirm: false,
  },
  MAINTENANCE_MODE: {
    requiresPin: false,
    riskLevel: 'MEDIUM',
    defaultPriority: 'NORMAL',
    maxRetries: 3,
    expirationMinutes: 120,
    doubleConfirm: false,
  },
  EXIT_MAINTENANCE: {
    requiresPin: false,
    riskLevel: 'LOW',
    defaultPriority: 'NORMAL',
    maxRetries: 3,
    expirationMinutes: 120,
    doubleConfirm: false,
  },
  REACTIVATE: {
    requiresPin: true,
    riskLevel: 'HIGH',
    defaultPriority: 'HIGH',
    maxRetries: 3,
    expirationMinutes: 120,
    doubleConfirm: false,
  },
  REMOTE_ACTIVATE: {
    requiresPin: false, // SUPERADMIN only - PIN not required
    riskLevel: 'HIGH',
    defaultPriority: 'HIGH',
    maxRetries: 3,
    expirationMinutes: 1440, // 24 hours - terminal may not be connected yet
    doubleConfirm: false,
  },
  RESTART: {
    requiresPin: false,
    riskLevel: 'MEDIUM',
    defaultPriority: 'NORMAL',
    maxRetries: 2,
    expirationMinutes: 30,
    doubleConfirm: false,
  },
  SHUTDOWN: {
    requiresPin: true,
    riskLevel: 'HIGH',
    defaultPriority: 'NORMAL',
    maxRetries: 2,
    expirationMinutes: 30,
    doubleConfirm: false,
  },
  CLEAR_CACHE: {
    requiresPin: false,
    riskLevel: 'LOW',
    defaultPriority: 'LOW',
    maxRetries: 3,
    expirationMinutes: 60,
    doubleConfirm: false,
  },
  FORCE_UPDATE: {
    requiresPin: true,
    riskLevel: 'HIGH',
    defaultPriority: 'NORMAL',
    maxRetries: 2,
    expirationMinutes: 60,
    doubleConfirm: false,
  },
  REQUEST_UPDATE: {
    requiresPin: false, // User decides - just a suggestion
    riskLevel: 'LOW',
    defaultPriority: 'NORMAL',
    maxRetries: 1,
    expirationMinutes: 1440, // 24h validity
    doubleConfirm: false,
  },
  INSTALL_VERSION: {
    requiresPin: true, // SUPERADMIN only - requires PIN for rollback
    riskLevel: 'HIGH',
    defaultPriority: 'HIGH',
    maxRetries: 2,
    expirationMinutes: 60, // 1h validity
    doubleConfirm: true, // Confirm before installing specific version
  },
  SYNC_DATA: {
    requiresPin: false,
    riskLevel: 'LOW',
    defaultPriority: 'LOW',
    maxRetries: 5,
    expirationMinutes: 30,
    doubleConfirm: false,
  },
  FACTORY_RESET: {
    requiresPin: true,
    riskLevel: 'CRITICAL',
    defaultPriority: 'CRITICAL',
    maxRetries: 1,
    expirationMinutes: 30,
    doubleConfirm: true,
  },
  EXPORT_LOGS: {
    requiresPin: false,
    riskLevel: 'LOW',
    defaultPriority: 'LOW',
    maxRetries: 3,
    expirationMinutes: 60,
    doubleConfirm: false,
  },
  UPDATE_CONFIG: {
    requiresPin: false,
    riskLevel: 'MEDIUM',
    defaultPriority: 'NORMAL',
    maxRetries: 3,
    expirationMinutes: 60,
    doubleConfirm: false,
  },
  REFRESH_MENU: {
    requiresPin: false,
    riskLevel: 'LOW',
    defaultPriority: 'LOW',
    maxRetries: 5,
    expirationMinutes: 30,
    doubleConfirm: false,
  },
  UPDATE_MERCHANT: {
    requiresPin: true,
    riskLevel: 'HIGH',
    defaultPriority: 'HIGH',
    maxRetries: 2,
    expirationMinutes: 60,
    doubleConfirm: false,
  },
  SCHEDULE: {
    requiresPin: false,
    riskLevel: 'MEDIUM',
    defaultPriority: 'NORMAL',
    maxRetries: 1,
    expirationMinutes: 1440, // 24 hours
    doubleConfirm: false,
  },
  GEOFENCE_TRIGGER: {
    requiresPin: false,
    riskLevel: 'MEDIUM',
    defaultPriority: 'NORMAL',
    maxRetries: 3,
    expirationMinutes: 60,
    doubleConfirm: false,
  },
  TIME_RULE: {
    requiresPin: false,
    riskLevel: 'MEDIUM',
    defaultPriority: 'NORMAL',
    maxRetries: 3,
    expirationMinutes: 60,
    doubleConfirm: false,
  },
}

export interface QueueCommandInput {
  terminalId: string
  venueId: string
  commandType: TpvCommandType
  payload?: Record<string, any>
  priority?: TpvCommandPriority
  scheduledFor?: Date
  requestedBy: string
  requestedByName?: string
  source?: TpvCommandSource
  bulkOperationId?: string
}

export interface CommandQueueResult {
  commandId: string
  correlationId: string
  status: TpvCommandStatus
  queued: boolean
  terminalOnline: boolean
  message: string
}

/**
 * TPV Command Queue Service
 * Manages command queuing, delivery, and lifecycle tracking
 */
export class TpvCommandQueueService {
  /**
   * Queue a command for a terminal
   * If terminal is online, send immediately. If offline, queue for later.
   */
  async queueCommand(input: QueueCommandInput): Promise<CommandQueueResult> {
    const {
      terminalId,
      venueId,
      commandType,
      payload,
      priority,
      scheduledFor,
      requestedBy,
      requestedByName,
      source = 'DASHBOARD',
      bulkOperationId,
    } = input

    // Get command configuration
    const config = COMMAND_CONFIG[commandType]
    if (!config) {
      throw new BadRequestError(`Invalid command type: ${commandType}`)
    }

    // Get terminal and check status
    const terminal = await prisma.terminal.findUnique({
      where: { id: terminalId },
      select: {
        id: true,
        name: true,
        serialNumber: true,
        status: true,
        lastHeartbeat: true,
        isLocked: true,
        venueId: true,
        venue: {
          select: { name: true },
        },
      },
    })

    if (!terminal) {
      throw new NotFoundError(`Terminal ${terminalId} not found`)
    }

    if (terminal.venueId !== venueId) {
      throw new BadRequestError('Terminal does not belong to this venue')
    }

    // Validate command against terminal state
    await this.validateCommandForTerminal(commandType, terminal)

    // Calculate expiration
    const expiresAt = new Date(Date.now() + config.expirationMinutes * 60 * 1000)

    // Check if terminal is online (heartbeat within last 2 minutes)
    const cutoff = new Date(Date.now() - 2 * 60 * 1000)
    const isOnline = !!(terminal.lastHeartbeat && terminal.lastHeartbeat > cutoff)

    // Determine initial status
    const initialStatus: TpvCommandStatus = scheduledFor
      ? 'PENDING' // Scheduled for later
      : isOnline
        ? 'QUEUED' // Ready to send
        : 'PENDING' // Terminal offline

    // Create command queue entry
    const command = await prisma.tpvCommandQueue.create({
      data: {
        terminalId,
        venueId,
        commandType,
        payload: payload || {},
        priority: priority || config.defaultPriority,
        status: initialStatus,
        maxAttempts: config.maxRetries,
        scheduledFor,
        expiresAt,
        requestedBy,
        requestedByName,
        requiresPin: config.requiresPin,
        bulkOperationId,
      },
    })

    // Create initial history entry
    await this.createHistoryEntry(command.id, terminal, {
      status: 'SENT',
      source,
      requestedBy,
      requestedByName,
    })

    // Broadcast status update to dashboard
    if (!isOnline && !scheduledFor) {
      await this.broadcastQueuedNotification(command, terminal)
    }

    logger.info(`Command queued for terminal ${terminalId}`, {
      commandId: command.id,
      correlationId: command.correlationId,
      commandType,
      status: initialStatus,
      isOnline,
      terminalId,
      venueId,
    })

    return {
      commandId: command.id,
      correlationId: command.correlationId,
      status: initialStatus,
      queued: !isOnline || !!scheduledFor,
      terminalOnline: isOnline,
      message: isOnline
        ? scheduledFor
          ? `Command scheduled for ${scheduledFor.toISOString()}`
          : 'Command sent to terminal'
        : 'Terminal offline - command queued',
    }
  }

  /**
   * Get pending commands for a terminal
   * Called when terminal comes online or on heartbeat
   */
  async getPendingCommandsForTerminal(terminalId: string): Promise<any[]> {
    const now = new Date()

    return prisma.tpvCommandQueue.findMany({
      where: {
        terminalId,
        status: { in: ['PENDING', 'QUEUED'] },
        OR: [
          { scheduledFor: null },
          { scheduledFor: { lte: now } }, // Scheduled time has passed
        ],
        expiresAt: { gt: now }, // Not expired
      },
      orderBy: [
        { priority: 'desc' }, // CRITICAL > HIGH > NORMAL > LOW
        { createdAt: 'asc' }, // FIFO within same priority
      ],
    })
  }

  /**
   * Update command status (called by ACK handlers)
   */
  async updateCommandStatus(
    commandId: string,
    newStatus: TpvCommandStatus,
    resultStatus?: TpvCommandResultStatus,
    resultMessage?: string,
  ): Promise<void> {
    const command = await prisma.tpvCommandQueue.findUnique({
      where: { id: commandId },
      include: {
        terminal: {
          select: { id: true, name: true, serialNumber: true, venueId: true },
        },
      },
    })

    if (!command) {
      throw new NotFoundError(`Command ${commandId} not found`)
    }

    const previousStatus = command.status

    // Update command status
    await prisma.tpvCommandQueue.update({
      where: { id: commandId },
      data: {
        status: newStatus,
        resultStatus,
        resultMessage,
        executedAt: newStatus === 'COMPLETED' || newStatus === 'FAILED' ? new Date() : undefined,
        attempts: ['SENT', 'RECEIVED', 'EXECUTING'].includes(newStatus) ? { increment: 1 } : undefined,
      },
    })

    // Create history entry
    const historyStatus = this.mapCommandStatusToHistoryStatus(newStatus, resultStatus)
    await this.createHistoryEntry(commandId, command.terminal, {
      status: historyStatus,
      resultMessage,
    })

    // Broadcast status change to dashboard
    await this.broadcastStatusChange(command, previousStatus, newStatus, resultMessage)

    logger.info(`Command status updated`, {
      commandId,
      correlationId: command.correlationId,
      previousStatus,
      newStatus,
      resultStatus,
      terminalId: command.terminalId,
    })
  }

  /**
   * Handle command ACK from terminal
   */
  async handleCommandAck(commandId: string, terminalId: string): Promise<void> {
    await this.updateCommandStatus(commandId, 'RECEIVED')
  }

  /**
   * Handle command execution started
   */
  async handleCommandStarted(commandId: string, terminalId: string): Promise<void> {
    await this.updateCommandStatus(commandId, 'EXECUTING')
  }

  /**
   * Handle command result from terminal
   */
  async handleCommandResult(
    commandId: string,
    terminalId: string,
    resultStatus: TpvCommandResultStatus,
    message?: string,
    resultData?: Record<string, any>,
  ): Promise<void> {
    const finalStatus: TpvCommandStatus = resultStatus === 'SUCCESS' || resultStatus === 'PARTIAL_SUCCESS' ? 'COMPLETED' : 'FAILED'

    const command = await prisma.tpvCommandQueue.findUnique({
      where: { id: commandId },
    })

    if (!command) {
      throw new NotFoundError(`Command ${commandId} not found`)
    }

    // Update command with result
    await prisma.tpvCommandQueue.update({
      where: { id: commandId },
      data: {
        status: finalStatus,
        resultStatus,
        resultMessage: message,
        executedAt: new Date(),
      },
    })

    // Update terminal state based on command result
    if (resultStatus === 'SUCCESS') {
      const updatedTerminal = await this.updateTerminalStateForCommand(command.terminalId, command.commandType)

      // Broadcast terminal status update to dashboard (fixes maintenance exit not refreshing)
      if (updatedTerminal) {
        try {
          broadcastTpvStatusUpdate(updatedTerminal.id, updatedTerminal.venueId, {
            status: updatedTerminal.status,
            isLocked: updatedTerminal.isLocked,
            lastHeartbeat: updatedTerminal.lastHeartbeat ?? undefined,
          })
          logger.info('Broadcast terminal status update after command completion', {
            terminalId: updatedTerminal.id,
            commandType: command.commandType,
            newStatus: updatedTerminal.status,
          })
        } catch (error) {
          logger.warn('Failed to broadcast terminal status update', { error, terminalId: updatedTerminal.id })
        }
      }
    }

    await this.updateCommandStatus(commandId, finalStatus, resultStatus, message)
  }

  /**
   * Cancel a pending command
   */
  async cancelCommand(commandId: string, cancelledBy: string, reason?: string): Promise<void> {
    const command = await prisma.tpvCommandQueue.findUnique({
      where: { id: commandId },
      include: {
        terminal: {
          select: { id: true, name: true, serialNumber: true, venueId: true },
        },
      },
    })

    if (!command) {
      throw new NotFoundError(`Command ${commandId} not found`)
    }

    if (!['PENDING', 'QUEUED'].includes(command.status)) {
      throw new BadRequestError(`Cannot cancel command in status ${command.status}. Only PENDING or QUEUED commands can be cancelled.`)
    }

    await prisma.tpvCommandQueue.update({
      where: { id: commandId },
      data: {
        status: 'CANCELLED',
        resultMessage: reason || 'Cancelled by user',
      },
    })

    await this.createHistoryEntry(commandId, command.terminal, {
      status: 'CANCELLED',
      resultMessage: reason || `Cancelled by ${cancelledBy}`,
    })

    logger.info(`Command cancelled`, {
      commandId,
      correlationId: command.correlationId,
      cancelledBy,
      reason,
    })
  }

  /**
   * Get command history for a terminal
   */
  async getCommandHistory(
    terminalId: string,
    venueId: string,
    options?: {
      limit?: number
      offset?: number
      commandType?: TpvCommandType
      status?: TpvCommandStatus
    },
  ): Promise<{ commands: any[]; total: number }> {
    const where: any = {
      terminalId,
      venueId,
    }

    if (options?.commandType) {
      where.commandType = options.commandType
    }
    if (options?.status) {
      where.status = options.status
    }

    const [commands, total] = await Promise.all([
      prisma.tpvCommandQueue.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: options?.limit || 50,
        skip: options?.offset || 0,
        include: {
          history: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
      }),
      prisma.tpvCommandQueue.count({ where }),
    ])

    return { commands, total }
  }

  /**
   * Process expired commands
   * Should be called periodically (e.g., every minute)
   */
  async processExpiredCommands(): Promise<number> {
    const now = new Date()

    const expiredCommands = await prisma.tpvCommandQueue.findMany({
      where: {
        status: { in: ['PENDING', 'QUEUED', 'SENT', 'RECEIVED', 'EXECUTING'] },
        expiresAt: { lt: now },
      },
      include: {
        terminal: {
          select: { id: true, name: true, serialNumber: true, venueId: true },
        },
      },
    })

    for (const command of expiredCommands) {
      await prisma.tpvCommandQueue.update({
        where: { id: command.id },
        data: {
          status: 'EXPIRED',
          resultStatus: 'TIMEOUT',
          resultMessage: 'Command expired before execution',
        },
      })

      await this.createHistoryEntry(command.id, command.terminal, {
        status: 'TIMEOUT',
        resultMessage: 'Command expired before execution',
      })
    }

    if (expiredCommands.length > 0) {
      logger.info(`Processed ${expiredCommands.length} expired commands`)
    }

    return expiredCommands.length
  }

  // ==================== Private Helper Methods ====================

  /**
   * Validate command is allowed for terminal's current state
   */
  private async validateCommandForTerminal(
    commandType: TpvCommandType,
    terminal: {
      status: TerminalStatus
      isLocked: boolean
    },
  ): Promise<void> {
    // Can't wipe a locked terminal
    if (commandType === 'FACTORY_RESET' && terminal.isLocked) {
      throw new BadRequestError('Cannot factory reset a locked terminal. Unlock it first.')
    }

    // Can't lock an already locked terminal
    if (commandType === 'LOCK' && terminal.isLocked) {
      throw new BadRequestError('Terminal is already locked')
    }

    // Can't unlock a non-locked terminal
    if (commandType === 'UNLOCK' && !terminal.isLocked) {
      throw new BadRequestError('Terminal is not locked')
    }

    // Can't exit maintenance if not in maintenance
    if (commandType === 'EXIT_MAINTENANCE' && terminal.status !== TerminalStatus.MAINTENANCE) {
      throw new BadRequestError('Terminal is not in maintenance mode')
    }
  }

  /**
   * Update terminal state after successful command execution
   * Returns the updated terminal data for broadcasting
   */
  private async updateTerminalStateForCommand(
    terminalId: string,
    commandType: TpvCommandType,
  ): Promise<{ id: string; name: string; venueId: string; status: TerminalStatus; isLocked: boolean; lastHeartbeat: Date | null } | null> {
    const updates: any = {}

    switch (commandType) {
      case 'LOCK':
        updates.isLocked = true
        updates.lockedAt = new Date()
        break
      case 'UNLOCK':
        updates.isLocked = false
        updates.lockReason = null
        updates.lockMessage = null
        updates.lockedAt = null
        updates.lockedBy = null
        break
      case 'MAINTENANCE_MODE':
        updates.status = TerminalStatus.MAINTENANCE
        break
      case 'EXIT_MAINTENANCE':
        updates.status = TerminalStatus.ACTIVE
        break
      case 'SHUTDOWN':
        updates.status = TerminalStatus.INACTIVE
        break
      case 'REACTIVATE':
        updates.status = TerminalStatus.ACTIVE
        updates.isLocked = false
        break
    }

    if (Object.keys(updates).length > 0) {
      const terminal = await prisma.terminal.update({
        where: { id: terminalId },
        data: {
          ...updates,
          updatedAt: new Date(),
        },
        select: {
          id: true,
          name: true,
          venueId: true,
          status: true,
          isLocked: true,
          lastHeartbeat: true,
        },
      })
      return terminal
    }
    return null
  }

  /**
   * Create command history entry
   */
  private async createHistoryEntry(
    commandQueueId: string,
    terminal: { id: string; name: string; serialNumber: string | null; venueId: string },
    data: {
      status: TpvCommandHistoryStatus
      source?: TpvCommandSource
      requestedBy?: string
      requestedByName?: string
      resultMessage?: string
      errorCode?: string
    },
  ): Promise<void> {
    const command = await prisma.tpvCommandQueue.findUnique({
      where: { id: commandQueueId },
      include: {
        venue: { select: { name: true } },
      },
    })

    if (!command) return

    await prisma.tpvCommandHistory.create({
      data: {
        commandQueueId,
        terminalId: terminal.id,
        terminalSerial: terminal.serialNumber || terminal.id,
        terminalName: terminal.name,
        venueId: terminal.venueId,
        venueName: command.venue.name,
        commandType: command.commandType,
        payload: command.payload || {},
        status: data.status,
        executedAt: data.status === 'COMPLETED' ? new Date() : undefined,
        resultMessage: data.resultMessage,
        errorCode: data.errorCode,
        source: data.source || 'DASHBOARD',
        requestedBy: data.requestedBy || command.requestedBy,
        requestedByName: data.requestedByName || command.requestedByName || 'Unknown',
        requestedByRole: 'ADMIN', // TODO: Get from auth context
        correlationId: command.correlationId,
      },
    })
  }

  /**
   * Map command status to history status
   */
  private mapCommandStatusToHistoryStatus(commandStatus: TpvCommandStatus, resultStatus?: TpvCommandResultStatus): TpvCommandHistoryStatus {
    switch (commandStatus) {
      case 'PENDING':
      case 'QUEUED':
      case 'SENT':
        return 'SENT'
      case 'RECEIVED':
        return 'ACK_RECEIVED'
      case 'EXECUTING':
        return 'EXECUTION_STARTED'
      case 'COMPLETED':
        return 'COMPLETED'
      case 'FAILED':
        return 'FAILED'
      case 'EXPIRED':
        return 'TIMEOUT'
      case 'CANCELLED':
        return 'CANCELLED'
      default:
        return 'SENT'
    }
  }

  /**
   * Broadcast status change to dashboard
   */
  private async broadcastStatusChange(
    command: any,
    previousStatus: TpvCommandStatus,
    newStatus: TpvCommandStatus,
    message?: string,
  ): Promise<void> {
    try {
      broadcastTpvCommandStatusChanged(command.terminalId, command.venueId, {
        terminalId: command.terminalId,
        terminalName: command.terminal.name,
        commandId: command.id,
        correlationId: command.correlationId,
        commandType: command.commandType,
        previousStatus,
        newStatus,
        statusChangedAt: new Date(),
        message,
        requestedByName: command.requestedByName,
      })
    } catch (error) {
      logger.warn('Failed to broadcast command status change', { error })
    }
  }

  /**
   * Broadcast queued notification to dashboard
   */
  private async broadcastQueuedNotification(command: any, terminal: { id: string; name: string }): Promise<void> {
    try {
      broadcastTpvCommandQueued(terminal.id, command.venueId, {
        terminalId: terminal.id,
        terminalName: terminal.name,
        commandId: command.id,
        correlationId: command.correlationId,
        commandType: command.commandType,
        queuedAt: new Date(),
        expiresAt: command.expiresAt,
        reason: 'TERMINAL_OFFLINE',
      })
    } catch (error) {
      logger.warn('Failed to broadcast command queued notification', { error })
    }
  }
}

// Export singleton instance
export const tpvCommandQueueService = new TpvCommandQueueService()
