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
import { TerminalStatus } from '@prisma/client'

import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import {
  createAngelPayUserAccount,
  getAngelPayUserAccountById,
  getAngelPayUserAccountByVenueId,
  getAngelPayUserAccountsByVenueId,
  hardDeleteAngelPayUserAccount,
  markAngelPayUserAccountRotationRequired,
  reactivateAngelPayUserAccount,
  setAngelPayUserAccountPin,
  softDeleteAngelPayUserAccount,
  suspendAngelPayUserAccount,
  updateAngelPayUserAccountCredentials,
} from '../../services/superadmin/angelpayUserAccount.service'
import {
  approveDiscoveredAngelPayMerchant,
  reserveAngelPaySlot,
  type VenuePaymentSlot,
} from '../../services/superadmin/merchantAccount.service'
import prisma from '../../utils/prismaClient'
import { tpvCommandQueueService } from '../../services/tpv/command-queue.service'

/**
 * Strip PIN material (`pin` plaintext + legacy `pinEncrypted`) from the
 * response shape — the dashboard never needs the PIN, and surfacing it widens
 * the blast radius if an XSS bug ever lands client-side. The PIN is set/rotated
 * via dedicated endpoints, never read back.
 */
function sanitize(account: any) {
  if (!account) return account
  const { pin: _pin, pinEncrypted: _pinEncrypted, ...rest } = account
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
 * PATCH /api/v1/superadmin/angelpay-accounts/:id/credentials
 * Body: { email?: string, environment?: 'QA' | 'PROD' }
 *
 * Edit email and/or environment of an UNCONFIRMED account. Only allowed while
 * status === PENDING_PIN — once a PIN has been set the account is "confirmed"
 * and the AngelPay SDK has likely validated it (externalUserId populated), so
 * changing the email after that would silently de-sync the dashboard view
 * from the actual AngelPay-side identity. For ACTIVE accounts use the
 * "Eliminar + Crear" flow if a re-do is needed.
 */
export async function updateAngelPayUserAccountCredentialsController(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { email, environment } = (req.body ?? {}) as { email?: unknown; environment?: unknown }

    if (!id) {
      throw new BadRequestError('id is required')
    }
    if (email !== undefined && typeof email !== 'string') {
      throw new BadRequestError('email must be a string when provided')
    }
    if (environment !== undefined && environment !== 'QA' && environment !== 'PROD') {
      throw new BadRequestError('environment must be "QA" or "PROD" when provided')
    }
    if (email === undefined && environment === undefined) {
      throw new BadRequestError('at least one of {email, environment} must be provided')
    }

    const existing = await getAngelPayUserAccountById(id)
    if (!existing) {
      throw new NotFoundError('AngelPay account not found')
    }

    const account = await updateAngelPayUserAccountCredentials(id, {
      email: email as string | undefined,
      environment: environment as 'QA' | 'PROD' | undefined,
    })

    logger.info('AngelPay user account credentials updated', {
      event: 'angelpay.account.credentials_updated',
      accountId: id,
      changes: {
        emailChanged: email !== undefined,
        environmentChanged: environment !== undefined,
      },
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
    // Reactivation does not require a reason (it's a recovery operation,
    // not a punitive state change). Other transitions still do.
    if (status !== 'ACTIVE' && (!reason || typeof reason !== 'string')) {
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
      case 'ACTIVE':
        // Reactivation: only valid from DELETED (service enforces this).
        account = await reactivateAngelPayUserAccount(id, changedBy)
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
export async function approveAngelPayDiscoveredMerchantController(req: Request, res: Response, next: NextFunction) {
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
      if (!Array.isArray(terminalIds) || !terminalIds.every(t => typeof t === 'string')) {
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
 * Default (no query params) — soft delete. Sets status=DELETED, preserves
 * the row for audit / FK references / backfill.
 *
 * Query params (opt-in):
 *   - `?hard=true`           → physically remove the row from the DB.
 *                              409 Conflict if any merchant is still bound
 *                              (operator must detach first OR pass cascade).
 *   - `?hard=true&cascade=true` → detach every bound merchant
 *                              (angelpayUserAccountId=null) inside the same
 *                              transaction, then delete the row.
 *
 * Soft delete is the safe default. Hard delete is reserved for cleanup
 * (test data, GDPR, decommission).
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
    const hard = req.query.hard === 'true' || req.query.hard === '1'
    const cascade = req.query.cascade === 'true' || req.query.cascade === '1'

    if (hard) {
      const result = await hardDeleteAngelPayUserAccount(id, changedBy, { cascadeMerchants: cascade })
      // No `account` to return — the row is gone. Surface the cleanup result.
      res.json({
        success: true,
        data: {
          deleted: true,
          mode: 'hard',
          accountId: result.deletedAccountId,
          detachedMerchantIds: result.detachedMerchantIds,
        },
      })
      return
    }

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

/**
 * GET /api/v1/superadmin/venues/:venueId/angelpay-accounts (plural)
 *
 * Multi-account-aware lookup. Returns the FULL list (array) of AngelPay user
 * accounts registered for the venue, oldest-first. Always returns an array —
 * empty when the venue has not been provisioned yet.
 *
 * Use this endpoint in the dashboard's AngelPay onboarding wizard so the
 * operator can see/manage every account. The legacy singular
 * `getAngelPayUserAccountForVenue` is preserved for backward-compat callers
 * that still assume "one account per venue".
 */
export async function listAngelPayUserAccountsForVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    if (!venueId) {
      throw new BadRequestError('venueId is required')
    }

    const accounts = await getAngelPayUserAccountsByVenueId(venueId)

    res.json({
      success: true,
      data: accounts.map(sanitize),
    })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /api/v1/superadmin/venues/:venueId/angelpay-fetch-merchants
 * Body: { terminalId?: string, angelpayUserAccountId?: string }
 *
 * Dispatches a `FETCH_ANGELPAY_MERCHANTS` socket command to the venue's
 * NEXGO terminal (or the explicitly-selected one). The TPV handler will:
 *   1. Optionally call `switchAccount(angelpayUserAccountId)` first
 *   2. Call `ensureAuthenticated()` which already reports + refreshes
 *      discovered merchants to backend
 *
 * Returns 202 Accepted with the queued command id. The dashboard then polls
 * the discovered-merchants query for up to 30s to surface fresh results
 * without bothering with full real-time wiring.
 *
 * 404 if no ACTIVE NEXGO terminal exists in the venue.
 */
export async function dispatchFetchAngelPayMerchantsForVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { terminalId, angelpayUserAccountId, mode } = (req.body ?? {}) as {
      terminalId?: string
      angelpayUserAccountId?: string
      /**
       * Discovery mode for the report endpoint that fires asynchronously when
       * the TPV reports back:
       *   - 'AUTO_ONBOARD' (default, legacy): zero-touch — TPV report creates
       *     MerchantAccount rows and assigns them to free VenuePaymentConfig
       *     slots. Used by older flows where no wizard owns the merchant.
       *   - 'PREVIEW_ONLY': the AngelPay wizard owns merchant creation in
       *     step 9. The report only populates the wizard's "merchants
       *     descubiertos" picker — no silent creation.
       *
       * Persisted via `AngelPayUserAccount.pendingDiscoveryMode` so the
       * report endpoint (which has no way to look back at this dispatch
       * directly) can route correctly when the TPV replies.
       */
      mode?: 'AUTO_ONBOARD' | 'PREVIEW_ONLY'
    }

    if (!venueId) {
      throw new BadRequestError('venueId is required')
    }

    // Resolve target terminal: explicit pick wins, otherwise first active NEXGO.
    let terminal
    if (terminalId) {
      terminal = await prisma.terminal.findUnique({
        where: { id: terminalId },
        select: { id: true, serialNumber: true, venueId: true, brand: true, status: true },
      })
      if (!terminal) {
        throw new NotFoundError(`Terminal ${terminalId} not found`)
      }
      if (terminal.venueId !== venueId) {
        throw new BadRequestError(`Terminal ${terminalId} does not belong to venue ${venueId}`)
      }
      if (terminal.brand !== 'NEXGO') {
        throw new BadRequestError(`Terminal ${terminalId} is not a NEXGO terminal (brand=${terminal.brand})`)
      }
    } else {
      // Smart terminal picker (2026-05-21): pick the NEXGO terminal MOST
      // LIKELY to succeed at AngelPay auth, in this order of preference:
      //   1. Terminal whose `assignedMerchantIds` contains a MerchantAccount
      //      linked to the requested `angelpayUserAccountId` — that's the
      //      explicit wiring intent set by the operator from dashboard.
      //   2. Otherwise: most recently heartbeating terminal (`lastSeen` desc).
      //   3. Tie-breaker: oldest `createdAt` (preserves legacy behavior when
      //      no heartbeats are available).
      // Without this, the previous `orderBy createdAt asc` always picked the
      // first-registered NEXGO regardless of whether it was online or had the
      // right merchant slot — observed 2026-05-21 on venue Amaena where the
      // dispatcher kept sending to the productive terminal even though the
      // debug SPRD was online + had the AngelPay placeholder assigned.
      type PickedTerminal = {
        id: string
        serialNumber: string | null
        venueId: string
        brand: string | null
        status: TerminalStatus
      }
      let preferredTerminal: PickedTerminal | null = null
      if (angelpayUserAccountId) {
        const accountMerchants = await prisma.merchantAccount.findMany({
          where: { angelpayUserAccountId, active: true },
          select: { id: true },
        })
        if (accountMerchants.length > 0) {
          const accountMerchantIds = accountMerchants.map(m => m.id)
          // Postgres array overlap operator: find terminals whose
          // assignedMerchantIds contains ANY of the account's merchants.
          const candidates = await prisma.terminal.findMany({
            where: {
              venueId,
              brand: 'NEXGO',
              status: 'ACTIVE',
              assignedMerchantIds: { hasSome: accountMerchantIds },
            },
            orderBy: [{ lastHeartbeat: 'desc' }, { createdAt: 'asc' }],
            select: { id: true, serialNumber: true, venueId: true, brand: true, status: true },
          })
          if (candidates.length > 0) {
            preferredTerminal = candidates[0]
          }
        }
      }
      if (!preferredTerminal) {
        // Fallback: any ACTIVE NEXGO, prefer most recent heartbeat.
        preferredTerminal = await prisma.terminal.findFirst({
          where: { venueId, brand: 'NEXGO', status: 'ACTIVE' },
          orderBy: [{ lastHeartbeat: 'desc' }, { createdAt: 'asc' }],
          select: { id: true, serialNumber: true, venueId: true, brand: true, status: true },
        })
      }
      terminal = preferredTerminal
      if (!terminal) {
        throw new NotFoundError(
          `No ACTIVE NEXGO terminal found in venue ${venueId}. ` +
            `Register a NEXGO terminal (and verify it's online) before dispatching FETCH_ANGELPAY_MERCHANTS.`,
        )
      }
    }

    const payload: Record<string, any> = {}
    if (angelpayUserAccountId) {
      payload.angelpayUserAccountId = angelpayUserAccountId
    }

    // Persist the discovery mode flag on the AngelPayUserAccount BEFORE
    // dispatching the TPV command. The TPV's report endpoint reads + clears
    // this flag and routes the upsert accordingly:
    //   - PREVIEW_ONLY (wizard flow) → skip zero-touch auto-create.
    //   - null / AUTO_ONBOARD (legacy) → keep historical behavior.
    // Stored per AngelPay account so multi-account venues don't cross-pollute.
    // Only flips when an explicit account is targeted — otherwise the legacy
    // unbound discovery (smart picker) keeps its auto-onboard semantics.
    if (angelpayUserAccountId && mode) {
      await prisma.angelPayUserAccount.update({
        where: { id: angelpayUserAccountId },
        data: { pendingDiscoveryMode: mode },
      })
    }

    const result = await tpvCommandQueueService.queueCommand({
      terminalId: terminal.id,
      venueId,
      commandType: 'FETCH_ANGELPAY_MERCHANTS',
      payload: Object.keys(payload).length > 0 ? payload : undefined,
      requestedBy: (req as any).user?.uid ?? 'unknown',
      requestedByName: (req as any).user?.email ?? null,
    })

    logger.info('FETCH_ANGELPAY_MERCHANTS dispatched', {
      event: 'angelpay.fetch_merchants_dispatched',
      venueId,
      terminalId: terminal.id,
      terminalSerial: terminal.serialNumber,
      angelpayUserAccountId,
      commandId: result.commandId,
      terminalOnline: result.terminalOnline,
      dispatchedBy: (req as any).user?.uid,
    })

    res.status(202).json({
      success: true,
      data: {
        commandId: result.commandId,
        correlationId: result.correlationId,
        terminalId: terminal.id,
        terminalSerialNumber: terminal.serialNumber,
        terminalOnline: result.terminalOnline,
        queued: result.queued,
      },
    })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /superadmin/venues/:venueId/angelpay-reserve-slot
 *
 * Reserve a VenuePaymentConfig slot for an AngelPay merchant BEFORE the real
 * Merchant ID / Affiliation are known. Admin doesn't have those numbers — they
 * come from AngelPay's portal or are exposed by the SDK after TPV authentication.
 * The placeholder gets upgraded with real data when `reportDiscoveredMerchants`
 * fires from the TPV.
 *
 * Body: { slot?: 'PRIMARY' | 'SECONDARY' | 'TERTIARY', displayName?: string }
 *   - slot: if omitted, auto-picks the first empty slot
 *   - displayName: optional friendly label visible until TPV upgrades it
 *
 * 409 Conflict if the chosen slot is already occupied.
 */
export async function reserveAngelPaySlotController(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { slot, displayName, angelpayUserAccountId } = (req.body ?? {}) as {
      slot?: VenuePaymentSlot
      displayName?: string
      angelpayUserAccountId?: string
    }

    if (!venueId) {
      throw new BadRequestError('venueId is required')
    }

    if (slot && slot !== 'PRIMARY' && slot !== 'SECONDARY' && slot !== 'TERTIARY') {
      throw new BadRequestError(`slot must be one of PRIMARY|SECONDARY|TERTIARY (got "${String(slot)}")`)
    }

    if (displayName !== undefined && typeof displayName !== 'string') {
      throw new BadRequestError('displayName must be a string when provided')
    }

    if (angelpayUserAccountId !== undefined && typeof angelpayUserAccountId !== 'string') {
      throw new BadRequestError('angelpayUserAccountId must be a string when provided')
    }

    const result = await reserveAngelPaySlot({
      venueId,
      slot,
      displayName,
      angelpayUserAccountId,
    })

    logger.info('AngelPay slot reserved via API', {
      event: 'angelpay.slot_reserved_api',
      venueId,
      slot: result.slot,
      merchantAccountId: result.merchantAccountId,
      angelpayUserAccountId,
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
