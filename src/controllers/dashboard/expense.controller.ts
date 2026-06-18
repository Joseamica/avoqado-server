import { NextFunction, Request, Response } from 'express'

import { createExpense, listExpenses, type CreateExpenseInput, type ListExpensesFilters } from '../../services/fiscal/expense.service'
import { generateExpensePoliciesForVenue } from '../../services/fiscal/expensePosting.service'
import { getDiot } from '../../services/fiscal/diot.service'
import { currentPeriod } from '../../services/fiscal/trialBalance.service'

/**
 * Controller — Buzón de CFDIs / Gastos (Capa B, Pilar #2). Captura de gastos recibidos, listado,
 * posteo de pólizas de gasto y DIOT. Gated en la ruta por `checkFeatureAccess('CFDI')` (PREMIUM):
 * lectura = `accounting:read`; captura/posteo = `accounting:manage`.
 */

/** POST /accounting/expenses — registra un gasto / CFDI recibido. */
export async function createExpenseController(
  req: Request<{ venueId: string }, {}, CreateExpenseInput>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const staffId = (req as any).authContext?.userId ?? null
    const dto = await createExpense(req.params.venueId, { ...req.body, venueId: req.body.venueId ?? req.params.venueId }, { staffId })
    res.status(201).json(dto)
  } catch (error) {
    next(error)
  }
}

/** GET /accounting/expenses?period=&paymentStatus=&proveedorRfc= — lista los gastos del contribuyente. */
export async function listExpensesController(
  req: Request<{ venueId: string }, {}, {}, ListExpensesFilters & { period?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { period, paymentStatus, proveedorRfc, includeCancelled, limit } = req.query
    res.status(200).json(
      await listExpenses(req.params.venueId, {
        period,
        paymentStatus,
        proveedorRfc,
        includeCancelled: includeCancelled !== undefined ? String(includeCancelled) === 'true' : undefined,
        limit: limit !== undefined ? Number(limit) : undefined,
      }),
    )
  } catch (error) {
    next(error)
  }
}

/** POST /accounting/expenses/generate-policies?period=YYYY-MM — postea las pólizas de gasto del periodo. */
export async function generateExpensePoliciesController(
  req: Request<{ venueId: string }, {}, {}, { period?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const period = req.query.period || currentPeriod()
    const staffId = (req as any).authContext?.userId ?? null
    res.status(200).json(await generateExpensePoliciesForVenue(venueId, { period, actorStaffId: staffId }))
  } catch (error) {
    next(error)
  }
}

/** GET /accounting/diot?period=YYYY-MM — DIOT (IVA pagado a proveedores por tercero y tasa). */
export async function getDiotController(
  req: Request<{ venueId: string }, {}, {}, { period?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const period = req.query.period || currentPeriod()
    res.status(200).json(await getDiot(req.params.venueId, period))
  } catch (error) {
    next(error)
  }
}
