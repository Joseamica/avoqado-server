// services/tpv/tpv-health.service.ts

import { TerminalStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { NotFoundError } from '../../errors/AppError'
import { broadcastTpvStatusUpdate } from '../../communication/sockets'

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
  type: 'SHUTDOWN' | 'RESTART' | 'MAINTENANCE_MODE' | 'EXIT_MAINTENANCE' | 'UPDATE_STATUS'
  payload?: any
  requestedBy: string
}

/**
 * Service to handle TPV health monitoring and remote commands
 */
export class TpvHealthService {
  /**
   * Process heartbeat from a TPV terminal
   */
  async processHeartbeat(heartbeatData: HeartbeatData, clientIp?: string): Promise<void> {
    const { terminalId, timestamp, status, version, systemInfo } = heartbeatData

    try {
      // Try to find terminal by ID first, then by serialNumber (for Android devices using device serial)
      let terminal = await prisma.terminal.findUnique({
        where: { id: terminalId },
      })

      // If not found by ID, try to find by serialNumber (Android device compatibility)
      if (!terminal) {
        terminal = await prisma.terminal.findUnique({
          where: { serialNumber: terminalId },
        })
      }

      if (!terminal) {
        throw new NotFoundError(`Terminal with ID or serial number ${terminalId} not found`)
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
        // If terminal is in maintenance mode, only allow MAINTENANCE status from heartbeat
        // ACTIVE heartbeats should not override maintenance mode set by admin commands
        if (status === 'MAINTENANCE') {
          newStatus = TerminalStatus.MAINTENANCE
        } else {
          // Keep maintenance mode, don't allow heartbeat to override it
          newStatus = TerminalStatus.MAINTENANCE
          logger.warn(`Terminal ${terminal.id} tried to send ACTIVE heartbeat while in maintenance mode - keeping maintenance status`)
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
      let terminal = await prisma.terminal.findUnique({
        where: { id: terminalId },
      })

      // If not found by ID, try to find by serialNumber (Android device compatibility)
      if (!terminal) {
        terminal = await prisma.terminal.findUnique({
          where: { serialNumber: terminalId },
        })
      }

      if (!terminal) {
        throw new NotFoundError(`Terminal with ID or serial number ${terminalId} not found`)
      }

      // Check if terminal is online (heartbeat within last 2 minutes)
      const cutoff = new Date(Date.now() - 2 * 60 * 1000)
      if (!terminal.lastHeartbeat || terminal.lastHeartbeat < cutoff) {
        throw new Error(`Terminal ${terminalId} is offline and cannot receive commands`)
      }

      // Send command via Socket.io to the terminal
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
            in: [TerminalStatus.ACTIVE, TerminalStatus.MAINTENANCE],
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
      const terminal = await prisma.terminal.findUnique({
        where: { id: terminalId },
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

      if (!terminal) {
        throw new NotFoundError(`Terminal with ID ${terminalId} not found`)
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
