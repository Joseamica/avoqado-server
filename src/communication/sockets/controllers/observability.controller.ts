import { AuthenticatedSocket, SocketEventType } from '../types'
import { RoomManagerService } from '../services/roomManager.service'
import { BroadcastingService } from '../services/broadcasting.service'
import { terminalRegistry } from '../terminal-registry'
import logger from '../../../config/logger'
import { v4 as uuidv4 } from 'uuid'
import { LogLevel } from '@prisma/client'
import prisma from '../../../utils/prismaClient'

/**
 * Observability Controller
 * Handles terminal logging and health monitoring via Socket.IO
 *
 * Inspired by Toast and Square terminal fleet management systems.
 * Provides real-time visibility into production terminal issues.
 *
 * ## Events Handled:
 * - `tpv:log`: Real-time log events from terminals (INFO, WARN, ERROR)
 * - `tpv:heartbeat`: Periodic health metrics (every 5 minutes)
 *
 * ## Data Flow:
 * 1. Terminal sends event via Socket.IO
 * 2. Controller validates and enriches data
 * 3. Store in PostgreSQL (Prisma)
 * 4. Broadcast to dashboard subscribers (venue room)
 *
 * @see TerminalLog model
 * @see TerminalHealth model
 */
export class ObservabilityController {
  private roomManager: RoomManagerService
  private broadcastingService: BroadcastingService | null = null

  constructor(roomManager: RoomManagerService) {
    this.roomManager = roomManager
  }

  public setBroadcastingService(broadcastingService: BroadcastingService): void {
    this.broadcastingService = broadcastingService
  }

  /**
   * Handle terminal log event
   *
   * Socket Event: `tpv:log`
   * Payload: { level, tag, message, error?, metadata?, terminalId, venueId, timestamp }
   */
  public async handleTerminalLog(
    socket: AuthenticatedSocket,
    payload: {
      level: string
      tag: string
      message: string
      error?: string
      metadata?: Record<string, any>
      terminalId: string
      venueId: string
      timestamp: number
    },
    callback?: (response: any) => void,
  ): Promise<void> {
    const correlationId = socket.correlationId || uuidv4()

    try {
      // Validate payload
      if (!payload.level || !payload.tag || !payload.message || !payload.terminalId || !payload.venueId) {
        throw new Error('Missing required fields in log payload')
      }

      // Validate log level
      const validLevels: LogLevel[] = ['INFO', 'WARN', 'ERROR']
      const level = payload.level.toUpperCase() as LogLevel
      if (!validLevels.includes(level)) {
        throw new Error(`Invalid log level: ${payload.level}`)
      }

      // Store log in database
      const terminalLog = await prisma.terminalLog.create({
        data: {
          venueId: payload.venueId,
          terminalId: payload.terminalId,
          level,
          tag: payload.tag,
          message: payload.message,
          error: payload.error || undefined,
          metadata: payload.metadata || undefined,
          timestamp: BigInt(payload.timestamp),
        },
      })

      // Broadcast to dashboard (venue room)
      // Dashboard subscribers can see logs in real-time
      if (this.broadcastingService) {
        this.broadcastingService.broadcastToVenue(payload.venueId, SocketEventType.TERMINAL_LOG, {
          id: terminalLog.id,
          terminalId: payload.terminalId,
          level,
          tag: payload.tag,
          message: payload.message,
          error: payload.error,
          metadata: payload.metadata,
          timestamp: payload.timestamp,
        })
      }

      // Log to backend console (for monitoring backend itself)
      const logMessage = `[Terminal ${payload.terminalId}] [${payload.tag}] ${payload.message}`
      if (level === 'ERROR') {
        logger.error(logMessage, { correlationId, terminalId: payload.terminalId, metadata: payload.metadata })
      } else if (level === 'WARN') {
        logger.warn(logMessage, { correlationId, terminalId: payload.terminalId, metadata: payload.metadata })
      } else {
        logger.info(logMessage, { correlationId, terminalId: payload.terminalId, metadata: payload.metadata })
      }

      // Send acknowledgment
      if (callback) {
        callback({ success: true, id: terminalLog.id })
      }
    } catch (error) {
      logger.error('Error handling terminal log', {
        correlationId,
        socketId: socket.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        payload,
      })

      if (callback) {
        callback({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to store log',
        })
      }
    }
  }

  /**
   * Handle terminal heartbeat (health metrics)
   *
   * Socket Event: `tpv:heartbeat`
   * Payload: { terminalId, venueId, health: {...}, healthScore, timestamp }
   */
  public async handleTerminalHeartbeat(
    socket: AuthenticatedSocket,
    payload: {
      terminalId: string
      venueId: string
      health: {
        memory: {
          totalMB: number
          availableMB: number
          usagePercent: number
          lowMemory: boolean
        }
        storage: {
          totalMB: number
          availableMB: number
          usagePercent: number
          lowStorage: boolean
        }
        battery: {
          level: number | null
          isCharging: boolean
          temperatureCelsius: number | null
          lowBattery: boolean
        }
        connectivity: {
          socketConnected: boolean
          online: boolean
        }
        device: {
          manufacturer: string
          model: string
          osVersion: string
          appVersion: string
          appVersionCode: number
          blumonEnv: string
        }
        uptime: {
          uptimeMinutes: number
        }
      }
      healthScore: number
      timestamp: number
    },
    callback?: (response: any) => void,
  ): Promise<void> {
    const correlationId = socket.correlationId || uuidv4()

    try {
      // Validate payload
      if (!payload.terminalId || !payload.venueId || !payload.health) {
        throw new Error('Missing required fields in heartbeat payload')
      }

      const { health } = payload

      // Resolve serial number → database CUID
      // TPV sends device serial (e.g. "AVQD-2840744192") but DB expects Terminal.id (CUID)
      const terminal = await prisma.terminal.findFirst({
        where: {
          OR: [
            { id: payload.terminalId },
            { serialNumber: { equals: payload.terminalId, mode: 'insensitive' } },
            { serialNumber: { equals: `AVQD-${payload.terminalId}`, mode: 'insensitive' } },
          ],
        },
        select: { id: true, venueId: true },
      })

      if (!terminal) {
        logger.warn(`📡 [Heartbeat] Terminal not found: ${payload.terminalId}`)
        if (callback) {
          callback({ success: false, error: `Terminal not found: ${payload.terminalId}` })
        }
        return
      }

      const resolvedTerminalId = terminal.id

      // Register terminal in registry (for Socket.IO payment routing)
      logger.info(`📡 [Heartbeat] Registering terminal ${payload.terminalId} (socket: ${socket.id}, venue: ${payload.venueId})`)
      terminalRegistry.register(payload.terminalId, socket.id, payload.venueId)

      // Store health metrics in database
      const terminalHealth = await prisma.terminalHealth.create({
        data: {
          venueId: payload.venueId,
          terminalId: resolvedTerminalId,
          healthScore: payload.healthScore,

          // Memory
          memoryTotalMB: health.memory.totalMB,
          memoryAvailableMB: health.memory.availableMB,
          memoryUsagePercent: health.memory.usagePercent,
          lowMemory: health.memory.lowMemory,

          // Storage
          storageTotalMB: health.storage.totalMB,
          storageAvailableMB: health.storage.availableMB,
          storageUsagePercent: health.storage.usagePercent,
          lowStorage: health.storage.lowStorage,

          // Battery
          batteryLevel: health.battery.level,
          batteryCharging: health.battery.isCharging,
          batteryTemperature: health.battery.temperatureCelsius,
          lowBattery: health.battery.lowBattery,

          // Connectivity
          socketConnected: health.connectivity.socketConnected,
          online: health.connectivity.online,

          // Device
          manufacturer: health.device.manufacturer,
          model: health.device.model,
          osVersion: health.device.osVersion,
          appVersion: health.device.appVersion,
          appVersionCode: health.device.appVersionCode,
          blumonEnv: health.device.blumonEnv,

          // Uptime
          uptimeMinutes: health.uptime.uptimeMinutes,

          // Timestamps
          timestamp: new Date(payload.timestamp),
        },
      })

      // Update terminal lastHeartbeat
      await prisma.terminal.update({
        where: { id: resolvedTerminalId },
        data: { lastHeartbeat: new Date() },
      })

      // Broadcast health status to dashboard
      if (this.broadcastingService) {
        this.broadcastingService.broadcastToVenue(payload.venueId, SocketEventType.TERMINAL_HEARTBEAT, {
          id: terminalHealth.id,
          terminalId: payload.terminalId,
          healthScore: payload.healthScore,
          health: {
            memory: health.memory,
            battery: health.battery,
            storage: health.storage,
          },
          timestamp: payload.timestamp,
        })
      }

      // Log to backend console
      const status = payload.healthScore >= 90 ? '✅' : payload.healthScore >= 70 ? '⚠️' : '❌'
      logger.info(`${status} Terminal heartbeat: ${payload.terminalId} (health: ${payload.healthScore}/100)`, {
        correlationId,
        terminalId: payload.terminalId,
        healthScore: payload.healthScore,
        lowMemory: health.memory.lowMemory,
        lowBattery: health.battery.lowBattery,
        lowStorage: health.storage.lowStorage,
      })

      // Send acknowledgment
      if (callback) {
        callback({ success: true, id: terminalHealth.id })
      }
    } catch (error) {
      logger.error('Error handling terminal heartbeat', {
        correlationId,
        socketId: socket.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        payload,
      })

      if (callback) {
        callback({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to store heartbeat',
        })
      }
    }
  }
}
