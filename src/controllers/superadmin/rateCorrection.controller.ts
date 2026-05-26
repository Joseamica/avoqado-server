import { Request, Response, NextFunction } from 'express'
import { AccountType } from '@prisma/client'
import { rateCorrectionBodySchema } from '@/schemas/superadmin/rateCorrection.schema'
import { previewRateCorrection, PreviewArgs } from '@/services/superadmin/rateCorrection/rateCorrectionPreview'
import { applyRateCorrection } from '@/services/superadmin/rateCorrection/rateCorrectionApply'
import { reverseRateCorrection } from '@/services/superadmin/rateCorrection/rateCorrectionReverse'
import { listRateCorrections } from '@/services/superadmin/rateCorrection/rateCorrectionList'

function parseArgs(req: Request): PreviewArgs {
  const body = rateCorrectionBodySchema.parse(req.body)
  return {
    venueId: req.params.venueId,
    accountType: body.accountType as AccountType,
    newVenueRates: body.newVenueRates ?? null,
    newProviderRates: body.newProviderRates ?? null,
    dateFrom: body.dateFrom ? new Date(body.dateFrom) : undefined,
    dateTo: body.dateTo ? new Date(body.dateTo) : undefined,
    missingCostMode: body.missingCostMode,
  }
}

function getStaffId(req: Request): string | null {
  return (req as any).authContext?.userId ?? null
}

// All superadmin endpoints wrap the body in `{ data: ... }` (the frontend `api`
// client reads `response.data.data`). Keep that envelope for consistency.
export async function preview(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: await previewRateCorrection(parseArgs(req)) })
  } catch (e) {
    next(e)
  }
}

export async function apply(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: await applyRateCorrection(parseArgs(req), { staffId: getStaffId(req) }) })
  } catch (e) {
    next(e)
  }
}

export async function reverse(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: await reverseRateCorrection(req.params.batchId, { staffId: getStaffId(req) }) })
  } catch (e) {
    next(e)
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: await listRateCorrections({ venueId: req.query.venueId as string | undefined }) })
  } catch (e) {
    next(e)
  }
}
