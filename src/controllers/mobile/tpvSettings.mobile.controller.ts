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
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { VenuePlanInfo, getVenuePlanInfo } from '../../services/access/basePlan.service'
import { TpvSettings, getTpvSettings } from '../../services/dashboard/tpv.dashboard.service'

function requestDeviceUid(req: Request): string | null {
  const raw = req.headers?.['x-device-id']
  const value = Array.isArray(raw) ? raw[0] : raw
  const trimmed = typeof value === 'string' ? value.trim().slice(0, 64) : ''
  return trimmed || null
}

/**
 * Get venue terminals and merged settings for the requesting device's terminal
 * (with the first active terminal retained as a legacy fallback),
 * plus the venue's plan-tier info (optional `plan` field) so POS apps can
 * gate UI by plan.
 * @route GET /api/v1/mobile/venues/:venueId/settings
 */
export const getVenueTpvSettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params

    // 1. Fetch all terminals (lightweight fields + config for merge), in parallel with the
    //    venue's plan-tier info (additive `plan` field — POS apps gate UI by plan).
    //    RESILIENT: a plan-lookup failure must NEVER break venue-select on the POS — log it
    //    and return the settings WITHOUT the plan field (apps fail open).
    const [terminals, plan] = await Promise.all([
      prisma.terminal.findMany({
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
          deviceUid: true,
          fulfillmentAreaId: true,
          canIssueAreaTickets: true,
          canCheckoutAreaTickets: true,
          canDeliverAreaTickets: true,
          defaultWorkspace: true,
        },
        orderBy: { name: 'asc' },
      }),
      getVenuePlanInfo(venueId).catch((error): VenuePlanInfo | undefined => {
        logger.error('Failed to resolve plan info for mobile venue settings — returning settings without plan', { venueId, error })
        return undefined
      }),
    ])

    // 2. Prefer the terminal that made this request. A venue can have an area
    //    station, a checkout and a café terminal at the same time; choosing the
    //    first active row would leak one device's workspace/settings into another.
    //    Headerless legacy clients keep the previous first-active fallback.
    const deviceUid = requestDeviceUid(req)
    const deviceTerminal = deviceUid ? (terminals.find(t => t.status === 'ACTIVE' && t.deviceUid === deviceUid) ?? null) : null
    const activeTerminal = deviceTerminal ?? terminals.find(t => t.status === 'ACTIVE') ?? null

    // 3. If there is an active terminal, get its merged settings
    let settings: TpvSettings | null = null
    if (activeTerminal) {
      settings = await getTpvSettings(activeTerminal.id)
    }

    // 4. Strip private/internal fields from the terminal list. Per-device area
    //    capabilities are returned separately below so Android never has to infer
    //    its identity from a venue-wide list.
    const terminalList = terminals.map(
      ({
        config,
        configOverrides,
        deviceUid: _deviceUid,
        fulfillmentAreaId: _fulfillmentAreaId,
        canIssueAreaTickets: _canIssueAreaTickets,
        canCheckoutAreaTickets: _canCheckoutAreaTickets,
        canDeliverAreaTickets: _canDeliverAreaTickets,
        defaultWorkspace: _defaultWorkspace,
        ...rest
      }) => rest,
    )

    // 5. `plan` is ADDITIVE and OPTIONAL (omitted when the lookup failed) — existing fields
    //    must never be removed/renamed (old app versions depend on them).
    return res.json({
      success: true,
      data: {
        terminals: terminalList,
        settings,
        activeTerminalId: activeTerminal?.id ?? null,
        deviceTerminal: deviceTerminal
          ? {
              id: deviceTerminal.id,
              defaultWorkspace: deviceTerminal.defaultWorkspace,
              canIssueAreaTickets: deviceTerminal.canIssueAreaTickets,
              canCheckoutAreaTickets: deviceTerminal.canCheckoutAreaTickets,
              canDeliverAreaTickets: deviceTerminal.canDeliverAreaTickets,
              fulfillmentAreaId: deviceTerminal.fulfillmentAreaId,
            }
          : null,
        ...(plan ? { plan } : {}),
      },
    })
  } catch (error) {
    next(error)
  }
}
