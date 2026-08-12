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
import { logAction } from '../../services/dashboard/activity-log.service'

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
          customerDisplayInverted: true,
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
    // POS Android devices can be marked INACTIVE by terminal-health liveness even
    // while authenticated mobile requests keep updating their lastHeartbeat.
    // Status is not the identity or permission boundary here: the exact deviceUid,
    // staff permissions and the downstream feature endpoints are. Still exclude
    // terminals that have not been activated, are in maintenance or were retired.
    const deviceTerminal = deviceUid
      ? (terminals.find(t => (t.status === 'ACTIVE' || t.status === 'INACTIVE') && t.deviceUid === deviceUid) ?? null)
      : null
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
        customerDisplayInverted: _customerDisplayInverted,
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
              customerDisplayInverted: deviceTerminal.customerDisplayInverted,
            }
          : null,
        ...(plan ? { plan } : {}),
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Set (or clear) whether THIS terminal has an inverted customer display —
 * the customer sees the big screen and the cashier works the small one.
 * Per-DEVICE (how that counter is physically wired), not per-venue. The POS
 * applies its local value and syncs it here; the dashboard can change it
 * remotely.
 * @route PATCH /api/v1/mobile/venues/:venueId/terminals/:terminalId/display-mode
 */
export const updateDisplayMode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, terminalId } = req.params
    const { customerDisplayInverted } = req.body as { customerDisplayInverted: boolean }

    // Verify the terminal belongs to THIS venue before writing — otherwise a
    // valid token for venue A could reconfigure venue B's counter.
    const terminal = await prisma.terminal.findFirst({
      where: { id: terminalId, venueId },
      select: { id: true, customerDisplayInverted: true },
    })

    if (!terminal) {
      return res.status(404).json({
        success: false,
        message: 'La terminal no pertenece a este establecimiento',
      })
    }

    const updated = await prisma.terminal.update({
      where: { id: terminalId },
      data: { customerDisplayInverted },
      select: { id: true, customerDisplayInverted: true },
    })

    await logAction({
      staffId: req.authContext?.userId ?? null,
      venueId,
      action: 'TERMINAL_DISPLAY_MODE_UPDATED',
      entity: 'Terminal',
      entityId: updated.id,
      data: { from: terminal.customerDisplayInverted, to: updated.customerDisplayInverted },
    })

    return res.json({ success: true, data: updated })
  } catch (error) {
    logger.error('Error updating terminal display mode', { error })
    next(error)
  }
}
