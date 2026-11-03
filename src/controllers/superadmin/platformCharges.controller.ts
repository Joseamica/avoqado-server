import type { PlatformCharge } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'
import { handleBillingError } from '@/controllers/superadmin/platformBilling.controller'
import * as chargesService from '@/services/superadmin/platform-charges/charges.service'
import * as occurrencesService from '@/services/superadmin/platform-charges/occurrences.service'
import { dbToCalendarDay } from '@/services/superadmin/platform-charges/schedule'

/**
 * «Por cobrar»: cobros recurrentes de Avoqado a un cliente, con recordatorio y factura (spec 2026-11-02-por-cobrar-superadmin §5).
 * Controladores delgados: sacan lo del `req`, llaman al servicio y responden `{ success, data, meta? }`. Los errores de negocio
 * (`PlatformBillingError`, y los `AppError` de 400/404/409) salen por `handleBillingError`, que respeta el código de cada uno.
 */

const actorOf = (req: Request): string => (req as any).authContext.userId

/**
 * El cobro como lo recibe SUPERADMIN: `anchorDate` es un día de calendario en TEXTO `YYYY-MM-DD`, nunca un `Date` (un instante a
 * medianoche UTC se pintaría un día antes en CDMX). Lo mismo que `dueDate` en las ocurrencias.
 */
export function chargeView(row: PlatformCharge) {
  return { ...row, anchorDate: dbToCalendarDay(row.anchorDate) }
}

// ── Pantalla «Por cobrar» ───────────────────────────────────────────────────────────────────────────────────────────────────

/** GET /api/v1/superadmin/platform-charges/summary */
export async function getSummary(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await occurrencesService.summarizeOccurrences() })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** GET /api/v1/superadmin/platform-charges/occurrences?view=open|paid|skipped&q=&page=&pageSize= */
export async function listOccurrences(req: Request, res: Response, next: NextFunction) {
  try {
    const { view, q, page, pageSize } = req.query as occurrencesService.ListOccurrencesFilters
    const result = await occurrencesService.listOccurrences({ view, q, page, pageSize })
    res.json({ success: true, data: result.rows, meta: { total: result.total, page: result.page, pageSize: result.pageSize } })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** GET /api/v1/superadmin/platform-charges/occurrences/:id/pay-preview */
export async function getPayPreview(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await occurrencesService.payPreview(req.params.id) })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** POST /api/v1/superadmin/platform-charges/occurrences/:id/pay — «Ya me pagó»; con `invoice: true` también timbra. */
export async function payOccurrence(req: Request, res: Response, next: NextFunction) {
  try {
    const { invoice } = req.body as { invoice: boolean }
    res.json({ success: true, data: await occurrencesService.payOccurrence(req.params.id, { invoice }, actorOf(req)) })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** POST /api/v1/superadmin/platform-charges/occurrences/:id/skip */
export async function skipOccurrence(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await occurrencesService.skipOccurrence(req.params.id, actorOf(req)) })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** POST /api/v1/superadmin/platform-charges/occurrences/:id/reopen — «Deshacer». */
export async function reopenOccurrence(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await occurrencesService.reopenOccurrence(req.params.id, actorOf(req)) })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** POST /api/v1/superadmin/platform-charges/occurrences/:id/invoice — facturar, reintentar o consultar el estado. */
export async function invoiceOccurrence(req: Request, res: Response, next: NextFunction) {
  try {
    const { billingTaxProfileId, conceptKeys } = req.body as {
      billingTaxProfileId?: string
      conceptKeys?: { satProductKey: string; satUnitKey: string }[]
    }
    res.json({
      success: true,
      data: await occurrencesService.invoiceOccurrenceView(req.params.id, { billingTaxProfileId, conceptKeys, actorId: actorOf(req) }),
    })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

// ── Cobros recurrentes ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** GET /api/v1/superadmin/platform-charges?status=active|paused&q=&page=&pageSize= */
export async function listCharges(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, q, page, pageSize } = req.query as chargesService.ListChargesFilters
    const result = await chargesService.listCharges({ status, q, page, pageSize })
    res.json({
      success: true,
      data: result.rows.map(chargeView),
      meta: { total: result.total, page: result.page, pageSize: result.pageSize },
    })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** POST /api/v1/superadmin/platform-charges — da de alta el cobro y genera sus ocurrencias en el acto. */
export async function createCharge(req: Request, res: Response, next: NextFunction) {
  try {
    const charge = await chargesService.createCharge(req.body, actorOf(req))
    res.status(201).json({ success: true, data: chargeView(charge) })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** PATCH /api/v1/superadmin/platform-charges/:id — edita; sólo cambia lo futuro. */
export async function updateCharge(req: Request, res: Response, next: NextFunction) {
  try {
    const charge = await chargesService.updateCharge(req.params.id, req.body, actorOf(req))
    res.json({ success: true, data: chargeView(charge) })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** POST /api/v1/superadmin/platform-charges/:id/pause — `{ skipOverdue }`: qué hacer con lo vencido y lo de hoy. */
export async function pauseCharge(req: Request, res: Response, next: NextFunction) {
  try {
    const { skipOverdue } = req.body as { skipOverdue: boolean }
    const charge = await chargesService.pauseCharge(req.params.id, { skipOverdue }, actorOf(req))
    res.json({ success: true, data: chargeView(charge) })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}

/** POST /api/v1/superadmin/platform-charges/:id/resume */
export async function resumeCharge(req: Request, res: Response, next: NextFunction) {
  try {
    const charge = await chargesService.resumeCharge(req.params.id, actorOf(req))
    res.json({ success: true, data: chargeView(charge) })
  } catch (error) {
    handleBillingError(error, res, next)
  }
}
