/**
 * Cash Out (PlayTelecom) Dashboard Controller — thin HTTP layer.
 * Reads authContext, delegates to the (module-gated) config service, maps errors.
 * Amounts are PESOS (1:1). Gating + validation live in the service.
 */
import { Request, Response, NextFunction } from 'express'
import * as configService from '@/services/dashboard/cash-out/cash-out.config.service'
import { CashOutValidationError } from '@/services/dashboard/cash-out/cash-out.config.service'
import * as ledger from '@/services/dashboard/cash-out/cash-out.ledger.service'
import * as withdrawalService from '@/services/dashboard/cash-out/cash-out.withdrawal.service'
import * as reportService from '@/services/dashboard/cash-out/cash-out.report.service'
import * as orgService from '@/services/dashboard/cash-out/cash-out.org.service'

/** GET /dashboard/cash-out/venues/:venueId/commission-rates */
export async function getCommissionRates(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const rates = await configService.listCommissionRates(venueId)
    res.json({ data: rates })
  } catch (error) {
    next(error)
  }
}

/** PUT /dashboard/cash-out/venues/:venueId/commission-rates */
export async function putCommissionRates(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const auth = (req as any).authContext
    const rates = await configService.replaceCommissionRates(venueId, req.body.rates, { staffId: auth?.userId, orgId: auth?.orgId })
    res.json({ data: rates })
  } catch (error) {
    if (error instanceof CashOutValidationError) {
      return res.status(400).json({ success: false, message: error.message, errors: error.errors })
    }
    next(error)
  }
}

/** GET /dashboard/cash-out/venues/:venueId/active-days?from&to */
export async function getActiveDays(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { from, to } = req.query as { from?: string; to?: string }
    const days = await configService.listActiveDays(venueId, from, to)
    res.json({ data: days })
  } catch (error) {
    next(error)
  }
}

/** PUT /dashboard/cash-out/venues/:venueId/active-days */
export async function putActiveDays(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const auth = (req as any).authContext
    const days = await configService.setActiveDays(venueId, req.body.days, { staffId: auth?.userId, orgId: auth?.orgId })
    res.json({ data: days })
  } catch (error) {
    next(error)
  }
}

/** GET /dashboard/cash-out/venues/:venueId/promoters/:staffId/saldo — materialize-on-read for real-time saldo */
export async function getSaldo(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, staffId } = req.params
    await ledger.materializeEntries(venueId)
    const saldo = await ledger.getSaldo(venueId, staffId)
    res.json({ data: { venueId, staffId, saldo: saldo.toString() } }) // pesos
  } catch (error) {
    next(error)
  }
}

/** POST /dashboard/cash-out/venues/:venueId/promoters/:staffId/withdraw (Retirar — back-office in v1) */
export async function postWithdraw(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, staffId } = req.params
    const auth = (req as any).authContext
    await ledger.materializeEntries(venueId) // ensure saldo is current before withdrawing
    const result = await withdrawalService.createWithdrawal(venueId, staffId, { staffId: auth?.userId })
    res.status(201).json({ data: { ...result, grossAmount: result.grossAmount.toString(), netAmount: result.netAmount.toString() } })
  } catch (error) {
    next(error)
  }
}

/** GET /dashboard/cash-out/venues/:venueId/withdrawals */
export async function getWithdrawals(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { businessDate, status } = req.query as { businessDate?: string; status?: any }
    const items = await withdrawalService.listWithdrawals(venueId, { businessDate, status })
    res.json({ data: items })
  } catch (error) {
    next(error)
  }
}

/** POST /dashboard/cash-out/venues/:venueId/report — corte → Finanzas dispersion (marks REPORTED) */
export async function postReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const auth = (req as any).authContext
    const rep = await reportService.generateDispersionReport(venueId, { businessDate: req.body?.businessDate }, { staffId: auth?.userId })
    res.json({ data: rep })
  } catch (error) {
    next(error)
  }
}

// ==========================================
// ORG-SCOPED — uniform config + aggregation across ALL venues of an organization
// ==========================================

/** GET /dashboard/organizations/:orgId/cash-out/commission-rates */
export async function getOrgCommissionRates(req: Request, res: Response, next: NextFunction) {
  try {
    const rates = await configService.listCommissionRatesForOrg(req.params.orgId)
    res.json({ data: rates })
  } catch (error) {
    next(error)
  }
}

/** PUT /dashboard/organizations/:orgId/cash-out/commission-rates */
export async function putOrgCommissionRates(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = (req as any).authContext
    const rates = await configService.replaceCommissionRatesForOrg(req.params.orgId, req.body.rates, { staffId: auth?.userId })
    res.json({ data: rates })
  } catch (error) {
    if (error instanceof CashOutValidationError) {
      return res.status(400).json({ success: false, message: error.message, errors: error.errors })
    }
    next(error)
  }
}

/** GET /dashboard/organizations/:orgId/cash-out/active-days?from&to */
export async function getOrgActiveDays(req: Request, res: Response, next: NextFunction) {
  try {
    const { from, to } = req.query as { from?: string; to?: string }
    const days = await configService.listActiveDaysForOrg(req.params.orgId, from, to)
    res.json({ data: days })
  } catch (error) {
    next(error)
  }
}

/** PUT /dashboard/organizations/:orgId/cash-out/active-days */
export async function putOrgActiveDays(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = (req as any).authContext
    const days = await configService.setActiveDaysForOrg(req.params.orgId, req.body.days, { staffId: auth?.userId })
    res.json({ data: days })
  } catch (error) {
    next(error)
  }
}

/** GET /dashboard/organizations/:orgId/cash-out/withdrawals */
export async function getOrgWithdrawals(req: Request, res: Response, next: NextFunction) {
  try {
    const { businessDate, status } = req.query as { businessDate?: string; status?: any }
    const items = await orgService.listWithdrawalsForOrg(req.params.orgId, { businessDate, status })
    res.json({ data: items })
  } catch (error) {
    next(error)
  }
}

/** POST /dashboard/organizations/:orgId/cash-out/report — org-wide corte → Finanzas dispersion */
export async function postOrgReport(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = (req as any).authContext
    const rep = await orgService.generateOrgDispersionReport(
      req.params.orgId,
      { businessDate: req.body?.businessDate },
      { staffId: auth?.userId },
    )
    res.json({ data: rep })
  } catch (error) {
    next(error)
  }
}
