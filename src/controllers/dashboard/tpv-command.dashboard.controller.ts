/**
 * TPV Remote Command Dashboard Controller
 *
 * Handles HTTP requests for the Enterprise TPV Remote Command System.
 * Thin controller pattern: extracts request data, calls services, returns responses.
 *
 * Endpoints:
 * - POST   /venues/:venueId/tpv-commands                    - Send single command
 * - POST   /venues/:venueId/tpv-commands/bulk               - Send bulk command
 * - GET    /venues/:venueId/tpv-commands                    - List commands
 * - GET    /venues/:venueId/tpv-commands/:commandId         - Get command status
 * - POST   /venues/:venueId/tpv-commands/:commandId/cancel  - Cancel command
 * - POST   /venues/:venueId/tpv-commands/:commandId/retry   - Retry command
 * - GET    /venues/:venueId/tpv-commands/history            - Get command history
 * - GET    /venues/:venueId/bulk-operations                 - List bulk operations
 * - GET    /venues/:venueId/bulk-operations/:operationId    - Get bulk operation status
 * - POST   /venues/:venueId/bulk-operations/:operationId/cancel - Cancel bulk operation
 * - GET    /venues/:venueId/scheduled-commands              - List scheduled commands
 * - POST   /venues/:venueId/scheduled-commands              - Create scheduled command
 * - GET    /venues/:venueId/scheduled-commands/:scheduleId  - Get scheduled command
 * - PATCH  /venues/:venueId/scheduled-commands/:scheduleId  - Update scheduled command
 * - DELETE /venues/:venueId/scheduled-commands/:scheduleId  - Delete scheduled command
 * - GET    /venues/:venueId/geofence-rules                  - List geofence rules
 * - POST   /venues/:venueId/geofence-rules                  - Create geofence rule
 * - GET    /venues/:venueId/geofence-rules/:ruleId          - Get geofence rule
 * - PATCH  /venues/:venueId/geofence-rules/:ruleId          - Update geofence rule
 * - DELETE /venues/:venueId/geofence-rules/:ruleId          - Delete geofence rule
 *
 * @see src/services/tpv/command-queue.service.ts
 * @see src/services/tpv/command-execution.service.ts
 */

import { NextFunction, Request, Response } from 'express'
import { tpvCommandExecutionService } from '../../services/tpv/command-execution.service'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import {
  SendCommandBody,
  BulkCommandBody,
  CreateScheduledCommandBody,
  UpdateScheduledCommandBody,
  CreateGeofenceRuleBody,
  UpdateGeofenceRuleBody,
  GetCommandsQuery,
  GetCommandHistoryQuery,
  GetBulkOperationsQuery,
  GetScheduledCommandsQuery,
  GetGeofenceRulesQuery,
  CancelCommandBody,
  RetryCommandBody,
} from '../../schemas/dashboard/tpv-command.schema'
import { TpvCommandType } from '@prisma/client'

// ==========================================
// COMMAND OPERATIONS
// ==========================================

/**
 * Send a command to a single terminal
 * @permission tpv-command:send
 */
export async function sendCommand(
  req: Request<{ venueId: string }, {}, SendCommandBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const userId = authContext?.userId || authContext?.staffId

    if (!userId) {
      throw new BadRequestError('User authentication required')
    }

    // Get user's name for audit trail
    const staff = await prisma.staff.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    })

    const staffName = staff ? `${staff.firstName} ${staff.lastName}`.trim() : undefined

    const result = await tpvCommandExecutionService.executeCommand({
      terminalId: req.body.terminalId,
      venueId,
      commandType: req.body.commandType as TpvCommandType,
      payload: req.body.payload,
      priority: req.body.priority as any,
      scheduledFor: req.body.scheduledFor,
      requestedBy: userId,
      requestedByName: staffName,
    })

    res.status(201).json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Send a command to multiple terminals
 * @permission tpv-command:send-bulk
 */
export async function sendBulkCommand(
  req: Request<{ venueId: string }, {}, BulkCommandBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const userId = authContext?.userId || authContext?.staffId

    if (!userId) {
      throw new BadRequestError('User authentication required')
    }

    // Get user's name for audit trail
    const staff = await prisma.staff.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    })

    const staffName = staff ? `${staff.firstName} ${staff.lastName}`.trim() : undefined

    const result = await tpvCommandExecutionService.executeBulkCommand({
      terminalIds: req.body.terminalIds,
      venueId,
      commandType: req.body.commandType as TpvCommandType,
      payload: req.body.payload,
      requestedBy: userId,
      requestedByName: staffName,
    })

    res.status(201).json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * List commands for a venue
 * @permission tpv-command:read
 */
export async function getCommands(
  req: Request<{ venueId: string }, {}, {}, GetCommandsQuery>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { page = 1, pageSize = 20, terminalId, commandType, status, priority, source, fromDate, toDate } = req.query

    const where: any = { venueId }

    if (terminalId) where.terminalId = terminalId
    if (commandType) where.commandType = commandType
    if (status) where.status = status
    if (priority) where.priority = priority
    if (source) where.source = source
    if (fromDate || toDate) {
      where.createdAt = {}
      if (fromDate) where.createdAt.gte = new Date(fromDate)
      if (toDate) where.createdAt.lte = new Date(toDate)
    }

    const [commands, total] = await Promise.all([
      prisma.tpvCommandQueue.findMany({
        where,
        include: {
          terminal: {
            select: { id: true, name: true, serialNumber: true, status: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.tpvCommandQueue.count({ where }),
    ])

    const missingNameIds = Array.from(
      new Set(
        commands
          .filter(command => !command.requestedByName && command.requestedBy && command.requestedBy !== 'system')
          .map(command => command.requestedBy),
      ),
    )

    const staffById = missingNameIds.length
      ? await prisma.staff.findMany({
          where: { id: { in: missingNameIds } },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      : []

    const staffMap = new Map(
      staffById.map(staff => [staff.id, { name: `${staff.firstName} ${staff.lastName}`.trim(), email: staff.email }]),
    )

    const enrichedCommands = commands.map(command => {
      if (command.requestedByName || !command.requestedBy || command.requestedBy === 'system') {
        return command
      }
      const staff = staffMap.get(command.requestedBy)
      if (!staff) return command
      return {
        ...command,
        requestedByName: staff.name,
        requestedByEmail: staff.email,
      }
    })

    res.status(200).json({
      data: enrichedCommands,
      meta: {
        total,
        page,
        pageSize,
        pageCount: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get command status by ID
 * @permission tpv-command:read
 */
export async function getCommandStatus(
  req: Request<{ venueId: string; commandId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, commandId } = req.params

    const command = await tpvCommandExecutionService.getCommandStatus(commandId)

    if (!command || command.venueId !== venueId) {
      throw new NotFoundError(`Command ${commandId} not found`)
    }

    res.status(200).json({
      success: true,
      data: command,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Cancel a pending/queued command
 * @permission tpv-command:cancel
 */
export async function cancelCommand(
  req: Request<{ venueId: string; commandId: string }, {}, CancelCommandBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, commandId } = req.params
    const authContext = (req as any).authContext
    const userId = authContext?.userId || authContext?.staffId

    if (!userId) {
      throw new BadRequestError('User authentication required')
    }

    // Verify command belongs to venue
    const command = await prisma.tpvCommandQueue.findUnique({
      where: { id: commandId },
    })

    if (!command || command.venueId !== venueId) {
      throw new NotFoundError(`Command ${commandId} not found`)
    }

    await tpvCommandExecutionService.cancelCommand(commandId, userId, req.body.reason)

    res.status(200).json({
      success: true,
      message: `Command ${commandId} cancelled successfully`,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Retry a failed command
 * @permission tpv-command:retry
 */
export async function retryCommand(
  req: Request<{ venueId: string; commandId: string }, {}, RetryCommandBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, commandId } = req.params
    const authContext = (req as any).authContext
    const userId = authContext?.userId || authContext?.staffId

    if (!userId) {
      throw new BadRequestError('User authentication required')
    }

    // Verify command belongs to venue and is in retryable state
    const command = await prisma.tpvCommandQueue.findUnique({
      where: { id: commandId },
    })

    if (!command || command.venueId !== venueId) {
      throw new NotFoundError(`Command ${commandId} not found`)
    }

    if (!['FAILED', 'EXPIRED'].includes(command.status)) {
      throw new BadRequestError(`Command ${commandId} cannot be retried (status: ${command.status})`)
    }

    // Reset command for retry
    const updatedCommand = await prisma.tpvCommandQueue.update({
      where: { id: commandId },
      data: {
        status: 'PENDING',
        attempts: 0,
        maxAttempts: req.body.maxRetries || 3,
        lastAttemptAt: null,
        nextAttemptAt: null,
        executedAt: null,
        resultStatus: null,
        resultMessage: null,
      },
    })

    // Attempt to send again
    await tpvCommandExecutionService.sendCommandToTerminal(commandId)

    res.status(200).json({
      success: true,
      message: `Command ${commandId} queued for retry`,
      data: updatedCommand,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get command history
 * @permission tpv-command:read
 */
export async function getCommandHistory(
  req: Request<{ venueId: string }, {}, {}, GetCommandHistoryQuery>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { page = 1, pageSize = 20, terminalId, commandType, resultStatus, fromDate, toDate } = req.query

    const where: any = { venueId }

    if (terminalId) where.terminalId = terminalId
    if (commandType) where.commandType = commandType
    if (resultStatus) where.resultStatus = resultStatus
    if (fromDate || toDate) {
      where.executedAt = {}
      if (fromDate) where.executedAt.gte = new Date(fromDate)
      if (toDate) where.executedAt.lte = new Date(toDate)
    }

    const [history, total] = await Promise.all([
      prisma.tpvCommandHistory.findMany({
        where,
        // Terminal data is denormalized in TpvCommandHistory (terminalId, terminalName, terminalSerial)
        orderBy: { executedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.tpvCommandHistory.count({ where }),
    ])

    res.status(200).json({
      data: history,
      meta: {
        total,
        page,
        pageSize,
        pageCount: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    next(error)
  }
}

// ==========================================
// BULK OPERATIONS
// ==========================================

/**
 * List bulk operations for a venue
 * @permission tpv-command:read
 */
export async function getBulkOperations(
  req: Request<{ venueId: string }, {}, {}, GetBulkOperationsQuery>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { page = 1, pageSize = 20, status, fromDate, toDate } = req.query

    const where: any = { venueId }

    if (status) where.status = status
    if (fromDate || toDate) {
      where.createdAt = {}
      if (fromDate) where.createdAt.gte = new Date(fromDate)
      if (toDate) where.createdAt.lte = new Date(toDate)
    }

    const [operations, total] = await Promise.all([
      prisma.bulkCommandOperation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.bulkCommandOperation.count({ where }),
    ])

    res.status(200).json({
      data: operations,
      meta: {
        total,
        page,
        pageSize,
        pageCount: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get bulk operation status
 * @permission tpv-command:read
 */
export async function getBulkOperationStatus(
  req: Request<{ venueId: string; operationId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, operationId } = req.params

    const operation = await tpvCommandExecutionService.getBulkOperationStatus(operationId)

    if (!operation || operation.venueId !== venueId) {
      throw new NotFoundError(`Bulk operation ${operationId} not found`)
    }

    res.status(200).json({
      success: true,
      data: operation,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Cancel a bulk operation
 * @permission tpv-command:cancel
 */
export async function cancelBulkOperation(
  req: Request<{ venueId: string; operationId: string }, {}, CancelCommandBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, operationId } = req.params
    const authContext = (req as any).authContext
    const userId = authContext?.userId || authContext?.staffId

    if (!userId) {
      throw new BadRequestError('User authentication required')
    }

    // Verify operation belongs to venue
    const operation = await prisma.bulkCommandOperation.findUnique({
      where: { id: operationId },
    })

    if (!operation || operation.venueId !== venueId) {
      throw new NotFoundError(`Bulk operation ${operationId} not found`)
    }

    if (!['PENDING', 'IN_PROGRESS'].includes(operation.status)) {
      throw new BadRequestError(`Cannot cancel operation in ${operation.status} status`)
    }

    // Cancel all pending commands in this operation
    await prisma.tpvCommandQueue.updateMany({
      where: {
        bulkOperationId: operationId,
        status: { in: ['PENDING', 'QUEUED', 'SENT'] },
      },
      data: {
        status: 'CANCELLED',
        resultMessage: `Cancelled by ${userId}: ${req.body.reason || 'Bulk operation cancelled'}`,
      },
    })

    // Update operation status
    await prisma.bulkCommandOperation.update({
      where: { id: operationId },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
      },
    })

    res.status(200).json({
      success: true,
      message: `Bulk operation ${operationId} cancelled`,
    })
  } catch (error) {
    next(error)
  }
}

// ==========================================
// SCHEDULED COMMANDS
// ==========================================

/**
 * List scheduled commands for a venue
 * @permission tpv-command:schedule:read
 */
export async function getScheduledCommands(
  req: Request<{ venueId: string }, {}, {}, GetScheduledCommandsQuery>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { page = 1, pageSize = 20, active, recurring, fromDate, toDate } = req.query

    const where: any = { venueId }

    if (active !== undefined) where.active = active
    if (recurring !== undefined) where.recurring = recurring
    if (fromDate || toDate) {
      where.scheduledFor = {}
      if (fromDate) where.scheduledFor.gte = new Date(fromDate)
      if (toDate) where.scheduledFor.lte = new Date(toDate)
    }

    const [schedules, total] = await Promise.all([
      prisma.scheduledCommand.findMany({
        where,
        orderBy: { nextExecution: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.scheduledCommand.count({ where }),
    ])

    res.status(200).json({
      data: schedules,
      meta: {
        total,
        page,
        pageSize,
        pageCount: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Create a scheduled command
 * @permission tpv-command:schedule:create
 */
export async function createScheduledCommand(
  req: Request<{ venueId: string }, {}, CreateScheduledCommandBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const userId = authContext?.userId || authContext?.staffId

    if (!userId) {
      throw new BadRequestError('User authentication required')
    }

    const schedule = await prisma.scheduledCommand.create({
      data: {
        venueId,
        terminalId: req.body.terminalIds?.[0] || null, // Single terminal or null for all
        commandType: req.body.commandType as TpvCommandType,
        payload: req.body.payload || {},
        nextExecution: req.body.scheduledFor,
        name: req.body.name,
        description: req.body.description,
        scheduleType: req.body.recurring ? 'DAILY' : 'ONCE',
        cronExpression: req.body.cronExpression,
        expiresAt: req.body.recurrenceEndDate,
        createdBy: userId,
        enabled: true,
      },
    })

    res.status(201).json({
      success: true,
      data: schedule,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get scheduled command by ID
 * @permission tpv-command:schedule:read
 */
export async function getScheduledCommand(
  req: Request<{ venueId: string; scheduleId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, scheduleId } = req.params

    const schedule = await prisma.scheduledCommand.findUnique({
      where: { id: scheduleId },
    })

    if (!schedule || schedule.venueId !== venueId) {
      throw new NotFoundError(`Scheduled command ${scheduleId} not found`)
    }

    res.status(200).json({
      success: true,
      data: schedule,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Update scheduled command
 * @permission tpv-command:schedule:update
 */
export async function updateScheduledCommand(
  req: Request<{ venueId: string; scheduleId: string }, {}, UpdateScheduledCommandBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, scheduleId } = req.params

    // Verify schedule belongs to venue
    const existing = await prisma.scheduledCommand.findUnique({
      where: { id: scheduleId },
    })

    if (!existing || existing.venueId !== venueId) {
      throw new NotFoundError(`Scheduled command ${scheduleId} not found`)
    }

    const schedule = await prisma.scheduledCommand.update({
      where: { id: scheduleId },
      data: {
        ...req.body,
        updatedAt: new Date(),
      },
    })

    res.status(200).json({
      success: true,
      data: schedule,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Delete scheduled command
 * @permission tpv-command:schedule:delete
 */
export async function deleteScheduledCommand(
  req: Request<{ venueId: string; scheduleId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, scheduleId } = req.params

    // Verify schedule belongs to venue
    const existing = await prisma.scheduledCommand.findUnique({
      where: { id: scheduleId },
    })

    if (!existing || existing.venueId !== venueId) {
      throw new NotFoundError(`Scheduled command ${scheduleId} not found`)
    }

    await prisma.scheduledCommand.delete({
      where: { id: scheduleId },
    })

    res.status(200).json({
      success: true,
      message: `Scheduled command ${scheduleId} deleted`,
    })
  } catch (error) {
    next(error)
  }
}

// ==========================================
// GEOFENCE RULES
// ==========================================

/**
 * List geofence rules for a venue
 * @permission tpv-command:geofence:read
 */
export async function getGeofenceRules(
  req: Request<{ venueId: string }, {}, {}, GetGeofenceRulesQuery>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { page = 1, pageSize = 20, active } = req.query

    const where: any = { venueId }

    if (active !== undefined) where.active = active

    const [rules, total] = await Promise.all([
      prisma.geofenceRule.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.geofenceRule.count({ where }),
    ])

    res.status(200).json({
      data: rules,
      meta: {
        total,
        page,
        pageSize,
        pageCount: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Create a geofence rule
 * @permission tpv-command:geofence:create
 */
export async function createGeofenceRule(
  req: Request<{ venueId: string }, {}, CreateGeofenceRuleBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const userId = authContext?.userId || authContext?.staffId

    if (!userId) {
      throw new BadRequestError('User authentication required')
    }

    const rule = await prisma.geofenceRule.create({
      data: {
        venueId,
        name: req.body.name,
        description: req.body.description,
        centerLat: req.body.latitude,
        centerLng: req.body.longitude,
        radiusMeters: req.body.radiusMeters,
        terminalId: req.body.terminalIds?.[0] || null, // Single terminal or null for all
        onEnter: req.body.triggerType === 'ENTER' ? (req.body.action as any) : undefined,
        onEnterPayload: req.body.triggerType === 'ENTER' ? req.body.payload : undefined,
        onExit: req.body.triggerType === 'EXIT' ? (req.body.action as any) : undefined,
        onExitPayload: req.body.triggerType === 'EXIT' ? req.body.payload : undefined,
        enabled: req.body.active ?? true,
        createdBy: userId,
      },
    })

    res.status(201).json({
      success: true,
      data: rule,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get geofence rule by ID
 * @permission tpv-command:geofence:read
 */
export async function getGeofenceRule(req: Request<{ venueId: string; ruleId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, ruleId } = req.params

    const rule = await prisma.geofenceRule.findUnique({
      where: { id: ruleId },
    })

    if (!rule || rule.venueId !== venueId) {
      throw new NotFoundError(`Geofence rule ${ruleId} not found`)
    }

    res.status(200).json({
      success: true,
      data: rule,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Update geofence rule
 * @permission tpv-command:geofence:update
 */
export async function updateGeofenceRule(
  req: Request<{ venueId: string; ruleId: string }, {}, UpdateGeofenceRuleBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, ruleId } = req.params

    // Verify rule belongs to venue
    const existing = await prisma.geofenceRule.findUnique({
      where: { id: ruleId },
    })

    if (!existing || existing.venueId !== venueId) {
      throw new NotFoundError(`Geofence rule ${ruleId} not found`)
    }

    const rule = await prisma.geofenceRule.update({
      where: { id: ruleId },
      data: {
        ...req.body,
        updatedAt: new Date(),
      },
    })

    res.status(200).json({
      success: true,
      data: rule,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Delete geofence rule
 * @permission tpv-command:geofence:delete
 */
export async function deleteGeofenceRule(
  req: Request<{ venueId: string; ruleId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, ruleId } = req.params

    // Verify rule belongs to venue
    const existing = await prisma.geofenceRule.findUnique({
      where: { id: ruleId },
    })

    if (!existing || existing.venueId !== venueId) {
      throw new NotFoundError(`Geofence rule ${ruleId} not found`)
    }

    await prisma.geofenceRule.delete({
      where: { id: ruleId },
    })

    res.status(200).json({
      success: true,
      message: `Geofence rule ${ruleId} deleted`,
    })
  } catch (error) {
    next(error)
  }
}

// ==========================================
// TERMINAL HANDLER (for ACK/result from TPV)
// ==========================================

/**
 * Handle command acknowledgment from terminal
 * Called by TPV terminal when it receives a command
 */
export async function handleCommandAck(
  req: Request<{ commandId: string }, {}, { terminalId: string; receivedAt: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { commandId } = req.params
    const { terminalId, receivedAt } = req.body

    await tpvCommandExecutionService.handleCommandAck(commandId, terminalId, new Date(receivedAt))

    res.status(200).json({
      success: true,
      message: 'ACK processed',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Handle command execution start from terminal
 * Called by TPV terminal when it starts executing a command
 */
export async function handleCommandStarted(
  req: Request<{ commandId: string }, {}, { terminalId: string; startedAt: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { commandId } = req.params
    const { terminalId, startedAt } = req.body

    await tpvCommandExecutionService.handleCommandStarted(commandId, terminalId, new Date(startedAt))

    res.status(200).json({
      success: true,
      message: 'Execution start recorded',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Handle command result from terminal
 * Called by TPV terminal when command execution completes
 */
export async function handleCommandResult(
  req: Request<
    { commandId: string },
    {},
    {
      terminalId: string
      success: boolean
      resultData?: Record<string, any>
      errorMessage?: string
      completedAt: string
    }
  >,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { commandId } = req.params
    const { terminalId, success, resultData, errorMessage } = req.body

    // Convert success boolean to result status
    const resultStatus = success ? 'SUCCESS' : 'ERROR'
    await tpvCommandExecutionService.handleCommandResult(commandId, terminalId, resultStatus as any, errorMessage, resultData)

    res.status(200).json({
      success: true,
      message: 'Result processed',
    })
  } catch (error) {
    next(error)
  }
}
