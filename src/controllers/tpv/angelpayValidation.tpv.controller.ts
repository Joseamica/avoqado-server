/**
 * AngelPay validation report endpoints (Task 14 — closes backend Phase 1).
 *
 * Two endpoints used by the TPV after performing the AngelPay SDK validation
 * handshake at app startup / merchant switch:
 *
 *   POST /api/v1/tpv/angelpay/report-validation
 *     - state=AUTHENTICATED  → markAngelPayUserAccountValidated(id, externalUserId)
 *     - state=AUTH_ERROR     → recordAngelPayUserAccountError(id, error)
 *     - state=CONFIG_MISMATCH → recordAngelPayUserAccountError(id, "CONFIG_MISMATCH: ...")
 *
 *   POST /api/v1/tpv/angelpay/report-merchant-switch
 *     - Audit-only structured log (no DB writes for now). Spec §8.2 calls for
 *       metrics; we'll wire those in a polish pass once observability tooling
 *       is selected. Returns 204.
 *
 * Spec ref: §4.6 (new endpoints), §8.2 (observability).
 */

import { NextFunction, Request, Response } from 'express'

import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { markAngelPayUserAccountValidated, recordAngelPayUserAccountError } from '../../services/superadmin/angelpayUserAccount.service'
import { upsertDiscoveredAngelPayMerchants } from '../../services/superadmin/merchantAccount.service'

export type AngelPayValidationState = 'AUTHENTICATED' | 'AUTH_ERROR' | 'CONFIG_MISMATCH'

export interface ReportValidationBody {
  accountId: string
  state: AngelPayValidationState
  externalUserId?: number
  error?: string
  missingInAvoqado?: number[]
  missingInSdk?: number[]
}

export async function reportAngelPayValidation(req: Request, res: Response, next: NextFunction) {
  try {
    const { accountId, state, externalUserId, error, missingInAvoqado, missingInSdk } = (req.body ?? {}) as ReportValidationBody

    if (!accountId || typeof accountId !== 'string') {
      throw new BadRequestError('accountId is required')
    }

    const terminalSerial = req.authContext?.terminalSerialNumber

    switch (state) {
      case 'AUTHENTICATED': {
        if (typeof externalUserId !== 'number' || !Number.isFinite(externalUserId)) {
          throw new BadRequestError('externalUserId (number) required for AUTHENTICATED state')
        }
        await markAngelPayUserAccountValidated(accountId, externalUserId)
        logger.info('AngelPay validation OK', {
          event: 'angelpay.validation.authenticated',
          accountId,
          externalUserId,
          terminalSerial,
        })
        break
      }
      case 'AUTH_ERROR': {
        await recordAngelPayUserAccountError(accountId, error ?? 'Unknown auth error')
        logger.warn('AngelPay validation failed', {
          event: 'angelpay.validation.error',
          accountId,
          error,
          terminalSerial,
        })
        break
      }
      case 'CONFIG_MISMATCH': {
        const missingAv = Array.isArray(missingInAvoqado) ? missingInAvoqado : []
        const missingSdk = Array.isArray(missingInSdk) ? missingInSdk : []
        await recordAngelPayUserAccountError(
          accountId,
          `CONFIG_MISMATCH: missingInAvoqado=${JSON.stringify(missingAv)}, missingInSdk=${JSON.stringify(missingSdk)}`,
        )
        logger.warn('AngelPay config mismatch reported', {
          event: 'angelpay.validation.config_mismatch',
          accountId,
          missingInAvoqado: missingAv,
          missingInSdk: missingSdk,
          terminalSerial,
        })
        break
      }
      default:
        throw new BadRequestError(`Unknown state: ${String(state)}`)
    }

    return res.status(204).end()
  } catch (err) {
    next(err)
  }
}

export interface ReportMerchantSwitchBody {
  fromMerchantId: string | number | null
  toMerchantId: string | number
  durationMs: number
}

export async function reportAngelPayMerchantSwitch(req: Request, res: Response, next: NextFunction) {
  try {
    const { fromMerchantId, toMerchantId, durationMs } = (req.body ?? {}) as ReportMerchantSwitchBody

    if (toMerchantId === undefined || toMerchantId === null || toMerchantId === '') {
      throw new BadRequestError('toMerchantId is required')
    }

    logger.info('AngelPay merchant switch reported', {
      event: 'angelpay.merchant_switch',
      fromMerchantId: fromMerchantId ?? null,
      toMerchantId,
      durationMs,
      terminalSerial: req.authContext?.terminalSerialNumber,
      venueId: req.authContext?.venueId,
    })

    return res.status(204).end()
  } catch (err) {
    next(err)
  }
}

// ============================================================
// Option B workaround: report merchants auto-discovered by TPV
// ============================================================

export interface ReportDiscoveredMerchantsBody {
  accountId: string
  merchants: Array<{
    angelpayId: number
    name: string
    affiliationNumber: string
    isActive: boolean
  }>
}

/**
 * TPV calls this immediately after a successful AngelPay SDK authentication
 * (and after every successful merchant switch) with the full list returned by
 * `AngelPaySDK.getUserMerchants()`. Backend idempotently upserts MerchantAccount
 * rows, marking new ones as `active=false` for admin approval.
 *
 * Fire-and-forget on the TPV side — non-blocking.
 */
export async function reportDiscoveredMerchants(req: Request, res: Response, next: NextFunction) {
  try {
    const { accountId, merchants } = (req.body ?? {}) as ReportDiscoveredMerchantsBody

    if (!accountId || typeof accountId !== 'string') {
      throw new BadRequestError('accountId is required')
    }
    if (!Array.isArray(merchants) || merchants.length === 0) {
      throw new BadRequestError('merchants array (non-empty) is required')
    }

    const account = await prisma.angelPayUserAccount.findUnique({ where: { id: accountId } })
    if (!account) {
      throw new NotFoundError(`AngelPayUserAccount ${accountId} not found`)
    }

    // Consume the discovery mode flag set by the dispatch endpoint right before
    // it queued the TPV command. PREVIEW_ONLY means the wizard owns merchant
    // creation in its step 9; if we let the legacy auto-onboard run here it
    // races the wizard and steals the PRIMARY slot, surfacing as a 409 nine
    // steps later. We clear the flag immediately so any subsequent fire-and-
    // forget TPV report (e.g., terminal reboot triggering ensureAuthenticated)
    // falls back to the historical auto-onboard behavior.
    const skipAutoOnboarding = account.pendingDiscoveryMode === 'PREVIEW_ONLY'
    if (account.pendingDiscoveryMode != null) {
      await prisma.angelPayUserAccount.update({
        where: { id: accountId },
        data: { pendingDiscoveryMode: null },
      })
    }

    const result = await upsertDiscoveredAngelPayMerchants({
      venueId: account.venueId,
      merchants,
      // Multi-account routing (2026-05-19): pass the reporting account's ID so
      // the upsert can (a) link newly-discovered merchants to the correct
      // AngelPay login, (b) prefer THIS account's reserved placeholder over
      // another account's when upgrading, and (c) detect the shared-merchant
      // case (account B reports merchant X already created by account A) and
      // repoint B's reserved slot to the existing row instead of leaving B's
      // placeholder AWAITING_ forever.
      angelpayUserAccountId: accountId,
      skipAutoOnboarding,
    })

    logger.info('AngelPay auto-discovered merchants reported by TPV', {
      event: 'angelpay.discovered_merchants_reported',
      accountId,
      venueId: account.venueId,
      terminalSerial: req.authContext?.terminalSerialNumber,
      mode: skipAutoOnboarding ? 'PREVIEW_ONLY' : 'AUTO_ONBOARD',
      ...result,
    })

    return res.status(204).end()
  } catch (err) {
    next(err)
  }
}
