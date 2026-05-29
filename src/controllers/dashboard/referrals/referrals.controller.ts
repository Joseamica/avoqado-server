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
    const config = await prisma.referralProgramConfig.findUnique({
      where: { venueId: req.params.venueId },
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
    if (e && typeof e.message === 'string' && ['PROGRAM_INACTIVE', 'CODE_NOT_FOUND', 'SELF_REFERRAL', 'EXISTING_CUSTOMER'].includes(e.message)) {
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
