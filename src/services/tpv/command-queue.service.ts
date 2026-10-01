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

import { createHash } from 'crypto'
import { sameTerminalSerial } from '../../utils/terminalSerial'
import {
  Prisma,
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
import { NotFoundError, BadRequestError, ConflictError, ForbiddenError } from '../../errors/AppError'
import {
  broadcastTpvCommand,
  broadcastTpvCommandStatusChanged,
  broadcastTpvCommandQueued,
  broadcastTpvStatusUpdate,
} from '../../communication/sockets'
import { assertDeviceActionSupported } from '../device-capabilities.service'
import { isProviderCompatibleWithBrand } from '../../lib/providerDeviceCompatibility'
import { getEffectivePaymentConfig } from '../organization-payment-config.service'

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
    expirationMinutes: 1440, // 24 hours - terminal may be offline, restart when it reconnects
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
  FETCH_ANGELPAY_MERCHANTS: {
    // Operator-triggered "re-auth + report" command. Safe: idempotent inside
    // AngelPayAuthRepository.ensureAuthenticated() (cached session is a no-op).
    // No PIN required — the dashboard caller is SUPERADMIN-only anyway.
    requiresPin: false,
    riskLevel: 'LOW',
    defaultPriority: 'NORMAL',
    maxRetries: 2,
    // Short validity: operator is actively staring at the dialog waiting for
    // a refresh — if the TPV is offline >5 min there's no point still firing
    // a stale refresh later.
    expirationMinutes: 5,
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
  expiresAt?: Date
  idempotencyKey?: string
  // Server-owned: only the migration service supplies this after its preflight.
  migrationIntent?: { toVenueId: string; assignedMerchantIds: string[]; organizationId?: string }
}

export interface CommandQueueResult {
  commandId: string
  correlationId: string
  status: TpvCommandStatus
  queued: boolean
  terminalOnline: boolean
  deliveryProtocolVersion?: number
  replayed?: boolean
  message: string
  expiresAt: Date | null // Caducidad del comando en la cola: el socket debe mandar ésta, no una propia
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
  async queueCommand(input: QueueCommandInput, db: Prisma.TransactionClient = prisma): Promise<CommandQueueResult> {
    if (
      input.payload &&
      (Object.prototype.hasOwnProperty.call(input.payload, '_deliveryProtocol') ||
        Object.prototype.hasOwnProperty.call(input.payload, '_originCommandSessionId') ||
        Object.prototype.hasOwnProperty.call(input.payload, '_migrationIntent'))
    )
      throw new BadRequestError('El protocolo de entrega lo determina el servidor')
    if (Buffer.byteLength(JSON.stringify(input.payload ?? {}), 'utf8') > 65536)
      throw new BadRequestError('El contenido del comando excede 64 KiB')
    if (input.idempotencyKey && db === prisma) {
      if (!/^[\x21-\x7e]{1,128}$/.test(input.idempotencyKey)) throw new BadRequestError('Idempotency-Key inválido')
      const terminal = await prisma.terminal.findUnique({
        where: { id: input.terminalId },
        select: { serialNumber: true, venue: { select: { organizationId: true } } },
      })
      if (!terminal) throw new NotFoundError('Terminal no encontrada')
      const key = {
        organizationId: terminal.venue.organizationId,
        actorStaffId: input.requestedBy,
        endpoint: `tpv-command:${input.terminalId}`,
        idempotencyKey: input.idempotencyKey,
      }
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify(
            [
              input.venueId,
              input.commandType,
              input.payload ?? {},
              input.priority ?? null,
              input.scheduledFor?.toISOString() ?? null,
              input.expiresAt?.toISOString() ?? null,
            ],
            (_key, value) =>
              value && typeof value === 'object' && !Array.isArray(value)
                ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
                : value,
          ),
        )
        .digest('hex')
      const replay = async (client: Prisma.TransactionClient) => {
        const existing = await client.idempotencyRequest.findUnique({ where: { organizationId_actorStaffId_endpoint_idempotencyKey: key } })
        if (!existing) return null
        if (existing.requestHash !== requestHash)
          throw new ConflictError('Esa solicitud ya se usó con otro comando', 'IDEMPOTENCY_KEY_REUSED')
        const result = existing.responseBody as unknown as CommandQueueResult
        return { ...result, expiresAt: result.expiresAt ? new Date(result.expiresAt) : null, replayed: true }
      }
      try {
        const result = await prisma.$transaction(async tx => {
          const existing = await replay(tx)
          if (existing) return existing
          const result = await this.queueCommand({ ...input, idempotencyKey: undefined }, tx)
          await tx.idempotencyRequest.create({
            data: {
              ...key,
              requestHash,
              responseStatus: 200,
              responseBody: JSON.parse(JSON.stringify(result)),
              expiresAt: new Date(Date.now() + 30 * 86400000),
            },
          })
          return result
        })
        // A hint before commit could make the device read an empty queue.
        if (result.deliveryProtocolVersion === 2 && !result.replayed && !input.scheduledFor) {
          broadcastTpvCommand(terminal.serialNumber || input.terminalId, input.venueId, {
            type: input.commandType,
            requestedBy: input.requestedBy,
            commandId: result.commandId,
            correlationId: result.correlationId,
            payload: { _deliveryProtocol: 2 },
          })
        }
        return result
      } catch (error) {
        // A concurrent duplicate loses the UNIQUE insert; its command/history roll back.
        if ((error as { code?: string }).code === 'P2002') {
          const existing = await replay(prisma)
          if (existing) return existing
        }
        throw error
      }
    }
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

    if (commandType === 'INSTALL_VERSION' && (!Number.isSafeInteger(payload?.versionCode) || payload!.versionCode <= 0)) {
      throw new BadRequestError('Selecciona una versión publicada válida (versionCode).')
    }
    if (commandType === 'EXPORT_LOGS') {
      throw new BadRequestError('La exportación remota de logs aún no está disponible en la TPV.')
    }

    // Get terminal and check status
    const terminal = await db.terminal.findUnique({
      where: { id: terminalId },
      select: {
        id: true,
        name: true,
        serialNumber: true,
        type: true,
        brand: true,
        status: true,
        lastHeartbeat: true,
        isLocked: true,
        venueId: true,
        customerDisplayPresent: true,
        customerDisplayInvertible: true,
        displayModeProtocolVersion: true,
        capabilitiesObservedAt: true,
        commandProtocolVersion: true,
        commandSessionId: true,
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

    assertDeviceActionSupported(terminal, { kind: 'REMOTE_COMMAND', commandType })

    // Validate command against terminal state
    await this.validateCommandForTerminal(commandType, terminal)

    // Calculate expiration
    const durable = (terminal.commandProtocolVersion ?? 0) >= 2
    if (input.migrationIntent && (!durable || commandType !== 'FACTORY_RESET')) throw new BadRequestError('Intención de migración inválida')
    const expiresAt = durable ? null : (input.expiresAt ?? new Date(Date.now() + config.expirationMinutes * 60 * 1000))

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
    const command = await db.tpvCommandQueue.create({
      data: {
        terminalId,
        venueId,
        commandType,
        payload: durable
          ? {
              ...payload,
              _deliveryProtocol: 2,
              _originCommandSessionId: terminal.commandSessionId,
              ...(input.migrationIntent && { _migrationIntent: input.migrationIntent }),
            }
          : payload || {},
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
    await this.createHistoryEntry(
      command.id,
      terminal,
      {
        status: 'SENT',
        source,
        requestedBy,
        requestedByName,
      },
      db,
    )

    // Broadcast status update to dashboard
    if (db === prisma && !isOnline && !scheduledFor) {
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

    if (db === prisma && durable && !scheduledFor) {
      broadcastTpvCommand(terminal.serialNumber || terminalId, venueId, {
        type: commandType,
        requestedBy,
        commandId: command.id,
        correlationId: command.correlationId,
        payload: { _deliveryProtocol: 2 },
      })
    }

    return {
      commandId: command.id,
      correlationId: command.correlationId,
      status: initialStatus,
      queued: !isOnline || !!scheduledFor,
      terminalOnline: isOnline,
      deliveryProtocolVersion: durable ? 2 : undefined,
      message: isOnline
        ? scheduledFor
          ? `Command scheduled for ${scheduledFor.toISOString()}`
          : 'Command sent to terminal'
        : 'Terminal offline - command queued',
      expiresAt,
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
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      },
      orderBy: [
        { priority: 'desc' }, // CRITICAL > HIGH > NORMAL > LOW
        { createdAt: 'asc' }, // FIFO within same priority
        { id: 'asc' },
      ],
      take: 10,
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
    terminalId?: string,
    resultPayload?: Record<string, any>,
  ): Promise<boolean> {
    const transition = await prisma.$transaction(async tx => {
      const command = await tx.tpvCommandQueue.findUnique({
        where: { id: commandId },
        include: { terminal: { select: { id: true, name: true, serialNumber: true, venueId: true, commandSessionId: true, brand: true } } },
      })
      if (!command) throw new NotFoundError(`Command ${commandId} not found`)
      if (terminalId && terminalId !== command.terminalId && !sameTerminalSerial(terminalId, command.terminal.serialNumber)) {
        throw new ForbiddenError('La terminal no es dueña de este comando', 'TPV_COMMAND_NOT_OWNED')
      }
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(command.status)) return null
      const executionSessionId = resultPayload?.executionSessionId
      if (newStatus === 'EXECUTING' && executionSessionId) {
        if (command.terminal.commandSessionId !== executionSessionId) return null
        if (command.status === 'EXECUTING') {
          return (command.resultPayload as { executionSessionId?: string } | null)?.executionSessionId === executionSessionId
            ? { command, terminal: null, replayed: true }
            : null
        }
      }
      if (newStatus === 'EXECUTING' && command.expiresAt && command.expiresAt <= new Date()) return null
      const order = ['PENDING', 'QUEUED', 'SENT', 'RECEIVED', 'EXECUTING']
      if (order.includes(newStatus) && order.indexOf(newStatus) <= order.indexOf(command.status)) return null
      const updated = await tx.tpvCommandQueue.updateMany({
        where: { id: command.id, status: command.status },
        data: {
          status: newStatus,
          resultStatus,
          resultMessage,
          resultPayload,
          executedAt: ['COMPLETED', 'FAILED'].includes(newStatus) ? new Date() : undefined,
          attempts: newStatus === 'SENT' ? { increment: 1 } : undefined,
        },
      })
      if (updated.count !== 1) return null
      const intent = (command.payload as { _migrationIntent?: QueueCommandInput['migrationIntent'] } | null)?._migrationIntent
      if (newStatus === 'EXECUTING' && intent) {
        if (!executionSessionId || command.commandType !== 'FACTORY_RESET') throw new BadRequestError('Permiso de migración requerido')
        const destination = await tx.venue.findUnique({ where: { id: intent.toVenueId }, select: { id: true, organizationId: true } })
        if (!destination || (intent.organizationId && destination.organizationId !== intent.organizationId))
          throw new BadRequestError('El destino cambió; cancela y vuelve a validar la migración')
        if (intent.assignedMerchantIds.length) {
          const merchants = await tx.merchantAccount.findMany({
            where: { id: { in: intent.assignedMerchantIds }, active: true },
            select: { id: true, provider: { select: { code: true } } },
            take: intent.assignedMerchantIds.length,
          })
          if (
            merchants.length !== intent.assignedMerchantIds.length ||
            merchants.some(m => !isProviderCompatibleWithBrand(m.provider.code, command.terminal.brand))
          )
            throw new BadRequestError('Los merchants cambiaron; cancela y vuelve a validar la migración')
        }
        if (!intent.assignedMerchantIds.length) {
          const effective = await getEffectivePaymentConfig(intent.toVenueId, tx)
          const primary = effective?.config.primaryAccount
          if (!primary?.active || !isProviderCompatibleWithBrand(primary.provider.code, command.terminal.brand))
            throw new BadRequestError('La configuración de cobro cambió; cancela y vuelve a validar la migración')
        }
        const moved = await tx.terminal.updateMany({
          where: {
            id: command.terminalId,
            venueId: command.venueId,
            ...(intent.organizationId && { venue: { organizationId: intent.organizationId } }),
          },
          data: { venueId: intent.toVenueId, assignedMerchantIds: intent.assignedMerchantIds },
        })
        if (moved.count !== 1) throw new ConflictError('La terminal cambió; cancela y vuelve a validar')
        await tx.tpvCommandQueue.update({ where: { id: command.id }, data: { venueId: intent.toVenueId } })
        await tx.activityLog.create({
          data: {
            action: 'TERMINAL_MIGRATION_COMMITTED',
            entity: 'Terminal',
            entityId: command.terminalId,
            venueId: intent.toVenueId,
            staffId: command.requestedBy === 'system' ? null : command.requestedBy,
            data: { commandId: command.id, fromVenueId: command.venueId, toVenueId: intent.toVenueId },
          },
        })
        command.venueId = intent.toVenueId
        command.terminal.venueId = intent.toVenueId
      }

      const terminal =
        resultStatus === 'SUCCESS' ? await this.updateTerminalStateForCommand(command.terminalId, command.commandType, tx) : null
      await this.createHistoryEntry(
        commandId,
        command.terminal,
        {
          status: this.mapCommandStatusToHistoryStatus(newStatus, resultStatus),
          resultMessage,
        },
        tx,
      )
      return { command, terminal }
    })
    if (!transition) return false
    if ('replayed' in transition) return true
    await this.broadcastStatusChange(transition.command, transition.command.status, newStatus, resultMessage)
    if (transition.terminal)
      broadcastTpvStatusUpdate(transition.terminal.id, transition.terminal.venueId, {
        status: transition.terminal.status,
        isLocked: transition.terminal.isLocked,
        lastHeartbeat: transition.terminal.lastHeartbeat ?? undefined,
      })
    return true
  }

  async handleCommandAck(commandId: string, terminalId: string): Promise<void> {
    await this.updateCommandStatus(commandId, 'RECEIVED', undefined, undefined, terminalId)
  }

  async handleCommandStarted(commandId: string, terminalId: string): Promise<void> {
    await this.updateCommandStatus(commandId, 'EXECUTING', undefined, undefined, terminalId)
  }

  async handleCommandResult(
    commandId: string,
    terminalId: string,
    resultStatus: TpvCommandResultStatus,
    message?: string,
    resultData?: Record<string, any>,
  ): Promise<void> {
    if (!['SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'REJECTED', 'TIMEOUT'].includes(resultStatus))
      throw new BadRequestError('Resultado de comando inválido')
    const finalStatus = resultStatus === 'SUCCESS' || resultStatus === 'PARTIAL_SUCCESS' ? 'COMPLETED' : 'FAILED'
    await this.updateCommandStatus(commandId, finalStatus, resultStatus, message, terminalId, resultData)
  }

  /**
   * Cancel a pending command
   */
  async cancelCommand(commandId: string, cancelledBy: string, reason?: string, db: Prisma.TransactionClient = prisma): Promise<void> {
    if (db === prisma) return prisma.$transaction(tx => this.cancelCommand(commandId, cancelledBy, reason, tx))
    const command = await db.tpvCommandQueue.findUnique({
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

    const cancellable: TpvCommandStatus[] =
      (command.payload as { _deliveryProtocol?: number } | null)?._deliveryProtocol === 2
        ? ['PENDING', 'QUEUED', 'SENT', 'RECEIVED']
        : ['PENDING', 'QUEUED']
    if (!cancellable.includes(command.status)) {
      throw new BadRequestError(`Cannot cancel command in status ${command.status}. The command must not have started execution.`)
    }

    const cancelled = await db.tpvCommandQueue.updateMany({
      where: { id: commandId, status: { in: cancellable } },
      data: {
        status: 'CANCELLED',
        resultMessage: reason || 'Cancelled by user',
      },
    })

    if (cancelled.count !== 1) throw new BadRequestError('El comando ya fue recibido o cancelado. Actualiza su estado.')

    await this.createHistoryEntry(
      commandId,
      command.terminal,
      {
        status: 'CANCELLED',
        resultMessage: reason || `Cancelled by ${cancelledBy}`,
      },
      db,
    )

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
        // `id` is the TIEBREAK — without it a tie group crossing a skip/take page boundary repeats a row
        // on one page and drops another for good (Asana 1217127206664238).
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: Math.min(100, Math.max(1, options?.limit || 50)),
        skip: Math.max(0, options?.offset || 0),
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
      where: { status: { in: ['PENDING', 'QUEUED', 'SENT', 'RECEIVED', 'EXECUTING'] }, expiresAt: { lt: now } },
      select: { id: true },
      take: 100,
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    })
    let expired = 0
    for (const command of expiredCommands) {
      if (await this.updateCommandStatus(command.id, 'EXPIRED', 'TIMEOUT', 'Command expired before execution')) expired++
    }
    return expired
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
    db: Prisma.TransactionClient = prisma,
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
      const terminal = await db.terminal.update({
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
    db: Prisma.TransactionClient = prisma,
  ): Promise<void> {
    const command = await db.tpvCommandQueue.findUnique({
      where: { id: commandQueueId },
      include: {
        venue: { select: { name: true } },
      },
    })

    if (!command) return

    await db.tpvCommandHistory.create({
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
  private mapCommandStatusToHistoryStatus(
    commandStatus: TpvCommandStatus,
    _resultStatus?: TpvCommandResultStatus,
  ): TpvCommandHistoryStatus {
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
