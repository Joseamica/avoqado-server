import { Request, Response, NextFunction } from 'express'
import * as program from '../../../services/referrals/referralProgram.service'
import * as capture from '../../../services/referrals/referralCapture.service'
import * as reads from '../../../services/referrals/referralReads.service'
import prisma from '../../../utils/prismaClient'
import { ReferralStatus, ReferralTier } from '@prisma/client'

// ==========================================
// CONFIG
// ==========================================

export async function getConfig(req: Request, res: Response, next: NextFunction) {
  try {
    // `tierRewards` (ACTIVE rows only) is the authoritative per-tier reward
    // config (Task 3). The flat `tier{N}RewardPercent` columns above are
    // DEPRECATED — kept in the response (never remove API response fields)
    // for callers not yet migrated, but no business logic reads them anymore.
    const config = await prisma.referralProgramConfig.findUnique({
      where: { venueId: req.params.venueId },
      include: {
        tierRewards: { where: { active: true }, orderBy: { tierLevel: 'asc' } },
      },
    })
    res.json(config ?? { active: false })
  } catch (e) {
    next(e)
  }
}

export async function activate(req: Request, res: Response, next: NextFunction) {
  try {
    await program.activateReferralProgram({ venueId: req.params.venueId, ...req.body })
    res.status(201).json({ ok: true })
  } catch (e) {
    next(e)
  }
}

export async function updateConfig(req: Request, res: Response, next: NextFunction) {
  try {
    await program.updateReferralConfig({ venueId: req.params.venueId, patch: req.body })
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
}

export async function deactivate(req: Request, res: Response, next: NextFunction) {
  try {
    await program.deactivateReferralProgram({ venueId: req.params.venueId, reason: req.body.reason })
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
}

// ==========================================
// CAPTURE
// ==========================================

export async function validate(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await capture.validateReferralCode({ venueId: req.params.venueId, ...req.body })
    res.json(result)
  } catch (e) {
    next(e)
  }
}

export async function captureCode(req: Request, res: Response, next: NextFunction) {
  try {
    const referral = await capture.captureReferral({ venueId: req.params.venueId, ...req.body })
    res.status(201).json(referral)
  } catch (e: any) {
    if (
      e &&
      typeof e.message === 'string' &&
      ['PROGRAM_INACTIVE', 'CODE_NOT_FOUND', 'SELF_REFERRAL', 'EXISTING_CUSTOMER'].includes(e.message)
    ) {
      return res.status(400).json({ valid: false, reason: e.message })
    }
    next(e)
  }
}

export async function forceOverride(req: Request, res: Response, next: NextFunction) {
  try {
    const managerStaffVenueId = (req as any).authContext?.staffVenueId
    const referral = await capture.forceOverrideReferral({
      venueId: req.params.venueId,
      managerStaffVenueId: managerStaffVenueId ?? 'unknown',
      ...req.body,
    })
    res.status(201).json(referral)
  } catch (e: any) {
    if (e && typeof e.message === 'string' && ['CODE_NOT_FOUND', 'SELF_REFERRAL'].includes(e.message)) {
      return res.status(400).json({ valid: false, reason: e.message })
    }
    next(e)
  }
}

export async function manualVoid(req: Request, res: Response, next: NextFunction) {
  try {
    const staffVenueId = (req as any).authContext?.staffVenueId
    const updated = await capture.manualVoidReferral({
      referralId: req.params.referralId,
      reason: req.body.reason,
      staffVenueId: staffVenueId ?? 'unknown',
    })
    res.json(updated)
  } catch (e: any) {
    if (e && typeof e.message === 'string') {
      if (e.message === 'REFERRAL_NOT_FOUND' || /not found/i.test(e.message)) {
        return res.status(404).json({ error: 'Referral not found' })
      }
      if (/already qualified/i.test(e.message)) {
        return res.status(409).json({ error: e.message })
      }
    }
    next(e)
  }
}

// ==========================================
// READS
// ==========================================

export async function listReferralsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, tier, dateFrom, dateTo, page, pageSize } = req.query
    const result = await reads.listReferrals({
      venueId: req.params.venueId,
      status: status as ReferralStatus | undefined,
      tier: tier as ReferralTier | undefined,
      dateFrom: dateFrom ? new Date(String(dateFrom)) : undefined,
      dateTo: dateTo ? new Date(String(dateTo)) : undefined,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    })
    res.json(result)
  } catch (e) {
    next(e)
  }
}

export async function getSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await reads.getReferralSummary(req.params.venueId)
    res.json(result)
  } catch (e) {
    next(e)
  }
}

export async function getHallOfFameHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 10
    const result = await reads.getHallOfFame(req.params.venueId, limit)
    res.json(result)
  } catch (e) {
    next(e)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/referrals/customers/:customerId/referrals
 *
 * Full referral history where the customer is the referrer. Powers the
 * per-customer ReferralCard on the Customers page.
 */
export async function getCustomerReferralsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await reads.listCustomerReferrals(req.params.venueId, req.params.customerId)
    res.json(result)
  } catch (e) {
    next(e)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/referrals/customers/:customerId/generate-code
 *
 * Retroactively issue a `referralCode` to a legacy customer (created before
 * the program activated, or missed by the activation backfill). Idempotent:
 * returns the existing code when one is already assigned.
 */
export async function generateCustomerCodeHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.customerId },
      select: {
        id: true,
        venueId: true,
        referralCode: true,
        firstName: true,
        lastName: true,
        venue: { select: { name: true } },
      },
    })
    if (!customer || customer.venueId !== req.params.venueId) {
      return res.status(404).json({ error: 'Customer not found' })
    }
    if (customer.referralCode) {
      return res.json({ referralCode: customer.referralCode })
    }
    const cfg = await prisma.referralProgramConfig.findUnique({
      where: { venueId: customer.venueId },
      select: { codePrefix: true },
    })
    if (!cfg) {
      return res.status(404).json({ error: 'No code or program' })
    }
    const { generateReferralCode } = await import('../../../services/referrals/referralCode.service')
    const customerName = [customer.firstName, customer.lastName].filter(Boolean).join(' ') || null
    const referralCode = await generateReferralCode({
      venueId: customer.venueId,
      venuePrefix: cfg.codePrefix || customer.venue.name,
      customerName,
    })
    await prisma.customer.update({ where: { id: customer.id }, data: { referralCode } })
    res.json({ referralCode })
  } catch (e) {
    next(e)
  }
}

// ==========================================
// WHATSAPP SHARE LINK (Phase 4 / Path B)
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/referrals/customers/:customerId/share-link
 *
 * Returns a wa.me deep link the customer (or a staff member sharing on
 * their behalf) can tap to open WhatsApp with the referral share message
 * pre-filled. Dynamic import keeps the WhatsApp helper out of the cold
 * path for read-heavy endpoints that don't need it.
 */
export async function getShareLink(req: Request, res: Response, next: NextFunction) {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.customerId },
      select: {
        referralCode: true,
        venueId: true,
        venue: { select: { name: true } },
      },
    })
    if (!customer || customer.venueId !== req.params.venueId || !customer.referralCode) {
      return res.status(404).json({ error: 'No code or program' })
    }
    const cfg = await prisma.referralProgramConfig.findUnique({
      where: { venueId: customer.venueId },
      select: { newCustomerDiscountPercent: true },
    })
    if (!cfg) {
      return res.status(404).json({ error: 'No code or program' })
    }
    const { buildWelcomeShareDeepLink, buildWelcomeShareMessage } = await import('../../../services/referrals/referralWhatsApp.service')
    const linkInput = {
      venueName: customer.venue.name,
      referralCode: customer.referralCode,
      newCustomerDiscountPercent: Number(cfg.newCustomerDiscountPercent),
    }
    res.json({
      whatsappShareUrl: buildWelcomeShareDeepLink(linkInput),
      message: buildWelcomeShareMessage(linkInput),
      code: customer.referralCode,
      venueName: customer.venue.name,
    })
  } catch (e) {
    next(e)
  }
}
