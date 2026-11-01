import { AuthenticatedSocket, SocketEventType } from '../types'
import { RoomManagerService } from '../services/roomManager.service'
import { BroadcastingService } from '../services/broadcasting.service'
import { terminalRegistry } from '../terminal-registry'
import logger from '../../../config/logger'
import { v4 as uuidv4 } from 'uuid'
import { LogLevel } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { sameTerminalSerial } from '../../../utils/terminalSerial'

/**
 * Per-terminal debounce for heartbeat DB writes.
 *
 * When a terminal reconnects after a long socket outage, the Socket.IO client
 * flushes its whole backlog of buffered `tpv:heartbeat` emits at once (observed
 * 2026-06-29: 187 heartbeats spanning ~15h delivered in ~2s). Each ran a
 * 2-statement `prisma.$transaction`, and the burst exhausted the Prisma pool
 * (limit 18) → "Timed out fetching a connection from the pool". Health
 * heartbeats are telemetry; persisting one per terminal per 30s is plenty.
 *
 * Debounce is on the SERVER clock — never on `payload.timestamp` (the device's,
 * which can be skewed) — so a wrong device clock can never suppress writes. The
 * normal 5-min cadence never debounces; only reconnect-flush bursts do. The
 * in-memory map is bounded by the number of terminals (mirrors the existing
 * 30s debounce in touchTerminalHeartbeat.middleware.ts).
 */
const HEARTBEAT_WRITE_DEBOUNCE_MS = 30_000
const lastHeartbeatWriteAt = new Map<string, number>()

const NOT_THIS_TERMINAL = 'Identidad de terminal inválida'

/**
 * 🔴 D2 (31-oct): who may send `tpv:log` / `tpv:heartbeat`, and for which venue.
 *
 * Both events used to trust `payload.terminalId` and `payload.venueId` from ANY authenticated socket: a
 * dashboard session of venue A could write logs, health rows and the payment-routing slot of venue B's
 * terminals. Now the socket must BE the terminal — the serial the server signed into its JWT at PIN login
 * (`auth.tpv.service.ts`), compared with `sameTerminalSerial` exactly like the command ACKs — and the venue
 * is the SESSION's, never the payload's. Every TPV since v1.6.0 sends `deviceInfoManager.getSerialNumber()`
 * as `terminalId`, and every live TPV token carries the signed serial (stamped since 24-feb; tokens last 30
 * days). A mismatch is ignored with a warning, never a disconnect: a heartbeat lost is telemetry, while a
 * noisy rejection of the fleet would blind the monitoring.
 *
 * Returns the venue to write for, or null when the event must be ignored.
 */
function sessionVenueForTerminalEvent(
  socket: AuthenticatedSocket,
  event: 'tpv:log' | 'tpv:heartbeat',
  claimedTerminalId: string,
  claimedVenueId: string,
): string | null {
  const signedSerial = socket.authContext?.terminalSerialNumber
  const sessionVenueId = socket.authContext?.venueId
  if (!signedSerial || !sessionVenueId || !sameTerminalSerial(signedSerial, claimedTerminalId)) {
    logger.warn(`📡 [${event}] Ignored: the socket is not this terminal`, {
      socketId: socket.id,
      claimedTerminalId,
      claimedVenueId,
      sessionVenueId,
      hasSignedSerial: !!signedSerial,
    })
    return null
  }
  if (claimedVenueId !== sessionVenueId) {
    // A stale venue in the app (e.g. the terminal moved and the app kept its old context): the session wins.
    logger.warn(`📡 [${event}] Payload venue differs from the session venue; using the session venue`, {
      socketId: socket.id,
      claimedTerminalId,
      claimedVenueId,
      sessionVenueId,
    })
  }
  return sessionVenueId
}

/** The heartbeat's original serial/id lookup, now scoped to one venue. */
function findTerminalInVenue(venueId: string, claimedTerminalId: string) {
  return prisma.terminal.findFirst({
    where: {
      venueId,
      OR: [
        { id: claimedTerminalId },
        { serialNumber: { equals: claimedTerminalId, mode: 'insensitive' } },
        { serialNumber: { equals: `AVQD-${claimedTerminalId}`, mode: 'insensitive' } },
      ],
    },
    select: { id: true, venueId: true },
  })
}

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

      const venueId = sessionVenueForTerminalEvent(socket, 'tpv:log', payload.terminalId, payload.venueId)
      if (!venueId) {
        if (callback) callback({ success: false, error: NOT_THIS_TERMINAL })
        return
      }

      // Resolve the serial the TPV sends (e.g. "AVQD-2841548625") to the Terminal CUID, INSIDE the session venue.
      const terminal = await findTerminalInVenue(venueId, payload.terminalId)
      if (!terminal) {
        logger.warn(`📡 [tpv:log] Terminal not found in the session venue: ${payload.terminalId}`, { socketId: socket.id, venueId })
        if (callback) callback({ success: false, error: `Terminal not found: ${payload.terminalId}` })
        return
      }

      // Store log in database
      const terminalLog = await prisma.terminalLog.create({
        data: {
          venueId,
          terminalId: terminal.id,
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
        this.broadcastingService.broadcastToVenue(venueId, SocketEventType.TERMINAL_LOG, {
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

      const venueId = sessionVenueForTerminalEvent(socket, 'tpv:heartbeat', payload.terminalId, payload.venueId)
      if (!venueId) {
        if (callback) callback({ success: false, error: NOT_THIS_TERMINAL })
        return
      }

      const { health } = payload

      // Resolve serial number → database CUID, INSIDE the session venue (it used to search every venue).
      // TPV sends device serial (e.g. "AVQD-2840744192") but DB expects Terminal.id (CUID)
      const terminal = await findTerminalInVenue(venueId, payload.terminalId)

      if (!terminal) {
        logger.warn(`📡 [Heartbeat] Terminal not found: ${payload.terminalId}`)
        if (callback) {
          callback({ success: false, error: `Terminal not found: ${payload.terminalId}` })
        }
        return
      }

      const resolvedTerminalId = terminal.id

      // Register terminal in registry (for Socket.IO payment routing).
      // ALWAYS runs — even for debounced heartbeats below — so a reconnected
      // socket's id is always published for routing (payments are unaffected).
      terminalRegistry.register(payload.terminalId, socket.id, venueId)

      // Debounce DB writes per terminal (server clock) to survive reconnect-flush
      // bursts; see the note at the top of this file. Done AFTER register() so it
      // never affects payment routing. The next non-debounced heartbeat still
      // refreshes Terminal.lastHeartbeat (online status), so this can never cause
      // a false offline — only redundant telemetry rows are skipped.
      const nowMs = Date.now()
      const lastWriteMs = lastHeartbeatWriteAt.get(resolvedTerminalId)
      if (lastWriteMs !== undefined && nowMs - lastWriteMs < HEARTBEAT_WRITE_DEBOUNCE_MS) {
        if (callback) callback({ success: true, debounced: true })
        return
      }
      lastHeartbeatWriteAt.set(resolvedTerminalId, nowMs)

      // Store health metrics + sync denormalized columns on Terminal in ONE
      // transaction. The org dashboard sorts by Terminal.latestHealthScore;
      // these MUST stay in sync with the latest TerminalHealth row.
      logger.info(`📡 [Heartbeat] Registering terminal ${payload.terminalId} (socket: ${socket.id}, venue: ${venueId})`)
      const now = new Date()
      const [terminalHealth] = await prisma.$transaction([
        prisma.terminalHealth.create({
          data: {
            venueId,
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
        }),
        prisma.terminal.update({
          where: { id: resolvedTerminalId },
          data: {
            lastHeartbeat: now,
            latestHealthScore: payload.healthScore,
            latestHealthAt: now,
          },
        }),
      ])

      // Broadcast health status to dashboard
      if (this.broadcastingService) {
        this.broadcastingService.broadcastToVenue(venueId, SocketEventType.TERMINAL_HEARTBEAT, {
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
