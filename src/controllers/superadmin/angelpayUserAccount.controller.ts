/**
 * AngelPayUserAccount superadmin controller (Task 15 — Phase 2).
 *
 * Exposes the per-venue AngelPay user account lifecycle service via HTTP for
 * the dashboard AngelPay management UI (Task 16). All routes are mounted under
 * the existing superadmin router (auth + SUPERADMIN role enforced upstream).
 *
 * Endpoints:
 *   GET    /superadmin/venues/:venueId/angelpay-account
 *   POST   /superadmin/venues/:venueId/angelpay-account
 *   PATCH  /superadmin/angelpay-accounts/:id/pin
 *   PATCH  /superadmin/angelpay-accounts/:id/status
 *   DELETE /superadmin/angelpay-accounts/:id
 *
 * The PATCH /status endpoint dispatches on body.status to either
 * markAngelPayUserAccountRotationRequired or suspendAngelPayUserAccount —
 * keeping the URL shape symmetric with how the dashboard will model the
 * "change account state" action as a single button group with a reason field.
 *
 * Spec ref: §4.5 (account CRUD), §18.2 (Phase 2 plan).
 */

import { NextFunction, Request, Response } from 'express'

import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import {
  createAngelPayUserAccount,
  getAngelPayUserAccountById,
  getAngelPayUserAccountByVenueId,
  markAngelPayUserAccountRotationRequired,
  setAngelPayUserAccountPin,
  softDeleteAngelPayUserAccount,
  suspendAngelPayUserAccount,
} from '../../services/superadmin/angelpayUserAccount.service'
import {
  approveDiscoveredAngelPayMerchant,
  type VenuePaymentSlot,
} from '../../services/superadmin/merchantAccount.service'

/**
 * Strip `pinEncrypted` from the response shape — the dashboard never needs
 * the ciphertext, and surfacing it widens the blast radius if an XSS bug
 * ever lands client-side. The PIN is set/rotated via dedicated endpoints,
 * never read back.
 */
function sanitize(account: any) {
  if (!account) return account
  const { pinEncrypted: _pinEncrypted, ...rest } = account
  return rest
}

/**
 * GET /api/v1/superadmin/venues/:venueId/angelpay-account
 *
 * Returns `{ success: true, data: AngelPayUserAccount | null }`. A `null`
 * payload means the venue has not been provisioned yet — the dashboard
 * shows the "Create AngelPay account" call-to-action in that case.
 */
export async function getAngelPayUserAccountForVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    if (!venueId) {
      throw new BadRequestError('venueId is required')
    }

    const account = await getAngelPayUserAccountByVenueId(venueId)

    res.json({
      success: true,
      data: sanitize(account),
    })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /api/v1/superadmin/venues/:venueId/angelpay-account
 * Body: { email, pin?, environment }
 */
export async function createAngelPayUserAccountForVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { email, pin, environment } = req.body ?? {}

    if (!venueId) {
      throw new BadRequestError('venueId is required')
    }
    if (!email || typeof email !== 'string') {
      throw new BadRequestError('email is required')
    }
    if (environment !== 'QA' && environment !== 'PROD') {
      throw new BadRequestError('environment must be "QA" or "PROD"')
    }
    if (pin !== undefined && typeof pin !== 'string') {
      throw new BadRequestError('pin must be a string when provided')
    }

    const account = await createAngelPayUserAccount({
      venueId,
      email,
      pin,
      environment,
      createdBy: (req as any).user?.uid,
    })

    logger.info('AngelPay user account created via API', {
      event: 'angelpay.account.created',
      accountId: account.id,
      venueId,
      environment,
      hasPin: Boolean(pin),
      createdBy: (req as any).user?.uid,
    })

    res.status(201).json({
      success: true,
      data: sanitize(account),
    })
  } catch (err) {
    next(err)
  }
}

/**
 * PATCH /api/v1/superadmin/angelpay-accounts/:id/pin
 * Body: { pin }
 *
 * Always transitions the account to ACTIVE (the service guarantees this);
 * used to rotate PIN after a PIN_ROTATION_REQUIRED status or to first-time
 * activate a PENDING_PIN account.
 */
export async function setAngelPayUserAccountPinController(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { pin } = req.body ?? {}

    if (!id) {
      throw new BadRequestError('id is required')
    }
    if (!pin || typeof pin !== 'string') {
      throw new BadRequestError('pin is required')
    }

    const existing = await getAngelPayUserAccountById(id)
    if (!existing) {
      throw new NotFoundError('AngelPay account not found')
    }

    const account = await setAngelPayUserAccountPin(id, pin)

    logger.info('AngelPay user account PIN rotated', {
      event: 'angelpay.account.pin_rotated',
      accountId: id,
      changedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      data: sanitize(account),
    })
  } catch (err) {
    next(err)
  }
}

/**
 * PATCH /api/v1/superadmin/angelpay-accounts/:id/status
 * Body: { status: 'PIN_ROTATION_REQUIRED' | 'SUSPENDED', reason }
 *
 * Single endpoint, dispatched here so the dashboard only knows about
 * "change status" — not which underlying service function maps to which
 * status transition. Restored-from-suspended is not supported via this
 * endpoint by design: lifting a SUSPENDED account requires a deliberate
 * PIN rotation (setPin), which is itself an audit-worthy action.
 */
export async function updateAngelPayUserAccountStatusController(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { status, reason } = req.body ?? {}

    if (!id) {
      throw new BadRequestError('id is required')
    }
    if (!reason || typeof reason !== 'string') {
      throw new BadRequestError('reason is required')
    }

    const existing = await getAngelPayUserAccountById(id)
    if (!existing) {
      throw new NotFoundError('AngelPay account not found')
    }

    const changedBy = (req as any).user?.uid ?? 'unknown'

    let account
    switch (status) {
      case 'PIN_ROTATION_REQUIRED':
        account = await markAngelPayUserAccountRotationRequired(id, reason, changedBy)
        break
      case 'SUSPENDED':
        account = await suspendAngelPayUserAccount(id, reason, changedBy)
        break
      default:
        throw new BadRequestError(`Unsupported status transition: ${String(status)}`)
    }

    logger.info('AngelPay user account status changed', {
      event: 'angelpay.account.status_changed',
      accountId: id,
      status,
      reason,
      changedBy,
    })

    res.json({
      success: true,
      data: sanitize(account),
    })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /api/v1/superadmin/venues/:venueId/angelpay-merchants/:merchantAccountId/approve
 * Body: { slot?: 'PRIMARY' | 'SECONDARY' | 'TERTIARY' } (default: PRIMARY)
 *
 * Option B closure: approves an auto-discovered AngelPay MerchantAccount AND
 * assigns it to a VenuePaymentConfig slot atomically. Mirrors Blumon's
 * auto-attach-on-discovery pattern (Blumon attaches to Terminals; AngelPay
 * attaches to VenuePaymentConfig slots).
 *
 * 409 Conflict if the chosen slot is already occupied by another merchant.
 */
export async function approveAngelPayDiscoveredMerchantController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { venueId, merchantAccountId } = req.params
    const { slot, terminalIds } = (req.body ?? {}) as {
      slot?: VenuePaymentSlot
      terminalIds?: unknown
    }

    if (!venueId) {
      throw new BadRequestError('venueId is required')
    }
    if (!merchantAccountId) {
      throw new BadRequestError('merchantAccountId is required')
    }

    const resolvedSlot: VenuePaymentSlot = slot ?? 'PRIMARY'
    if (resolvedSlot !== 'PRIMARY' && resolvedSlot !== 'SECONDARY' && resolvedSlot !== 'TERTIARY') {
      throw new BadRequestError(`slot must be one of PRIMARY|SECONDARY|TERTIARY (got "${String(slot)}")`)
    }

    // Optional per-terminal scoping. Treat undefined/empty as "no restriction"
    // (merchant available on every brand-compatible terminal in the venue via
    // VenuePaymentConfig inheritance).
    let resolvedTerminalIds: string[] | undefined
    if (terminalIds !== undefined && terminalIds !== null) {
      if (!Array.isArray(terminalIds) || !terminalIds.every((t) => typeof t === 'string')) {
        throw new BadRequestError('terminalIds must be a string[] when provided')
      }
      const deduped = Array.from(new Set(terminalIds as string[]))
      resolvedTerminalIds = deduped.length > 0 ? deduped : undefined
    }

    const result = await approveDiscoveredAngelPayMerchant({
      venueId,
      merchantAccountId,
      slot: resolvedSlot,
      terminalIds: resolvedTerminalIds,
    })

    logger.info('AngelPay discovered merchant approved via API', {
      event: 'angelpay.discovered_merchant_approved_api',
      venueId,
      merchantAccountId,
      slot: resolvedSlot,
      terminalIds: resolvedTerminalIds,
      changedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      data: result,
    })
  } catch (err) {
    next(err)
  }
}

/**
 * DELETE /api/v1/superadmin/angelpay-accounts/:id
 *
 * Soft delete — sets status=DELETED. The row is preserved for audit /
 * report-error backfill purposes (FK from validation logs etc.).
 */
export async function deleteAngelPayUserAccountController(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    if (!id) {
      throw new BadRequestError('id is required')
    }

    const existing = await getAngelPayUserAccountById(id)
    if (!existing) {
      throw new NotFoundError('AngelPay account not found')
    }

    const changedBy = (req as any).user?.uid ?? 'unknown'
    const account = await softDeleteAngelPayUserAccount(id, changedBy)

    logger.info('AngelPay user account soft-deleted', {
      event: 'angelpay.account.deleted',
      accountId: id,
      changedBy,
    })

    res.json({
      success: true,
      data: sanitize(account),
    })
  } catch (err) {
    next(err)
  }
}
