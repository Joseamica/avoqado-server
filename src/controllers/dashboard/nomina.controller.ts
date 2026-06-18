import { NextFunction, Request, Response } from 'express'
import { type PayrollPeriodicity } from '@prisma/client'

import {
  computePayrollPreview,
  createEmployee,
  listEmployees,
  runPayroll,
  type CreateEmployeeInput,
} from '../../services/fiscal/nomina.service'
import { currentPeriod } from '../../services/fiscal/trialBalance.service'

/**
 * Controller — Nómina (Capa B). Empleados + corrida de nómina. Gated en la ruta por
 * `checkFeatureAccess('CFDI')` (PREMIUM): lectura = `accounting:read`; alta/corrida = `accounting:manage`.
 */

const periodicidad = (v: unknown): PayrollPeriodicity => (v === 'SEMANAL' || v === 'QUINCENAL' ? v : 'MENSUAL')

/** POST /accounting/payroll/employees — da de alta un empleado. */
export async function createEmployeeController(
  req: Request<{ venueId: string }, {}, CreateEmployeeInput>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const staffId = (req as any).authContext?.userId ?? null
    res
      .status(201)
      .json(await createEmployee(req.params.venueId, { ...req.body, venueId: req.body.venueId ?? req.params.venueId }, { staffId }))
  } catch (error) {
    next(error)
  }
}

/** GET /accounting/payroll/employees?includeInactive= — lista los empleados del patrón. */
export async function listEmployeesController(
  req: Request<{ venueId: string }, {}, {}, { includeInactive?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.status(200).json(await listEmployees(req.params.venueId, { includeInactive: req.query.includeInactive === 'true' }))
  } catch (error) {
    next(error)
  }
}

/** GET /accounting/payroll/preview?period=&periodicidad= — preview del cálculo (no persiste). */
export async function payrollPreviewController(
  req: Request<{ venueId: string }, {}, {}, { period?: string; periodicidad?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res
      .status(200)
      .json(await computePayrollPreview(req.params.venueId, req.query.period || currentPeriod(), periodicidad(req.query.periodicidad)))
  } catch (error) {
    next(error)
  }
}

/** POST /accounting/payroll/run — corre la nómina del periodo (persiste + postea la póliza). */
export async function runPayrollController(
  req: Request<{ venueId: string }, {}, { period?: string; periodicidad?: string; fechaPago: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const staffId = (req as any).authContext?.userId ?? null
    const period = req.body.period || currentPeriod()
    res.status(200).json(await runPayroll(req.params.venueId, period, periodicidad(req.body.periodicidad), req.body.fechaPago, { staffId }))
  } catch (error) {
    next(error)
  }
}
