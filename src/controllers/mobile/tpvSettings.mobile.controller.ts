/**
 * Mobile TPV Settings Controller
 *
 * Combined endpoint that returns venue terminals + merged settings
 * for the first active terminal in a single request.
 *
 * Replaces two dashboard calls:
 *   GET /dashboard/venues/:venueId/tpvs
 *   GET /dashboard/tpv/:tpvId/settings
 */

import { NextFunction, Request, Response } from 'express'
import prisma from '../../utils/prismaClient'
import { TpvSettings, getTpvSettings } from '../../services/dashboard/tpv.dashboard.service'

/**
 * Get venue terminals and merged settings for the first active terminal.
 * @route GET /api/v1/mobile/venues/:venueId/tpv-settings
 */
export const getVenueTpvSettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params

    // 1. Fetch all terminals for this venue (lightweight fields + config for merge)
    const terminals = await prisma.terminal.findMany({
      where: { venueId },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        serialNumber: true,
        brand: true,
        model: true,
        lastHeartbeat: true,
        config: true,
        configOverrides: true,
        assignedMerchantIds: true,
        preferredProcessor: true,
        activatedAt: true,
      },
      orderBy: { name: 'asc' },
    })

    // 2. Find the first ACTIVE terminal
    const activeTerminal = terminals.find(t => t.status === 'ACTIVE') ?? null

    // 3. If there is an active terminal, get its merged settings
    let settings: TpvSettings | null = null
    if (activeTerminal) {
      settings = await getTpvSettings(activeTerminal.id)
    }

    // 4. Strip config/configOverrides from terminal list (settings are returned separately)
    const terminalList = terminals.map(({ config, configOverrides, ...rest }) => rest)

    return res.json({
      success: true,
      data: {
        terminals: terminalList,
        settings,
        activeTerminalId: activeTerminal?.id ?? null,
      },
    })
  } catch (error) {
    next(error)
  }
}
