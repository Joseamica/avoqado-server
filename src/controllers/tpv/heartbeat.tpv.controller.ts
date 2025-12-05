import { NextFunction, Request, Response } from 'express'
import { HeartbeatData, tpvHealthService } from '../../services/tpv/tpv-health.service'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'

/**
 * Calculate config version for a terminal's merchant configuration
 * Part of the 3-layer cache invalidation strategy (Layer 2: PULL via heartbeat)
 *
 * Version is based on:
 * - Number of assigned merchants
 * - Most recent updatedAt timestamp of any assigned merchant
 *
 * This allows Android to compare its cached config version with the server's
 * and refresh if they don't match (handles missed Socket.IO events)
 */
async function getMerchantConfigVersion(terminalId: string): Promise<string | null> {
  try {
    // Find terminal and its assigned merchants
    const terminal = await prisma.terminal.findFirst({
      where: {
        OR: [
          { id: terminalId },
          { serialNumber: { equals: terminalId, mode: 'insensitive' } },
          { serialNumber: { equals: `AVQD-${terminalId}`, mode: 'insensitive' } },
        ],
      },
      select: {
        assignedMerchantIds: true,
      },
    })

    if (!terminal || terminal.assignedMerchantIds.length === 0) {
      return null // No merchants assigned
    }

    // Get the latest updatedAt from all assigned merchants
    const merchants = await prisma.merchantAccount.findMany({
      where: {
        id: { in: terminal.assignedMerchantIds },
      },
      select: {
        id: true,
        updatedAt: true,
      },
      orderBy: {
        updatedAt: 'desc',
      },
      take: 1, // Only need the most recent
    })

    if (merchants.length === 0) {
      return null
    }

    // Version format: "{count}-{latestTimestamp}"
    // Example: "2-1701532800000" means 2 merchants, latest update at timestamp
    const latestTimestamp = merchants[0].updatedAt.getTime()
    return `${terminal.assignedMerchantIds.length}-${latestTimestamp}`
  } catch (error) {
    logger.error('Failed to calculate merchant config version', {
      terminalId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return null // Non-blocking - return null if calculation fails
  }
}

/**
 * Process heartbeat from TPV terminal (unauthenticated endpoint)
 * This allows terminals to report status even when authentication fails
 * and returns server status for synchronization
 */
export async function processHeartbeat(req: Request<{}, {}, HeartbeatData>, res: Response, next: NextFunction): Promise<void> {
  try {
    const heartbeatData = req.body
    const clientIp = req.ip || req.socket.remoteAddress

    logger.info(`Unauthenticated heartbeat received from terminal ${heartbeatData.terminalId}`, {
      terminalId: heartbeatData.terminalId,
      status: heartbeatData.status,
      ip: clientIp,
    })

    // Process the heartbeat using the existing service
    await tpvHealthService.processHeartbeat(heartbeatData, clientIp)

    // Get current server status for the terminal to enable synchronization
    const terminalHealth = await tpvHealthService.getTerminalHealth(heartbeatData.terminalId)

    // Get pending commands for this terminal (Square Terminal API polling pattern)
    // This delivers commands via HTTP instead of requiring socket connection
    const pendingCommands = await tpvHealthService.getPendingCommands(heartbeatData.terminalId)

    // Layer 2 of 3-layer cache invalidation: Include config version in heartbeat response
    // Android compares this with its cached version and refreshes if they don't match
    // This catches missed Socket.IO events (Layer 1) when terminal was offline
    const configVersion = await getMerchantConfigVersion(heartbeatData.terminalId)

    logger.info(`Heartbeat processed, server status: ${terminalHealth.status}`, {
      terminalId: heartbeatData.terminalId,
      clientReported: heartbeatData.status,
      serverStatus: terminalHealth.status,
      pendingCommandsCount: pendingCommands.length,
      configVersion,
    })

    res.status(200).json({
      success: true,
      message: 'Heartbeat processed successfully',
      serverStatus: terminalHealth.status, // This allows Android to sync its local state
      timestamp: new Date().toISOString(),
      // Square/Toast pattern: Include pending commands in heartbeat response
      // Terminal doesn't need socket connection to receive commands
      pendingCommands: pendingCommands.length > 0 ? pendingCommands : undefined,
      // Layer 2 of 3-layer cache invalidation: Config version for merchant sync
      // Format: "{count}-{latestTimestamp}" e.g. "2-1701532800000"
      // Android should refresh merchant config if this doesn't match local cached version
      configVersion: configVersion || undefined,
    })
  } catch (error) {
    logger.error(`Failed to process unauthenticated heartbeat:`, error)
    next(error)
  }
}

/**
 * Acknowledge command execution from TPV terminal
 * Called by terminal after processing a command received via heartbeat
 *
 * **Security: Terminal Ownership Validation**
 * The terminal must provide its serialNumber (terminalId) in the request.
 * The service validates that the command belongs to that terminal before processing.
 * This prevents attackers from spoofing ACKs for commands they don't own.
 */
export async function acknowledgeCommand(
  req: Request<{}, {}, { commandId: string; terminalId: string; resultStatus: string; resultMessage?: string; resultPayload?: any }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { commandId, terminalId, resultStatus, resultMessage, resultPayload } = req.body

    // Validate required fields
    if (!commandId || !resultStatus) {
      res.status(400).json({
        success: false,
        error: 'commandId and resultStatus are required',
      })
      return
    }

    // Security: Require terminalId to validate ownership
    if (!terminalId) {
      res.status(400).json({
        success: false,
        error: 'terminalId is required for security validation',
      })
      return
    }

    const validStatuses = ['SUCCESS', 'FAILED', 'REJECTED', 'TIMEOUT']
    if (!validStatuses.includes(resultStatus)) {
      res.status(400).json({
        success: false,
        error: `Invalid resultStatus. Must be one of: ${validStatuses.join(', ')}`,
      })
      return
    }

    logger.info(`Command ACK received: ${commandId} - ${resultStatus}`, {
      commandId,
      terminalId,
      resultStatus,
      resultMessage,
    })

    // Service validates terminal ownership before processing
    await tpvHealthService.acknowledgeCommand(
      commandId,
      terminalId,
      resultStatus as 'SUCCESS' | 'FAILED' | 'REJECTED' | 'TIMEOUT',
      resultMessage,
      resultPayload,
    )

    res.status(200).json({
      success: true,
      message: 'Command acknowledgment processed',
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error(`Failed to acknowledge command:`, error)
    next(error)
  }
}

/**
 * Get current terminal status from server for synchronization
 * This allows terminals to sync their local state with server state when reconnecting
 */
export async function getTerminalStatus(req: Request<{ serialNumber: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { serialNumber } = req.params

    logger.info(`Status sync requested for terminal ${serialNumber}`)

    // Get current server status for the terminal
    const terminalHealth = await tpvHealthService.getTerminalHealth(serialNumber)

    if (!terminalHealth) {
      logger.warn(`Terminal not found for status sync: ${serialNumber}`)
      res.status(404).json({
        success: false,
        error: 'Terminal not found',
      })
      return
    }

    logger.info(`Returning server status for terminal ${serialNumber}: ${terminalHealth.status}`)

    res.status(200).json({
      success: true,
      status: terminalHealth.status,
      message: `Terminal status: ${terminalHealth.status}`,
      lastSeen: terminalHealth.lastSeen,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error(`Failed to get terminal status for ${req.params.serialNumber}:`, error)
    next(error)
  }
}
