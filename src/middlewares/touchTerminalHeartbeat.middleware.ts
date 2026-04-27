import { NextFunction, Request, Response } from 'express'
import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { broadcastTpvStatusUpdate } from '../communication/sockets'

/**
 * Touch Terminal Heartbeat Middleware
 *
 * **Problem solved:**
 * Terminals are appearing OFFLINE in the dashboard even while actively transacting.
 * Root cause: terminal.lastHeartbeat is only updated by two specific paths
 * (POST /tpv/heartbeat and Socket.IO `tpv:heartbeat` event), both of which can
 * fail independently of normal API traffic. Terminal can be processing dozens
 * of orders/payments per hour but appear "Sin conexión 3h".
 *
 * **Solution (Square/Toast pattern):**
 * If a terminal is making authenticated API calls, it's alive. Use the existence
 * of any successful authenticated request as a heartbeat signal — touching
 * terminal.lastHeartbeat as a side-effect on every request that carries a valid
 * terminalSerialNumber in its JWT auth context.
 *
 * **Behavior:**
 * - Hooks into `res.on('finish')` to run AFTER the route handler (so authContext
 *   is populated by authenticateTokenMiddleware) and AFTER the response is sent
 *   (so client latency is unaffected — pure fire-and-forget).
 * - Skips if no auth context, no terminalSerialNumber, or statusCode >= 500.
 * - Per-terminal debounce: at most one DB write per TOUCH_DEBOUNCE_MS per terminal.
 * - Failures logged at WARN but never thrown (must not break business requests).
 * - Broadcasts the new lastHeartbeat to the venue's dashboard so UI updates live.
 *
 * **Why a debounce cache:**
 * A busy terminal may make 5-10 authenticated requests per second during peak.
 * Without debounce we'd hammer Postgres with redundant updates. 30s ≪ the 5min
 * dashboard "online" threshold, so freshness is preserved.
 *
 * **Memory safety:**
 * The cache is bounded by MAX_CACHE_ENTRIES with simple eviction of the oldest
 * entry on overflow. With ~hundreds of terminals deployed this is bounded under
 * a few KB; even with thousands of unique serials per process lifetime it stays
 * well below MB-level.
 */

const TOUCH_DEBOUNCE_MS = 30_000 // 30s — well under the 5min "online" threshold
const MAX_CACHE_ENTRIES = 5_000

// Kill-switch: set TOUCH_HEARTBEAT_ENABLED=false in Render env vars to disable
// without redeploying if this middleware causes pool pressure or dashboard spam.
const isEnabled = (): boolean => process.env.TOUCH_HEARTBEAT_ENABLED !== 'false'

// Broadcast kill-switch: set TOUCH_HEARTBEAT_BROADCAST=false to keep updating
// the DB but stop emitting socket events to dashboards. Safe partial rollback
// if dashboards become laggy from broadcast volume.
const isBroadcastEnabled = (): boolean => process.env.TOUCH_HEARTBEAT_BROADCAST !== 'false'

const lastTouchAt = new Map<string, number>()

function rememberTouch(serial: string, timestamp: number): void {
  if (lastTouchAt.size >= MAX_CACHE_ENTRIES) {
    // Simple eviction: drop the oldest entry. Map preserves insertion order.
    const oldestKey = lastTouchAt.keys().next().value
    if (oldestKey !== undefined) lastTouchAt.delete(oldestKey)
  }
  lastTouchAt.set(serial, timestamp)
}

async function performTouch(serial: string): Promise<void> {
  // Resolve the terminal by serial (case-insensitive, with or without AVQD- prefix).
  // We only need the id and venueId — keep this query as cheap as possible to
  // avoid pressuring the connection pool that already times out under load.
  const terminal = await prisma.terminal.findFirst({
    where: {
      OR: [
        { serialNumber: { equals: serial, mode: 'insensitive' } },
        { serialNumber: { equals: `AVQD-${serial}`, mode: 'insensitive' } },
        { id: serial }, // last-resort match if JWT carries a CUID instead of a serial
      ],
    },
    select: { id: true, venueId: true, status: true },
  })

  if (!terminal) {
    logger.warn(`[touchHeartbeat] Terminal not found for serial="${serial}" — JWT carried unknown identifier`)
    return
  }

  const now = new Date()

  await prisma.terminal.update({
    where: { id: terminal.id },
    data: { lastHeartbeat: now },
  })

  // Refresh dashboards in real time. Disabled if TOUCH_HEARTBEAT_BROADCAST=false.
  // broadcastTpvStatusUpdate already wraps in its own try/catch, so failures here
  // are doubly safe — the next page refresh will pick up the new lastHeartbeat anyway.
  if (isBroadcastEnabled()) {
    broadcastTpvStatusUpdate(terminal.id, terminal.venueId, {
      status: terminal.status,
      lastHeartbeat: now,
    })
  }
}

export const touchTerminalHeartbeatMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // Kill-switch: skip entirely if disabled via env var. Allows instant rollback
  // from Render dashboard without redeploying if pool pressure or other issues appear.
  if (!isEnabled()) {
    next()
    return
  }

  res.on('finish', () => {
    // 1. Only consider successful or client-error responses. 5xx may indicate the
    //    backend itself is in trouble — don't add extra DB writes during incidents.
    if (res.statusCode >= 500) return

    // 2. authContext is set by authenticateTokenMiddleware. Public endpoints
    //    (e.g., POST /tpv/heartbeat itself, /activate, /check-update) have no
    //    authContext, so they're naturally skipped here.
    const authContext = req.authContext
    const serial = authContext?.terminalSerialNumber
    if (!serial) return

    // 3. Per-terminal debounce.
    const now = Date.now()
    const last = lastTouchAt.get(serial) ?? 0
    if (now - last < TOUCH_DEBOUNCE_MS) return
    rememberTouch(serial, now)

    // 4. Fire-and-forget — must never block or throw.
    performTouch(serial).catch(err => {
      logger.warn(`[touchHeartbeat] Update failed for ${serial}: ${err instanceof Error ? err.message : 'unknown'}`)
    })
  })

  next()
}
