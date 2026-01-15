// services/tpv/tpv-health.service.ts

import { TerminalStatus, TpvCommandType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { NotFoundError, UnauthorizedError } from '../../errors/AppError'
import { broadcastTpvStatusUpdate, broadcastTpvCommandStatusChanged } from '../../communication/sockets'
import { tpvCommandExecutionService } from './command-execution.service'
import { tpvCommandQueueService } from './command-queue.service'

/**
 * Map of command types to terminal status changes
 * Used to update terminal status after successful command execution
 */
const COMMAND_STATUS_UPDATES: Partial<Record<TpvCommandType, TerminalStatus>> = {
  MAINTENANCE_MODE: TerminalStatus.MAINTENANCE,
  EXIT_MAINTENANCE: TerminalStatus.ACTIVE,
  SHUTDOWN: TerminalStatus.INACTIVE,
  REACTIVATE: TerminalStatus.ACTIVE,
}

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
  requestedByName?: string
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
      // **Design Decision (2025-12-01):**
      // Heartbeat does NOT change terminal status EXCEPT for INACTIVE → ACTIVE transition.
      // Status changes should ONLY happen via explicit commands (MAINTENANCE_MODE, EXIT_MAINTENANCE, etc.)
      // This prevents race conditions where:
      //   1. Dashboard sends MAINTENANCE_MODE command
      //   2. TPV sends heartbeat with status=ACTIVE (before command is processed)
      //   3. Server resets terminal to ACTIVE (BUG!)
      //   4. Command arrives and sets maintenance locally, but server already reset it
      let newStatus: TerminalStatus = terminal.status // Keep current status by default

      if (terminal.status === TerminalStatus.INACTIVE && status === 'ACTIVE') {
        // Only allow status change: INACTIVE → ACTIVE (terminal coming online after being inactive)
        newStatus = TerminalStatus.ACTIVE
        logger.info(`Terminal ${terminal.id} came online (INACTIVE → ACTIVE via heartbeat)`)
      }
      // MAINTENANCE status can ONLY be changed via EXIT_MAINTENANCE command
      // ACTIVE → MAINTENANCE via MAINTENANCE_MODE command
      // This prevents race conditions with heartbeat

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

      logger.debug(`Heartbeat processed for terminal ${terminalId}`, {
        terminalId,
        status,
        version,
        ipAddress: clientIp,
      })

      // Note: Command delivery is now handled via the polling pattern in heartbeat.tpv.controller.ts
      // Commands are returned in the heartbeat HTTP response via getPendingCommands()
      // This ensures commands reach the terminal even when Socket.IO is not connected (login screen)
      // The old processOfflineQueue approach (Socket.IO broadcast) was removed as it conflicted
      // with the polling pattern - it marked commands as SENT before they could be returned in HTTP response
    } catch (error) {
      logger.error(`Failed to process heartbeat for terminal ${terminalId}:`, error)
      throw error
    }
  }

  /**
   * Send command to a specific TPV terminal
   *
   * **Square Terminal API Polling Pattern:**
   * Commands are queued in TpvCommandQueue and delivered via:
   * 1. Socket.IO broadcast (immediate, if terminal is connected)
   * 2. Heartbeat polling (reliable, works even on login screen)
   *
   * The polling pattern ensures commands are delivered even when:
   * - Terminal is on login screen (no socket connection)
   * - Socket connection dropped temporarily
   * - Network is unstable
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

      // Map command.type string to TpvCommandType enum
      const commandType = command.type as TpvCommandType

      // ✅ SQUARE/TOAST PATTERN: Always queue command for reliable delivery
      // Commands are delivered via heartbeat polling (works on login screen)
      // AND via Socket.IO broadcast (for immediate delivery if connected)
      const queueResult = await tpvCommandQueueService.queueCommand({
        terminalId: terminal.id,
        venueId: terminal.venueId,
        commandType,
        payload: command.payload,
        requestedBy: command.requestedBy,
        requestedByName: command.requestedByName,
        source: 'DASHBOARD',
      })

      logger.info(`Command queued for terminal ${terminal.id}:`, {
        terminalId: terminal.id,
        serialNumber: terminal.serialNumber,
        command: command.type,
        commandId: queueResult.commandId,
        correlationId: queueResult.correlationId,
        requestedBy: command.requestedBy,
        venueId: terminal.venueId,
        terminalOnline: queueResult.terminalOnline,
        message: queueResult.message,
      })

      // Also broadcast via Socket.IO for immediate delivery (best-effort)
      // Terminal may or may not be connected - polling via heartbeat is the reliable path
      const cutoff = new Date(Date.now() - 2 * 60 * 1000)
      const isOnline = terminal.lastHeartbeat && terminal.lastHeartbeat > cutoff

      if (isOnline) {
        const { broadcastTpvCommand } = require('../../communication/sockets')
        // Use serial number for Android device compatibility
        broadcastTpvCommand(terminal.serialNumber || terminal.id, terminal.venueId, {
          ...command,
          commandId: queueResult.commandId,
          correlationId: queueResult.correlationId,
        })
        logger.info(`Command also broadcast via Socket.IO to terminal ${terminal.id}`)
      }

      // Note: Terminal state updates are handled by TpvCommandQueueService
      // when command result is received (via acknowledgeCommand)
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
          activatedAt: null, // Only mark as INACTIVE if never activated (e.g. before initial setup)
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
      const selectFields = {
        id: true,
        name: true,
        status: true,
        lastHeartbeat: true,
        version: true,
        systemInfo: true,
        ipAddress: true,
        createdAt: true,
        updatedAt: true,
      }

      // 1. First try to find by ID (CUID) - Dashboard sends terminal ID
      let terminal = await prisma.terminal.findUnique({
        where: { id: terminalId },
        select: selectFields,
      })

      // 2. If not found, try by serial number (Android sends serialNumber)
      // ✅ CASE-INSENSITIVE: Android may send lowercase, DB stores uppercase
      if (!terminal) {
        terminal = await prisma.terminal.findFirst({
          where: {
            serialNumber: {
              equals: terminalId,
              mode: 'insensitive', // Case-insensitive matching
            },
          },
          select: selectFields,
        })
      }

      // 3. If still not found and doesn't start with AVQD-, try with prefix (case-insensitive)
      // Android removes "AVQD-" prefix before sending, but database stores it with prefix
      if (!terminal && !terminalId.toUpperCase().startsWith('AVQD-')) {
        terminal = await prisma.terminal.findFirst({
          where: {
            serialNumber: {
              equals: `AVQD-${terminalId}`,
              mode: 'insensitive', // Case-insensitive matching
            },
          },
          select: selectFields,
        })
      }

      if (!terminal) {
        throw new NotFoundError(`Terminal with ID or serial number ${terminalId} not found`)
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

  /**
   * Get pending commands for a terminal (Square Terminal API polling pattern)
   * Called during heartbeat to deliver commands without requiring socket connection
   *
   * @param terminalId - Terminal ID or serial number
   * @returns Array of pending commands to execute
   */
  async getPendingCommands(terminalId: string): Promise<
    Array<{
      commandId: string
      correlationId: string
      type: string
      payload: any
      priority: string
      requiresPin: boolean
      expiresAt: string | null
      requestedBy: string
      requestedByName: string | null
      createdAt: string
    }>
  > {
    try {
      // Find terminal by ID or serial number (case-insensitive)
      let terminal = await prisma.terminal.findUnique({
        where: { id: terminalId },
        select: { id: true },
      })

      if (!terminal) {
        terminal = await prisma.terminal.findFirst({
          where: {
            serialNumber: {
              equals: terminalId,
              mode: 'insensitive',
            },
          },
          select: { id: true },
        })
      }

      if (!terminal && !terminalId.toUpperCase().startsWith('AVQD-')) {
        terminal = await prisma.terminal.findFirst({
          where: {
            serialNumber: {
              equals: `AVQD-${terminalId}`,
              mode: 'insensitive',
            },
          },
          select: { id: true },
        })
      }

      if (!terminal) {
        return []
      }

      // Get pending/queued commands that haven't expired
      // Note: Commands are created with status 'QUEUED' when terminal is online,
      // 'PENDING' when terminal is offline. Both should be delivered via heartbeat.
      const now = new Date()
      const pendingCommands = await prisma.tpvCommandQueue.findMany({
        where: {
          terminalId: terminal.id,
          status: { in: ['PENDING', 'QUEUED'] },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        take: 10, // Limit to prevent overwhelming the terminal
      })

      // Mark commands as SENT (in-flight)
      if (pendingCommands.length > 0) {
        await prisma.tpvCommandQueue.updateMany({
          where: {
            id: { in: pendingCommands.map(c => c.id) },
          },
          data: {
            status: 'SENT',
            lastAttemptAt: now,
            attempts: { increment: 1 },
          },
        })

        logger.info(`Delivering ${pendingCommands.length} commands to terminal ${terminalId} via heartbeat`, {
          terminalId,
          commandIds: pendingCommands.map(c => c.id),
          commandTypes: pendingCommands.map(c => c.commandType),
        })
      }

      return pendingCommands.map(cmd => ({
        commandId: cmd.id,
        correlationId: cmd.correlationId,
        type: cmd.commandType,
        payload: cmd.payload,
        priority: cmd.priority,
        requiresPin: cmd.requiresPin,
        expiresAt: cmd.expiresAt?.toISOString() || null,
        requestedBy: cmd.requestedBy,
        requestedByName: cmd.requestedByName,
        createdAt: cmd.createdAt.toISOString(),
      }))
    } catch (error) {
      logger.error(`Failed to get pending commands for terminal ${terminalId}:`, error)
      return []
    }
  }

  /**
   * Acknowledge command receipt/execution from terminal
   * Called by terminal after processing a command received via heartbeat
   *
   * **Security: Terminal Ownership Validation**
   * Validates that the terminal sending the ACK actually owns the command.
   * This prevents attackers from spoofing ACKs for commands they don't own.
   *
   * @param commandId - The command to acknowledge
   * @param terminalSerialNumber - The serial number of the terminal sending the ACK (for ownership validation)
   * @param resultStatus - The execution result status
   * @param resultMessage - Optional message describing the result
   * @param resultPayload - Optional payload with additional result data
   * @throws BadRequestError if terminal doesn't own the command
   */
  async acknowledgeCommand(
    commandId: string,
    terminalSerialNumber: string,
    resultStatus: 'SUCCESS' | 'FAILED' | 'REJECTED' | 'TIMEOUT',
    resultMessage?: string,
    resultPayload?: any,
  ): Promise<void> {
    try {
      // Try to find by id first (CUID like cminjwbv5...)
      let command = await prisma.tpvCommandQueue.findUnique({
        where: { id: commandId },
        include: { terminal: { select: { id: true, name: true, venueId: true, serialNumber: true, status: true } } },
      })

      // Fallback: Try to find by correlationId (UUID like ab5985e5-...)
      // This handles the case where Socket.IO broadcast sends correlationId as commandId
      if (!command) {
        command = await prisma.tpvCommandQueue.findFirst({
          where: { correlationId: commandId },
          include: { terminal: { select: { id: true, name: true, venueId: true, serialNumber: true, status: true } } },
        })

        if (command) {
          logger.info(`Command found by correlationId fallback: ${commandId} → ${command.id}`)
        }
      }

      if (!command) {
        logger.warn(`Command ${commandId} not found for acknowledgment (tried both id and correlationId)`)
        return
      }

      // Security: Validate terminal ownership
      // The terminal sending the ACK must be the one that owns the command
      const terminalMatches =
        command.terminal.serialNumber?.toLowerCase() === terminalSerialNumber.toLowerCase() ||
        command.terminal.serialNumber?.toLowerCase() === terminalSerialNumber.replace(/^AVQD-/i, '').toLowerCase() ||
        `AVQD-${command.terminal.serialNumber}`.toLowerCase() === terminalSerialNumber.toLowerCase()

      if (!terminalMatches) {
        logger.warn(
          `Security: Terminal ${terminalSerialNumber} attempted to ACK command ${commandId} owned by terminal ${command.terminal.serialNumber}`,
        )
        throw new Error(`Unauthorized: Terminal does not own this command`)
      }

      // Map result status to command status
      const statusMap: Record<string, 'COMPLETED' | 'FAILED'> = {
        SUCCESS: 'COMPLETED',
        FAILED: 'FAILED',
        REJECTED: 'FAILED',
        TIMEOUT: 'FAILED',
      }

      // CRITICAL: Use command.id (CUID) not commandId parameter
      // When command was found via correlationId fallback, commandId is the UUID but we need the CUID
      await prisma.tpvCommandQueue.update({
        where: { id: command.id },
        data: {
          status: statusMap[resultStatus] || 'FAILED',
          resultStatus: resultStatus as any,
          resultMessage,
          resultPayload: resultPayload || undefined,
          executedAt: new Date(),
        },
      })

      // Update terminal status if command was successful and affects terminal state
      if (resultStatus === 'SUCCESS') {
        const newTerminalStatus = COMMAND_STATUS_UPDATES[command.commandType as TpvCommandType]
        const updateData: any = { updatedAt: new Date() }
        let shouldUpdate = false

        // Handle status-changing commands
        if (newTerminalStatus) {
          updateData.status = newTerminalStatus
          shouldUpdate = true
        }

        // Handle lock-related state changes
        if (command.commandType === 'LOCK') {
          updateData.isLocked = true
          updateData.lockedAt = new Date()
          shouldUpdate = true
        } else if (command.commandType === 'UNLOCK') {
          updateData.isLocked = false
          updateData.lockReason = null
          updateData.lockMessage = null
          updateData.lockedAt = null
          updateData.lockedBy = null
          shouldUpdate = true
        } else if (command.commandType === 'REACTIVATE') {
          // REACTIVATE also clears lock state
          updateData.isLocked = false
          updateData.lockReason = null
          updateData.lockMessage = null
          updateData.lockedAt = null
          updateData.lockedBy = null
        }

        if (shouldUpdate) {
          await prisma.terminal.update({
            where: { id: command.terminal.id },
            data: updateData,
          })

          logger.info(`Terminal ${command.terminal.id} state updated after ${command.commandType}`, {
            terminalId: command.terminal.id,
            commandType: command.commandType,
            newStatus: newTerminalStatus || 'unchanged',
            isLocked: updateData.isLocked,
          })

          // Broadcast terminal status update to dashboard
          broadcastTpvStatusUpdate(command.terminal.id, command.terminal.venueId, {
            status: newTerminalStatus || (command.terminal.status as any),
          })
        }
      }

      // **State Sync on REJECTED (2025-12-01):**
      // When a command is REJECTED, it means the terminal is already in the opposite state.
      // This is important for syncing state when dashboard and terminal are out of sync.
      // Example: Dashboard shows MAINTENANCE but terminal says "I'm not in maintenance" → sync to ACTIVE
      if (resultStatus === 'REJECTED') {
        const syncUpdateData: any = { updatedAt: new Date() }
        let shouldSyncState = false
        let syncedStatus: TerminalStatus | undefined

        // EXIT_MAINTENANCE REJECTED = Terminal is NOT in maintenance → sync to ACTIVE
        if (command.commandType === 'EXIT_MAINTENANCE') {
          syncUpdateData.status = TerminalStatus.ACTIVE
          syncedStatus = TerminalStatus.ACTIVE
          shouldSyncState = true
          logger.info(`State sync: EXIT_MAINTENANCE rejected, terminal ${command.terminal.id} is not in maintenance → syncing to ACTIVE`)
        }
        // MAINTENANCE_MODE REJECTED = Terminal IS in maintenance → sync to MAINTENANCE
        else if (command.commandType === 'MAINTENANCE_MODE') {
          syncUpdateData.status = TerminalStatus.MAINTENANCE
          syncedStatus = TerminalStatus.MAINTENANCE
          shouldSyncState = true
          logger.info(
            `State sync: MAINTENANCE_MODE rejected, terminal ${command.terminal.id} is already in maintenance → syncing to MAINTENANCE`,
          )
        }
        // LOCK REJECTED = Terminal IS locked → sync isLocked = true
        else if (command.commandType === 'LOCK') {
          syncUpdateData.isLocked = true
          shouldSyncState = true
          logger.info(`State sync: LOCK rejected, terminal ${command.terminal.id} is already locked → syncing isLocked=true`)
        }
        // UNLOCK REJECTED = Terminal is NOT locked → sync isLocked = false
        else if (command.commandType === 'UNLOCK') {
          syncUpdateData.isLocked = false
          syncUpdateData.lockReason = null
          syncUpdateData.lockMessage = null
          syncUpdateData.lockedAt = null
          syncUpdateData.lockedBy = null
          shouldSyncState = true
          logger.info(`State sync: UNLOCK rejected, terminal ${command.terminal.id} is not locked → syncing isLocked=false`)
        }

        if (shouldSyncState) {
          await prisma.terminal.update({
            where: { id: command.terminal.id },
            data: syncUpdateData,
          })

          // Broadcast the corrected state to dashboard
          broadcastTpvStatusUpdate(command.terminal.id, command.terminal.venueId, {
            status: syncedStatus || (command.terminal.status as any),
            isLocked: syncUpdateData.isLocked,
          })
        }
      }

      // Broadcast result to dashboard via socket
      broadcastTpvCommandStatusChanged(command.terminal.id, command.terminal.venueId, {
        terminalId: command.terminal.id,
        terminalName: command.terminal.name || 'Unknown',
        commandId,
        correlationId: command.correlationId,
        commandType: command.commandType,
        previousStatus: command.status,
        newStatus: statusMap[resultStatus] || 'FAILED',
        message: resultMessage,
        statusChangedAt: new Date(),
      })

      logger.info(`Command ${commandId} acknowledged: ${resultStatus}`, {
        commandId,
        terminalId: command.terminalId,
        terminalSerialNumber,
        type: command.commandType,
        resultStatus,
        resultMessage,
      })
    } catch (error) {
      logger.error(`Failed to acknowledge command ${commandId}:`, error)
      throw error
    }
  }
}

// Export singleton instance
export const tpvHealthService = new TpvHealthService()
