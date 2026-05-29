import { Request, Response, NextFunction } from 'express'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { verifyApprovalToken, verifySerialAssignmentToken } from '@/services/dashboard/terminalOrder/token.service'
import { approveSpei, assignSerials, rejectSpei } from '@/services/dashboard/terminalOrder/terminalOrder.service'

/**
 * Public, token-protected endpoints for the SPEI approve/reject magic-link
 * flow. No session cookie or Bearer auth — possession of the signed JWT in
 * `?token=...` proves authorization. The token must encode the same orderId
 * as the URL.
 */

/**
 * Distinguish expected idempotent re-fires (the magic-link page hits the same
 * endpoint twice in React StrictMode, or sales double-clicks the email link,
 * or sales refreshes the success page) from real failures. The service throws
 * `Order is not in <X> state (current: <Y>)` when the order has already
 * advanced past the action's required state — that's a no-op, not an error.
 *
 * Returning `true` makes the caller log at `info` instead of `error` so
 * monitoring / alerting doesn't get paged for harmless re-fires.
 */
function isAlreadyAdvancedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    /Order is not in [A-Z_]+ state \(current: [A-Z_]+\)/.test(err.message) ||
    /Order .* already assigned/i.test(err.message) ||
    /already in use/i.test(err.message) // serial uniqueness on re-submit
  )
}

/**
 * GET /api/v1/public/tpv-orders/:id/approve?token=...
 *
 * Sales operator clicks the "Aprobar" link in the SPEI-proof email and lands
 * here. We verify the token, ensure it matches the URL's orderId, then call
 * approveSpei which transitions the order to PROOF_APPROVED + COMPLETED.
 */
export async function approveOrderHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const token = String(req.query.token ?? '')
    let payload
    try {
      payload = verifyApprovalToken(token)
    } catch (err) {
      res.status(401).json({
        success: false,
        error: err instanceof Error ? err.message : 'Token inválido',
      })
      return
    }
    if (payload.orderId !== id) {
      res.status(403).json({ success: false, error: 'Token does not match this order' })
      return
    }

    const updated = await approveSpei({ orderId: id, approvedBy: 'magic-link' })
    res.json({
      success: true,
      data: { orderId: updated.id, orderNumber: updated.orderNumber },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (isAlreadyAdvancedError(error)) {
      logger.info('approveOrderHandler idempotent re-fire (order already advanced)', {
        orderId: req.params.id,
        reason: msg,
      })
    } else {
      logger.error('approveOrderHandler failed', { error: msg })
    }
    if (error instanceof Error) {
      res.status(400).json({ success: false, error: error.message })
      return
    }
    next(error)
  }
}

/**
 * POST /api/v1/public/tpv-orders/:id/reject?token=...
 * Body: { reason: string }
 *
 * Sales operator submits a reject reason via the magic-link reject page.
 * Token is verified the same way as approve; the reason is forwarded to
 * rejectSpei (validated upstream via Zod).
 */
export async function rejectOrderHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const token = String(req.query.token ?? '')
    let payload
    try {
      payload = verifyApprovalToken(token)
    } catch (err) {
      res.status(401).json({
        success: false,
        error: err instanceof Error ? err.message : 'Token inválido',
      })
      return
    }
    if (payload.orderId !== id) {
      res.status(403).json({ success: false, error: 'Token does not match this order' })
      return
    }

    const { reason } = req.body
    const updated = await rejectSpei({ orderId: id, reason, rejectedBy: 'magic-link' })
    res.json({
      success: true,
      data: { orderId: updated.id, orderNumber: updated.orderNumber },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (isAlreadyAdvancedError(error)) {
      logger.info('rejectOrderHandler idempotent re-fire (order already advanced)', {
        orderId: req.params.id,
        reason: msg,
      })
    } else {
      logger.error('rejectOrderHandler failed', { error: msg })
    }
    if (error instanceof Error) {
      res.status(400).json({ success: false, error: error.message })
      return
    }
    next(error)
  }
}

/**
 * GET /api/v1/public/tpv-orders/:id/approve/check?token=...
 *
 * Lightweight token validity check used by the magic-link landing page to
 * decide whether to render the approve/reject UI or an "invalid/expired link"
 * state — never mutates the order.
 */
export async function approveCheckHandler(req: Request, res: Response) {
  const { id } = req.params
  const token = String(req.query.token ?? '')
  try {
    const payload = verifyApprovalToken(token)
    if (payload.orderId !== id) {
      res.status(403).json({ success: false, error: 'Token does not match this order' })
      return
    }
    res.json({ success: true, data: { orderId: id, valid: true } })
  } catch (err) {
    res.status(401).json({
      success: false,
      error: err instanceof Error ? err.message : 'Token inválido',
    })
  }
}

/**
 * GET /api/v1/public/tpv-orders/:id/assign-serials/check?token=...
 *
 * Magic-link landing page hits this before rendering the serial-assignment
 * form. Verifies the token, checks the order is still AWAITING_SERIALS, and
 * returns the order shape (items + venue) so the form can render rows per
 * item with the correct quantity.
 */
export async function assignSerialsCheckHandler(req: Request, res: Response) {
  const { id } = req.params
  const token = String(req.query.token ?? '')
  try {
    const payload = verifySerialAssignmentToken(token)
    if (payload.orderId !== id) {
      res.status(403).json({ success: false, error: 'Token does not match this order' })
      return
    }
    const order = await prisma.terminalOrder.findUnique({
      where: { id },
      include: { items: true, venue: { select: { name: true, slug: true } } },
    })
    if (!order) {
      res.status(404).json({ success: false, error: 'Order not found' })
      return
    }
    if (order.fulfillmentStatus !== 'AWAITING_SERIALS') {
      res.status(409).json({
        success: false,
        error: `Order is no longer in AWAITING_SERIALS state (current: ${order.fulfillmentStatus})`,
      })
      return
    }
    res.json({ success: true, data: order })
  } catch (err) {
    res.status(401).json({ success: false, error: err instanceof Error ? err.message : 'Token inválido' })
  }
}

/**
 * POST /api/v1/public/tpv-orders/:id/assign-serials?token=...
 * Body: { items: [{ orderItemId, units: [{ name, serial }] }] }
 *
 * Sales operator submits PAX serial numbers via the magic-link form. After
 * a successful assignment we null out the token so the link is single-use —
 * a second submit would 401 on the next check.
 */
export async function assignSerialsPublicHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const token = String(req.query.token ?? '')
    let payload
    try {
      payload = verifySerialAssignmentToken(token)
    } catch (err) {
      res.status(401).json({ success: false, error: err instanceof Error ? err.message : 'Token inválido' })
      return
    }
    if (payload.orderId !== id) {
      res.status(403).json({ success: false, error: 'Token does not match this order' })
      return
    }

    const updated = await assignSerials({
      orderId: id,
      assignedBy: 'magic-link',
      items: req.body.items,
    })

    // Clear the serial assignment token after successful use (single-use)
    await prisma.terminalOrder.update({
      where: { id },
      data: { serialAssignmentToken: null, serialAssignmentTokenExpiresAt: null },
    })

    res.json({ success: true, data: { orderId: updated.id, orderNumber: updated.orderNumber } })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (isAlreadyAdvancedError(error)) {
      logger.info('assignSerialsPublicHandler idempotent re-fire (order already advanced)', {
        orderId: req.params.id,
        reason: msg,
      })
    } else {
      logger.error('assignSerialsPublicHandler failed', { error: msg })
    }
    if (error instanceof Error) {
      res.status(400).json({ success: false, error: error.message })
      return
    }
    next(error)
  }
}
