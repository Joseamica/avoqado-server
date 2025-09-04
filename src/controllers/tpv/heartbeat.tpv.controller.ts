import { NextFunction, Request, Response } from 'express'
import { HeartbeatData, tpvHealthService } from '../../services/tpv/tpv-health.service'
import logger from '../../config/logger'

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

    logger.info(`Heartbeat processed, server status: ${terminalHealth.status}`, {
      terminalId: heartbeatData.terminalId,
      clientReported: heartbeatData.status,
      serverStatus: terminalHealth.status,
    })

    res.status(200).json({
      success: true,
      message: 'Heartbeat processed successfully',
      serverStatus: terminalHealth.status, // This allows Android to sync its local state
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error(`Failed to process unauthenticated heartbeat:`, error)
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
