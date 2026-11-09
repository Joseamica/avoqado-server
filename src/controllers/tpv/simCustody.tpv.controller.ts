/**
 * TPV controllers for SIM custody (plan §1.4).
 *
 * Endpoints (mounted under /tpv/sim-custody):
 *   GET  /my-sims   WAITER — list SIMs assigned to the current staff
 *   POST /accept    WAITER — bulk-accept pending SIMs
 *   POST /reject    WAITER — reject ONE pending SIM
 */

import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { simCustodyService } from '../../services/serialized-inventory/custody.service'
import { SimCustodyError } from '../../lib/sim-custody-error-codes'

const AcceptBody = z.object({
  serialNumbers: z.array(z.string().min(1)).min(1, 'Debes incluir al menos un SIM').max(500, 'Máximo 500 SIMs por solicitud'),
})

const RejectBody = z.object({
  serialNumber: z.string().min(1, 'El ICCID es requerido'),
})

function respondSimCustodyError(res: Response, err: unknown): boolean {
  if (err instanceof SimCustodyError) {
    res.status(err.httpStatus).json({ error: err.code, message: err.message })
    return true
  }
  return false
}

function mapZodError(res: Response, err: z.ZodError) {
  res.status(400).json({
    error: 'VALIDATION_ERROR',
    message: err.errors[0]?.message ?? 'Datos inválidos',
    issues: err.errors,
  })
}

export async function listMySims(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, orgId, role } = (req as any).authContext ?? {}
    if (!userId || !orgId) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Autenticación requerida' })
    }
    const items = await simCustodyService.listMySims({ staffId: userId, organizationId: orgId, role })
    res.status(200).json({ items })
  } catch (err) {
    next(err)
  }
}

export async function acceptSims(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, orgId, role } = (req as any).authContext ?? {}
    const parse = AcceptBody.safeParse(req.body)
    if (!parse.success) return mapZodError(res, parse.error)

    const result = await simCustodyService.accept({
      actor: { staffId: userId, organizationId: orgId, role },
      serialNumbers: parse.data.serialNumbers,
      idempotencyRequestId: req.idempotency?.requestId ?? null,
    })
    res.status(200).json(result)
  } catch (err) {
    if (respondSimCustodyError(res, err)) return
    next(err)
  }
}

export async function rejectSim(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, orgId, role } = (req as any).authContext ?? {}
    const parse = RejectBody.safeParse(req.body)
    if (!parse.success) return mapZodError(res, parse.error)

    const result = await simCustodyService.reject({
      actor: { staffId: userId, organizationId: orgId, role },
      serialNumber: parse.data.serialNumber,
    })
    res.status(200).json(result)
  } catch (err) {
    if (respondSimCustodyError(res, err)) return
    next(err)
  }
}
