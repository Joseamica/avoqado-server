// services/tpv/tpv-health.service.ts

import { TerminalStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { NotFoundError, UnauthorizedError } from '../../errors/AppError'
import { broadcastTpvStatusUpdate } from '../../communication/sockets'
import { tpvCommandExecutionService } from './command-execution.service'

export interface HeartbeatData {
  terminalId: string
  timestamp: string
  status: 'ACTIVE' | 'MAINTENANCE'
  version?: string
  systemInfo?: {
    platform?: string
    memory?: any
    uptime?: number
    [key: string]: any
  }
}

export interface TpvCommand {
  type: 'SHUTDOWN' | 'RESTART' | 'MAINTENANCE_MODE' | 'EXIT_MAINTENANCE' | 'UPDATE_STATUS' | 'REACTIVATE'
  payload?: any
  requestedBy: string
}

/**
 * Service to handle TPV health monitoring and remote commandss
 */
export class TpvHealthService {
  /**
   * Process heartbeat from a TPV terminal
   *
   * **Concurrency Safety (Square/Toast Pattern):**
   * - ✅ Idempotent: Multiple simultaneous heartbeats are safe
   * - ✅ Atomic: Database update is atomic (no partial updates)
   * - ✅ No race conditions: Uses Prisma's atomic update operation
   *
   * **Race Condition Prevention:**
   * - Terminal lookup is read-only (no locks needed)
   * - Status calculation is deterministic (same inputs → same output)
   * - Database update is atomic (PostgreSQL handles concurrency)
   * - Multiple heartbeats arriving simultaneously will be serialized by DB
   *
   * **Edge Cases Handled:**
   * - Terminal not found → 404 error (safe to retry)
   * - Invalid timestamp → Uses current time (graceful fallback)
   * - Concurrent updates → Last write wins (acceptable for heartbeats)
   */
  async processHeartbeat(heartbeatData: HeartbeatData, clientIp?: string): Promise<void> {
    const { terminalId, timestamp, status, version, systemInfo } = heartbeatData
    try {
      // Try to find terminal by multiple identifiers for compatibility
      // ✅ CASE-INSENSITIVE MATCHING: Android may send lowercase, DB stores uppercase
      //
      // 1. Try internal database ID first (exact match)
      let terminal = await prisma.terminal.findUnique({
        where: { id: terminalId },
      })

      // 2. If not found by internal ID, try serialNumber (hardware serial)
      // Android removes "AVQD-" prefix, so try both with and without prefix
      // ✅ CASE-INSENSITIVE: Use mode: 'insensitive'
      if (!terminal) {
        terminal = await prisma.terminal.findFirst({
          where: {
            serialNumber: {
              equals: terminalId,
              mode: 'insensitive', // Case-insensitive matching
            },
          },
        })
      }

      // 2b. If still not found, try WITH AVQD- prefix (case-insensitive)
      if (!terminal && !terminalId.toUpperCase().startsWith('AVQD-')) {
        terminal = await prisma.terminal.findFirst({
          where: {
            serialNumber: {
              equals: `AVQD-${terminalId}`,
              mode: 'insensitive', // Case-insensitive matching
            },
          },
        })
      }

      // 3. If not found by serial, try Menta terminal ID (case-insensitive)
      // 🚫 NOTE: Menta integration is disabled, but keeping this for backwards compatibility
      // with existing terminals that have mentaTerminalId stored in database
      if (!terminal) {
        terminal = await prisma.terminal.findFirst({
          where: {
            mentaTerminalId: {
              equals: terminalId,
              mode: 'insensitive', // Case-insensitive matching
            },
          },
        })
      }

      if (!terminal) {
        throw new NotFoundError(`Terminal with ID, serial number, or Menta terminal ID ${terminalId} not found`)
      }

      // ✅ SECURITY: Block heartbeats from RETIRED terminals (Square/Toast pattern)
      // RETIRED = Intentionally disabled (stolen device, fired employee, security breach)
      // This prevents stolen/compromised terminals from appearing "online"
      if (terminal.status === TerminalStatus.RETIRED) {
        logger.error(`Heartbeat rejected from RETIRED terminal ${terminalId} - possible stolen device`)
        throw new UnauthorizedError('Terminal has been retired and cannot be used')
      }

      // ✅ Allow heartbeats from unactivated terminals (monitoring before activation)
      // Heartbeat = health check only (battery, network, status) - safe to allow
      // This allows backend to monitor terminals before full activation
      // and survives database resets without manual SQL updates
      if (!terminal.activatedAt) {
        logger.warn(`Heartbeat from unactivated terminal ${terminalId}, allowing for monitoring purposes`)
        // Don't throw error - just log and continue
        // Login/Payment endpoints still require activation (security layer remains)
      }

      // Update terminal status and health data
      const heartbeatDate = timestamp ? new Date(timestamp) : new Date()

      // Validate the date to prevent invalid dates
      if (isNaN(heartbeatDate.getTime())) {
        logger.warn(`Invalid timestamp received: ${timestamp}, using current date`)
        heartbeatDate.setTime(Date.now())
      }

      // Determine the status to set based on current terminal status and heartbeat
      let newStatus: TerminalStatus
      if (terminal.status === TerminalStatus.MAINTENANCE) {
        // If terminal is in maintenance mode, check if this is a force exit attempt
        if (status === 'MAINTENANCE') {
          newStatus = TerminalStatus.MAINTENANCE
        } else if (status === 'ACTIVE') {
          // Allow ACTIVE heartbeats to override maintenance mode (for force exits)
          // This enables force exit functionality from client apps
          newStatus = TerminalStatus.ACTIVE
          logger.info(`Terminal ${terminal.id} force exited maintenance mode via ACTIVE heartbeat`)
        } else {
          newStatus = TerminalStatus.MAINTENANCE
        }
      } else {
        // Normal status handling for non-maintenance terminals
        newStatus = status === 'ACTIVE' ? TerminalStatus.ACTIVE : TerminalStatus.MAINTENANCE
      }

      const updatedTerminal = await prisma.terminal.update({
        where: { id: terminal.id },
        data: {
          status: newStatus,
          lastHeartbeat: heartbeatDate,
          version: version || terminal.version,
          systemInfo: (systemInfo as any) || terminal.systemInfo,
          ipAddress: clientIp || terminal.ipAddress,
          updatedAt: new Date(),
        },
      })

      // Broadcast status update to venue
      broadcastTpvStatusUpdate(terminal.id, terminal.venueId, {
        status: updatedTerminal.status,
        lastHeartbeat: updatedTerminal.lastHeartbeat || undefined,
        version: updatedTerminal.version || undefined,
        ipAddress: updatedTerminal.ipAddress || undefined,
        systemInfo: updatedTerminal.systemInfo,
      })

      logger.info(`Heartbeat processed for terminal ${terminalId}`, {
        terminalId,
        status,
        version,
        ipAddress: clientIp,
      })

      // Process any pending commands in the queue for this terminal
      // This handles the "offline queue" pattern where commands are queued when terminal is offline
      // and delivered when it comes back online (like MDM push notifications)
      try {
        const sentCount = await tpvCommandExecutionService.processOfflineQueue(terminal.id)
        if (sentCount > 0) {
          logger.info(`Processed ${sentCount} queued commands for terminal ${terminal.id}`, {
            terminalId: terminal.id,
            serialNumber: terminal.serialNumber,
            venueId: terminal.venueId,
          })
        }
      } catch (commandError) {
        // Don't fail the heartbeat if command processing fails - log and continue
        logger.error(`Failed to process offline command queue for terminal ${terminal.id}:`, {
          error: commandError instanceof Error ? commandError.message : 'Unknown error',
          terminalId: terminal.id,
        })
      }
    } catch (error) {
      logger.error(`Failed to process heartbeat for terminal ${terminalId}:`, error)
      throw error
    }
  }

  /**
   * Send command to a specific TPV terminal
   */
  async sendCommand(terminalId: string, command: TpvCommand): Promise<void> {
    try {
      // Try to find terminal by ID first, then by serialNumber (for Android devices using device serial)
      // ✅ CASE-INSENSITIVE: Android may send lowercase, DB stores uppercase
      let terminal = await prisma.terminal.findUnique({
        where: { id: terminalId },
      })

      // If not found by ID, try to find by serialNumber (case-insensitive)
      if (!terminal) {
        terminal = await prisma.terminal.findFirst({
          where: {
            serialNumber: {
              equals: terminalId,
              mode: 'insensitive', // Case-insensitive matching
            },
          },
        })
      }

      if (!terminal) {
        throw new NotFoundError(`Terminal with ID or serial number ${terminalId} not found`)
      }

      // Check if terminal is online (heartbeat within last 2 minutes)
      // Exception: EXIT_MAINTENANCE and REACTIVATE can be executed even when terminal is offline
      const cutoff = new Date(Date.now() - 2 * 60 * 1000)
      const isOnline = terminal.lastHeartbeat && terminal.lastHeartbeat > cutoff
      const canExecuteOffline = command.type === 'EXIT_MAINTENANCE' || command.type === 'REACTIVATE'

      if (!isOnline && !canExecuteOffline) {
        throw new Error(`Terminal ${terminalId} is offline and cannot receive commands`)
      }

      // Send command via Socket.io to the terminal (only if online)
      if (isOnline) {
        const { broadcastTpvCommand } = require('../../communication/sockets')

        // Use serial number for Android device compatibility
        broadcastTpvCommand(terminal.serialNumber || terminal.id, terminal.venueId, command)
        logger.info(`Command sent to terminal ${terminal.id}:`, {
          terminalId: terminal.id,
          serialNumber: terminal.serialNumber,
          command: command.type,
          requestedBy: command.requestedBy,
          venueId: terminal.venueId,
        })
      } else {
        logger.info(`Command executed offline for terminal ${terminal.id}:`, {
          terminalId: terminal.id,
          serialNumber: terminal.serialNumber,
          command: command.type,
          requestedBy: command.requestedBy,
          venueId: terminal.venueId,
          reason: 'Terminal offline - database status updated only',
        })
      }

      // Update status based on command
      if (command.type === 'SHUTDOWN') {
        await prisma.terminal.update({
          where: { id: terminalId },
          data: {
            status: TerminalStatus.INACTIVE,
            updatedAt: new Date(),
          },
        })
      } else if (command.type === 'MAINTENANCE_MODE') {
        await prisma.terminal.update({
          where: { id: terminalId },
          data: {
            status: TerminalStatus.MAINTENANCE,
            updatedAt: new Date(),
          },
        })
      } else if (command.type === 'EXIT_MAINTENANCE') {
        await prisma.terminal.update({
          where: { id: terminalId },
          data: {
            status: TerminalStatus.ACTIVE,
            updatedAt: new Date(),
          },
        })
      } else if (command.type === 'REACTIVATE') {
        await prisma.terminal.update({
          where: { id: terminalId },
          data: {
            status: TerminalStatus.ACTIVE,
            updatedAt: new Date(),
          },
        })
      }
    } catch (error) {
      logger.error(`Failed to send command to terminal ${terminalId}:`, error)
      throw error
    }
  }

  /**
   * Check for offline terminals and update their status
   * Should be called periodically (every 1-2 minutes)
   */
  async checkOfflineTerminals(): Promise<void> {
    try {
      // Consider terminals offline if no heartbeat in the last 2 minutes
      const cutoff = new Date(Date.now() - 2 * 60 * 1000)

      const result = await prisma.terminal.updateMany({
        where: {
          lastHeartbeat: {
            lt: cutoff,
          },
          status: {
            in: [TerminalStatus.ACTIVE], // Only mark ACTIVE terminals as offline, preserve MAINTENANCE state
          },
        },
        data: {
          status: TerminalStatus.INACTIVE,
          updatedAt: new Date(),
        },
      })

      if (result.count > 0) {
        logger.warn(`Marked ${result.count} terminals as offline due to missing heartbeat`)
      }
    } catch (error) {
      logger.error('Failed to check offline terminals:', error)
      throw error
    }
  }

  /**
   * Get health summary for all terminals in a venue
   */
  async getVenueTerminalHealth(venueId: string): Promise<{
    total: number
    online: number
    offline: number
    maintenance: number
    inactive: number
  }> {
    try {
      const cutoff = new Date(Date.now() - 2 * 60 * 1000)

      const terminals = await prisma.terminal.findMany({
        where: { venueId },
        select: {
          id: true,
          status: true,
          lastHeartbeat: true,
        },
      })

      const summary = {
        total: terminals.length,
        online: 0,
        offline: 0,
        maintenance: 0,
        inactive: 0,
      }

      terminals.forEach(terminal => {
        const isOnline = terminal.lastHeartbeat && terminal.lastHeartbeat > cutoff

        if (terminal.status === TerminalStatus.ACTIVE && isOnline) {
          summary.online++
        } else if (terminal.status === TerminalStatus.ACTIVE && !isOnline) {
          summary.offline++
        } else if (terminal.status === TerminalStatus.MAINTENANCE) {
          summary.maintenance++
        } else {
          summary.inactive++
        }
      })

      return summary
    } catch (error) {
      logger.error(`Failed to get health summary for venue ${venueId}:`, error)
      throw error
    }
  }

  /**
   * Get detailed health info for a specific terminal
   */
  async getTerminalHealth(terminalId: string): Promise<any> {
    try {
      // Try to find terminal by serial number (with AVQD- prefix handling)
      // ✅ CASE-INSENSITIVE: Android may send lowercase, DB stores uppercase
      let terminal = await prisma.terminal.findFirst({
        where: {
          serialNumber: {
            equals: terminalId,
            mode: 'insensitive', // Case-insensitive matching
          },
        },
        select: {
          id: true,
          name: true,
          status: true,
          lastHeartbeat: true,
          version: true,
          systemInfo: true,
          ipAddress: true,
          createdAt: true,
          updatedAt: true,
        },
      })

      // If not found and doesn't start with AVQD-, try with prefix (case-insensitive)
      // Android removes "AVQD-" prefix before sending, but database stores it with prefix
      if (!terminal && !terminalId.toUpperCase().startsWith('AVQD-')) {
        terminal = await prisma.terminal.findFirst({
          where: {
            serialNumber: {
              equals: `AVQD-${terminalId}`,
              mode: 'insensitive', // Case-insensitive matching
            },
          },
          select: {
            id: true,
            name: true,
            status: true,
            lastHeartbeat: true,
            version: true,
            systemInfo: true,
            ipAddress: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      }

      if (!terminal) {
        throw new NotFoundError(`Terminal with serial number ${terminalId} not found`)
      }

      const cutoff = new Date(Date.now() - 2 * 60 * 1000)
      const isOnline = terminal.lastHeartbeat && terminal.lastHeartbeat > cutoff

      return {
        ...terminal,
        isOnline,
        connectionStatus:
          terminal.status === TerminalStatus.ACTIVE && isOnline
            ? 'ONLINE'
            : terminal.status === TerminalStatus.ACTIVE && !isOnline
              ? 'OFFLINE'
              : terminal.status.toString(),
      }
    } catch (error) {
      logger.error(`Failed to get health info for terminal ${terminalId}:`, error)
      throw error
    }
  }
}

// Export singleton instance
export const tpvHealthService = new TpvHealthService()
